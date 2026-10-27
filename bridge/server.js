// OSC (UDP), PSN (multicast) and FreeD (UDP) -> WebSocket bridge, and static file server for the UI.
import { exec } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebSocketServer } from './ws.js';
import { decode } from './osc.js';
import * as freed from './freed.js';
import * as psn from './psn.js';
import { createMapper } from './mapper.js';
import { INPUTS, parseInputs, parsePlacement, updateBlockText, updateStageText } from './stage-file.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CONFIG || path.join(root, 'config.json');
const publicDir = path.join(root, 'public');

let config = loadConfig();
let mapper = createMapper(config);
let psnNames = {}; // 'psn:<id>' -> name, from Naostage's PSN info packets

function loadConfig() {
  return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// Hot-reload config so mappings / transform can be tuned on site without a restart.
fs.watchFile(configPath, { interval: 500 }, () => {
  try {
    const next = loadConfig();
    mapper = createMapper(next);
    config = next;
    broadcast({ type: 'config', config: clientConfig() });
    console.log('config.json reloaded');
  } catch (err) {
    console.error(`config.json not reloaded: ${err.message}`);
  }
});

function clientConfig() {
  const { stage, names, trailSeconds, staleMs, oscPort } = config;
  const { group, port } = psnSettings();
  return {
    stage, trailSeconds, staleMs, oscPort,
    names: { ...psnNames, ...names },
    inputs: inputsOn(),
    psn: { group, port },
    freed: { port: freedPort() },
  };
}

function psnSettings() {
  const p = config.psn ?? {};
  return { group: p.group ?? '236.10.10.10', port: p.port ?? 56565 };
}

function freedPort() {
  return config.freed?.port ?? 40000;
}

// Which protocols feed the 3D view. Every socket always listens, so the UI can show
// that a protocol is available even while it's switched off.
function inputsOn() {
  const i = config.inputs ?? {};
  return Object.fromEntries(INPUTS.map((kind) => [kind, i[kind] !== false]));
}

const onOff = (inputs) => INPUTS.map((kind) => `${inputNames[kind]} ${inputs[kind] ? 'on' : 'off'}`).join(', ');
const inputNames = { osc: 'OSC', psn: 'PSN', freed: 'FreeD' };

// ---- HTTP (static UI) ----
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function readJson(req, res, handle) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10_000) req.destroy();
  });
  req.on('end', () => {
    try {
      const out = handle(JSON.parse(body));
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(out));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(err.message);
    }
  });
}

// POST /stage { width, depth, position: [x, y], rotation } from the Floor panel -> config.json.
// The file watcher then reloads it and broadcasts the new config to every page.
function saveStage(body) {
  const placement = parsePlacement(body);
  fs.writeFileSync(configPath, updateStageText(fs.readFileSync(configPath, 'utf8'), placement));
  const size = placement.width ? `${placement.width} x ${placement.depth} m, ` : '';
  console.log(`Floor saved: ${size}position [${placement.position}], rotation ${placement.rotation}°`);
  return placement;
}

