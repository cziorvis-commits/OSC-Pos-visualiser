// OSC (UDP) -> WebSocket bridge, and static file server for the UI.
import { exec } from 'node:child_process';
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWebSocketServer } from './ws.js';
import { decode } from './osc.js';
import { createMapper } from './mapper.js';
import { parsePlacement, updateStageText } from './stage-file.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.CONFIG || path.join(root, 'config.json');
const publicDir = path.join(root, 'public');

let config = loadConfig();
let mapper = createMapper(config);

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
  return { stage, names, trailSeconds, staleMs, oscPort };
}

// ---- HTTP (static UI) ----
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

// POST /stage { position: [x, y], rotation } from "Move floor" -> config.json.
// The file watcher then reloads it and broadcasts the new config to every page.
function saveStage(req, res) {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 10_000) req.destroy();
  });
  req.on('end', () => {
    try {
      const placement = parsePlacement(JSON.parse(body));
      fs.writeFileSync(configPath, updateStageText(fs.readFileSync(configPath, 'utf8'), placement));
      console.log(`Floor saved: position [${placement.position}], rotation ${placement.rotation}°`);
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(placement));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(err.message);
    }
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (urlPath === '/stage' && req.method === 'POST') {
    saveStage(req, res);
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
});

function broadcast(obj) {
  wss.broadcast(JSON.stringify(obj));
}

// Batch everything received within one frame (~16 ms) into a single WS message,
// keeping only the latest position per tracker.
const MAX_RAW_PER_FLUSH = 200;
let pendingRaw = [];
let pendingPos = new Map();

setInterval(() => {
  if (pendingRaw.length === 0 && pendingPos.size === 0) return;
  broadcast({ type: 'batch', raw: pendingRaw, pos: [...pendingPos.values()] });
  pendingRaw = [];
  pendingPos = new Map();
}, 16);

// ---- OSC over UDP ----
const udp = dgram.createSocket('udp4');

udp.on('message', (buf, rinfo) => {
  const t = Date.now();
  let messages;
  try {
    messages = decode(buf);
  } catch (err) {
    pendingRaw.push({ from: rinfo.address, address: '(undecodable)', args: [err.message], t, matched: false });
    return;
  }
  for (const msg of messages) {
    const { matched, positions } = mapper.map(msg, t);
    if (pendingRaw.length < MAX_RAW_PER_FLUSH) {
      const args = msg.args.map((a) => (Buffer.isBuffer(a) ? `<blob ${a.length}B>` : a));
      pendingRaw.push({ from: rinfo.address, address: msg.address, args, t, matched });
    }
    for (const p of positions) pendingPos.set(p.id, { ...p, t });
  }
});

udp.on('error', (err) => {
  console.error(`Cannot listen for OSC on UDP ${config.oscPort}: ${err.message}`);
  process.exit(1);
});

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
  });
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`UI: ${uiUrl}`);
  for (const ip of ips) console.log(`    http://${ip}:${config.httpPort}  (point Naostage OSC output at ${ip}:${config.oscPort})`);
  console.log('Keep this window open while using the visualiser. Close it to stop.');
  if (process.argv.includes('--open')) openBrowser();
});
