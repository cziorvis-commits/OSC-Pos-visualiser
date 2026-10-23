// Sends fake tracking OSC so the visualiser can be tested without Naostage.
// Usage: npm run sim -- [host] [port] [trackers] [rateHz]
import dgram from 'node:dgram';
import { encodeBundle, encodeMessage } from './osc.js';

const [host = '127.0.0.1', port = '9111', count = '5', rate = '50'] = process.argv.slice(2);
const n = Number(count);
const sock = dgram.createSocket('udp4');
const start = Date.now();

console.log(`Simulating ${n} trackers at ${rate} Hz -> ${host}:${port} (Ctrl+C to stop)`);

setInterval(() => {
  const t = (Date.now() - start) / 1000;
  const msgs = [];
  for (let i = 1; i <= n; i++) {
    // Each performer wanders a different Lissajous path across a 14 x 10 m stage.
    const x = 5 * Math.sin(t * 0.3 * (1 + i * 0.15) + i);
    const y = 4 + 3.5 * Math.sin(t * 0.21 * (1 + i * 0.1) + i * 2);
    const z = i === n ? 1.5 + Math.sin(t * 0.8) : 0; // last one "flies"
    msgs.push(encodeMessage(`/tracker/${i}/pos`, [x, y, z]));
  }
  sock.send(encodeBundle(msgs), Number(port), host);
}, 1000 / Number(rate));
