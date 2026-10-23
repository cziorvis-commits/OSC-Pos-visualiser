// OSC (UDP) -> WebSocket bridge, and static file server for the UI.
import dgram from 'node:dgram';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { decode } from './osc.js';
import { createMapper } from './mapper.js';

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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
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
const wss = new WebSocketServer({ server });

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'config', config: clientConfig() }));
});

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
const udp = dgram.createSocket({ type: 'udp4', reuseAddr: true });

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
    const { matched, positions } = mapper.map(msg);
    if (pendingRaw.length < MAX_RAW_PER_FLUSH) {
      const args = msg.args.map((a) => (Buffer.isBuffer(a) ? `<blob ${a.length}B>` : a));
      pendingRaw.push({ from: rinfo.address, address: msg.address, args, t, matched });
    }
    for (const p of positions) pendingPos.set(p.id, { ...p, t });
  }
});

udp.on('error', (err) => {
  console.error(`UDP error: ${err.message}`);
  process.exit(1);
});

udp.bind(config.oscPort, '0.0.0.0', () => {
  console.log(`Listening for OSC on UDP 0.0.0.0:${config.oscPort}`);
});

server.listen(config.httpPort, () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log(`UI: http://localhost:${config.httpPort}`);
  for (const ip of ips) console.log(`    http://${ip}:${config.httpPort}  (point Naostage OSC output at ${ip}:${config.oscPort})`);
});
