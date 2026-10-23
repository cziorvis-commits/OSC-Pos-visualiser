import { createScene } from './scene.js';
import { createMonitor } from './monitor.js';

const $ = (id) => document.getElementById(id);

const view = createScene($('view'));
const monitorEl = $('monitor');
const monitor = createMonitor(monitorEl);
let config = {};

$('resetView').addEventListener('click', () => view.resetView());
$('topView').addEventListener('click', () => view.topView());

let trailsOn = true;
$('toggleTrails').addEventListener('click', (e) => {
  trailsOn = !trailsOn;
  view.setTrails(trailsOn);
  e.target.textContent = `Trails: ${trailsOn ? 'on' : 'off'}`;
});

$('toggleMonitor').addEventListener('click', () => {
  monitorEl.hidden = !monitorEl.hidden;
});

function setConn(ok, text) {
  const el = $('conn');
  el.className = `pill ${ok ? 'good' : 'bad'}`;
  el.textContent = text;
}

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws.onopen = () => setConn(true, 'bridge connected');
  ws.onclose = () => {
    setConn(false, 'bridge disconnected – retrying');
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'config') {
      const stageChanged = JSON.stringify(msg.config.stage) !== JSON.stringify(config.stage);
      config = msg.config;
      if (stageChanged) {
        view.setStage(config.stage);
        view.resetView();
      }
      view.relabel(config.names);
    } else if (msg.type === 'batch') {
      const now = performance.now();
      for (const p of msg.pos) view.updateTracker(p.id, p, config.names?.[p.id], now);
      if (msg.raw.length) monitor.add(msg.raw);
    }
  };
}
connect();

function frame() {
  const { total, live } = view.render(performance.now(), config);
  $('summary').textContent = `${live} live / ${total} trackers · OSC port ${config.oscPort ?? '?'}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