// POST /inputs { osc, psn, freed } from the input toggles -> config.json. Applied straight away
// rather than waiting for the file watcher, so the switch feels instant.
function saveInputs(body) {
  const inputs = parseInputs(body);
  fs.writeFileSync(configPath, updateBlockText(fs.readFileSync(configPath, 'utf8'), 'inputs', inputs));
  config = { ...config, inputs };
  broadcast({ type: 'config', config: clientConfig() });
  broadcastInputStatus();
  console.log(`Inputs: ${onOff(inputs)}`);
  return inputs;
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/stage' && req.method === 'POST') {
    readJson(req, res, saveStage);
    return;
  }
  if (urlPath === '/inputs' && req.method === 'POST') {
    readJson(req, res, saveInputs);
    return;
  }
  const file = path.join(publicDir, urlPath === '/' ? 'index.html' : urlPath);
  if (!file.startsWith(publicDir + path.sep)) {
    res.writeHead(403).end();
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ---- WebSocket ----
const wss = createWebSocketServer(server, (client) => {
  client.send(JSON.stringify({ type: 'config', config: clientConfig() }));
  client.send(JSON.stringify(inputStatusMessage()));
});

function broadcast(obj) {
  wss.broadcast(JSON.stringify(obj));
}

// Batch everything received within one frame (~16 ms) into a single WS message,
// keeping only the latest position per tracker (with `n`, how many updates it replaced,
// plus where it came from, for the Table view). `feeds` counts position messages
// per mapping (uncapped, unlike `raw`) so the UI can show the feed type and rate.
const MAX_RAW_PER_FLUSH = 200;
let pendingRaw = [];
let pendingPos = new Map();
let pendingFeeds = {};

setInterval(() => {
  if (pendingRaw.length === 0 && pendingPos.size === 0) return;
  broadcast({ type: 'batch', raw: pendingRaw, pos: [...pendingPos.values()], feeds: pendingFeeds });
  pendingRaw = [];
  pendingPos = new Map();
  pendingFeeds = {};
}, 16);

// ---- Input status: is each protocol listening, and what is it receiving? ----
// Counted whether or not the input is switched on, so the UI can say "available".
const inputStats = {
  osc: { listening: false, error: null, count: 0, hz: 0, from: null, last: 0 },
  psn: { listening: false, error: null, count: 0, hz: 0, from: null, last: 0 },
  freed: { listening: false, error: null, count: 0, hz: 0, from: null, last: 0 },
};

function countPacket(kind, from, t) {
  const s = inputStats[kind];
  s.count++;
  s.from = from;
  s.last = t;
}

function inputStatusMessage() {
  const on = inputsOn();
  const status = {};
  for (const [kind, { listening, error, hz, from, last }] of Object.entries(inputStats)) {
    status[kind] = { on: on[kind], listening, error, hz, from, ago: last ? Date.now() - last : null };
  }
  return { type: 'inputs', status };
}

function broadcastInputStatus() {
  broadcast(inputStatusMessage());
}

setInterval(() => {
  for (const s of Object.values(inputStats)) {
    s.hz = s.count;
    s.count = 0;
  }
  broadcastInputStatus();
}, 1000);

// ---- OSC over UDP ----
const udp = dgram.createSocket('udp4');

// OSC, PSN and FreeD all end up here as { address, args } messages. `src` is 'osc', 'psn'
// or 'freed'. PSN and FreeD ids get a 'psn:' / 'freed:' prefix so PSN target 1, FreeD
// camera 1 and OSC tracker 1 stay separate.
function handleMessage(msg, from, t, src) {
  const { matched, positions, feeds } = mapper.map(msg, t);
  for (const f of feeds) pendingFeeds[f] = (pendingFeeds[f] ?? 0) + 1;
  if (pendingRaw.length < MAX_RAW_PER_FLUSH) {
    const args = msg.args.map((a) => (Buffer.isBuffer(a) ? `<blob ${a.length}B>` : a));
    pendingRaw.push({ from, address: msg.address, args, t, matched });
  }
  positions.forEach((p, i) => {
    const id = src === 'osc' ? p.id : `${src}:${p.id}`;
    const n = (pendingPos.get(id)?.n ?? 0) + 1;
    pendingPos.set(id, { ...p, id, t, n, src, from, feed: feeds[i] });
  });
}

udp.on('message', (buf, rinfo) => {
  const t = Date.now();
  countPacket('osc', rinfo.address, t);
  if (!inputsOn().osc) return;
  let messages;
  try {
    messages = decode(buf);
  } catch (err) {
    pendingRaw.push({ from: rinfo.address, address: '(undecodable)', args: [err.message], t, matched: false });
    return;
  }
  for (const msg of messages) handleMessage(msg, rinfo.address, t, 'osc');
});

udp.on('error', (err) => {
  // Keep PSN running even if OSC can't listen; the UI shows the error.
  console.error(`Cannot listen for OSC on UDP ${config.oscPort}: ${err.message}`);
  inputStats.osc.listening = false;
  inputStats.osc.error = err.message;
  udp.close();
});

// ---- PSN (PosiStageNet) over UDP multicast ----
// Each PSN tracker becomes a /psn/{id}/pos message, so it goes through the same
// mappings, transform and monitor as OSC. Positions are passed on as sent: Naostage
// Kratos sends Z-up (matching the stage axes), not the Y-up of the PSN spec.
// Changing the psn group or port needs a restart; switching it on/off doesn't.
const psnConfig = psnSettings();
const psnErrors = new Map(); // interface address -> last join error, so each is logged once
let psnSocket = null;
let psnRejoin = null;

// Join the group on every IPv4 interface. Run every few seconds: an interface that
// (re)connects later, such as the control Wi-Fi, loses or never had the membership.
// Joining twice fails with EADDRINUSE, which just means we're already in.
function joinPsnGroup() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      try {
        psnSocket.addMembership(psnConfig.group, a.address);
        psnErrors.delete(a.address);
        console.log(`PSN: joined ${psnConfig.group} on ${name} ${a.address}`);
      } catch (err) {
        if (err.code === 'EADDRINUSE' || psnErrors.get(a.address) === err.message) continue;
        psnErrors.set(a.address, err.message);
        console.error(`PSN: cannot join ${psnConfig.group} on ${name} ${a.address}: ${err.message}`);
      }
    }
  }
}

