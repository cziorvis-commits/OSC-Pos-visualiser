// Sends fake tracking OSC (or PSN with --psn, FreeD with --freed) so the visualiser can be tested without Naostage.
// Usage: npm run sim -- [host] [port] [trackers] [rateHz]
//        npm run sim -- --psn [group] [port] [trackers] [rateHz]
//        npm run sim -- --freed [host] [port] [trackers] [rateHz]
import dgram from 'node:dgram';
import * as freed from './freed.js';
import { encodeBundle, encodeMessage } from './osc.js';
import { encodeData, encodeInfo } from './psn.js';

const args = process.argv.slice(2);
const protocol = { '--psn': 'PSN', '--freed': 'FreeD' }[args[0]] ?? 'OSC';
if (protocol !== 'OSC') args.shift();
const usePsn = protocol === 'PSN';
const defaults = { OSC: ['127.0.0.1', '9111'], PSN: ['236.10.10.10', '56565'], FreeD: ['127.0.0.1', '40000'] }[protocol];
const [host = defaults[0], port = defaults[1], count = '5', rate = '50'] = args;
const n = Number(count);
const sock = dgram.createSocket('udp4');
const start = Date.now();
let frame = 0;

console.log(`Simulating ${n} trackers at ${rate} Hz as ${protocol} -> ${host}:${port} (Ctrl+C to stop)`);

// Each performer wanders a different Lissajous path across a 14 x 10 m stage.
function positions(t) {
  const out = [];
  for (let i = 1; i <= n; i++) {
    const x = 5 * Math.sin(t * 0.3 * (1 + i * 0.15) + i);
    const y = 4 + 3.5 * Math.sin(t * 0.21 * (1 + i * 0.1) + i * 2);
    const z = i === n ? 1.5 + Math.sin(t * 0.8) : 0; // last one "flies"
    out.push({ id: i, x, y, z });
  }
  return out;
}

setInterval(() => {
  const ps = positions((Date.now() - start) / 1000);
  if (protocol === 'FreeD') {
    // One D1 message per camera, panning to face the stage centre.
    const packet = Buffer.concat(ps.map(({ id, x, y, z }) => freed.encode({ id, pos: { x, y, z }, pan: (Math.atan2(-x, 4 - y) * 180) / Math.PI })));
    sock.send(packet, Number(port), host);
  } else if (usePsn) {
    sock.send(encodeData(ps.map(({ id, x, y, z }) => ({ id, pos: { x, y, z } })), frame++), Number(port), host);
  } else {
    sock.send(encodeBundle(ps.map((p) => encodeMessage(`/tracker/${p.id}/pos`, [p.x, p.y, p.z]))), Number(port), host);
  }
}, 1000 / Number(rate));

if (usePsn) {
  const names = Array.from({ length: n }, (_, i) => ({ id: i + 1, name: `PSN ${i + 1}` }));
  setInterval(() => sock.send(encodeInfo('Simulator', names, frame), Number(port), host), 1000);
}