function startPsn() {
  psnSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  psnSocket.on('message', (buf, rinfo) => {
    const t = Date.now();
    countPacket('psn', rinfo.address, t);
    if (!inputsOn().psn) return;
    let packet;
    try {
      packet = psn.decode(buf);
    } catch (err) {
      pendingRaw.push({ from: rinfo.address, address: '(undecodable PSN)', args: [err.message], t, matched: false });
      return;
    }
    if (packet.kind === 'data') {
      for (const { id, pos } of packet.trackers) {
        handleMessage({ address: `/psn/${id}/pos`, args: [pos.x, pos.y, pos.z] }, rinfo.address, t, 'psn');
      }
      return;
    }
    let changed = false;
    for (const tr of packet.trackers) {
      if (tr.name && psnNames[`psn:${tr.id}`] !== tr.name) {
        psnNames[`psn:${tr.id}`] = tr.name;
        changed = true;
      }
    }
    if (changed) broadcast({ type: 'config', config: clientConfig() });
  });
  psnSocket.on('error', (err) => {
    // Keep OSC running even if PSN can't listen.
    console.error(`PSN: cannot listen on UDP ${psnConfig.port}: ${err.message}`);
    inputStats.psn.listening = false;
    inputStats.psn.error = err.message;
    clearInterval(psnRejoin);
    psnSocket.close();
  });
  psnSocket.bind(psnConfig.port, '0.0.0.0', () => {
    console.log(`Listening for PSN on ${psnConfig.group}:${psnConfig.port}`);
    inputStats.psn.listening = true;
    joinPsnGroup();
    // Pick up interfaces that connect later, e.g. the control Wi-Fi joining after start-up.
    psnRejoin = setInterval(joinPsnGroup, 5000);
  });
}

// ---- FreeD over UDP ----
// Each FreeD camera becomes a /freed/{id}/pos message (x, y, z in metres, then pan,
// tilt, roll in degrees, zoom and focus), so it goes through the same mappings,
// transform and monitor as OSC. Changing the port needs a restart.
const freedSocket = dgram.createSocket('udp4');

freedSocket.on('message', (buf, rinfo) => {
  const t = Date.now();
  countPacket('freed', rinfo.address, t);
  if (!inputsOn().freed) return;
  let cameras;
  try {
    cameras = freed.decode(buf);
  } catch (err) {
    pendingRaw.push({ from: rinfo.address, address: '(undecodable FreeD)', args: [err.message], t, matched: false });
    return;
  }
  for (const { id, pos, pan, tilt, roll, zoom, focus } of cameras) {
    handleMessage({ address: `/freed/${id}/pos`, args: [pos.x, pos.y, pos.z, pan, tilt, roll, zoom, focus] }, rinfo.address, t, 'freed');
  }
});

freedSocket.on('error', (err) => {
  // Keep OSC and PSN running even if FreeD can't listen.
  console.error(`FreeD: cannot listen on UDP ${freedPort()}: ${err.message}`);
  inputStats.freed.listening = false;
  inputStats.freed.error = err.message;
  freedSocket.close();
});

// The menu bar app starts the bridge with a pipe on stdin: when the app quits or
// crashes the pipe closes, and the bridge goes with it instead of lingering.
if (process.env.EXIT_WITH_STDIN) {
  process.stdin.on('end', () => process.exit(0));
  process.stdin.resume();
}

// `--open` (used by the double-click launchers) opens the UI in the default browser.
const uiUrl = `http://localhost:${config.httpPort}`;
function openBrowser() {
  const cmd =
    process.platform === 'win32' ? `start "" "${uiUrl}"`
    : process.platform === 'darwin' ? `open "${uiUrl}"`
    : `xdg-open "${uiUrl}"`;
  exec(cmd, (err) => err && console.log(`Open ${uiUrl} in your browser`));
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    // Most likely the visualiser is already running: just show it.
    console.log(`Port ${config.httpPort} is already in use - the visualiser is probably already running.`);
    if (process.argv.includes('--open')) openBrowser();
    setTimeout(() => process.exit(0), 1500);
    return;
  }
  console.error(`Web server error: ${err.message}`);
  process.exit(1);
});

server.listen(config.httpPort, () => {
  udp.bind(config.oscPort, '0.0.0.0', () => {
    console.log(`Listening for OSC on UDP 0.0.0.0:${config.oscPort}`);
    inputStats.osc.listening = true;
  });
  startPsn();
  const port = freedPort();
  freedSocket.bind(port, '0.0.0.0', () => {
    console.log(`Listening for FreeD on UDP 0.0.0.0:${port}`);
    inputStats.freed.listening = true;
  });
  console.log(`Inputs: ${onOff(inputsOn())} (switch them in the UI)`);
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`UI: ${uiUrl}`);
  for (const ip of ips) console.log(`    http://${ip}:${config.httpPort}  (point Naostage OSC output at ${ip}:${config.oscPort})`);
  console.log('Keep this window open while using the visualiser. Close it to stop.');
  if (process.argv.includes('--open')) openBrowser();
});
