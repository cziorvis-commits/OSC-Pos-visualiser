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

// ---- Move floor: line the virtual floor up with the real one, then save to config.json ----
const floorPanel = $('floorPanel');
const round = (v, step) => Math.round(v / step) * step;
const samePlacement = (a, b) =>
  Math.abs(a.position[0] - b.position[0]) < 5e-4 && Math.abs(a.position[1] - b.position[1]) < 5e-4 &&
  Math.abs(a.rotation - b.rotation) < 0.05;

function savedPlacement() {
  return { position: config.stage?.position ?? [0, 0], rotation: config.stage?.rotation ?? 0 };
}

function setFloorState(text, cls = '') {
  $('floorState').textContent = text;
  $('floorState').className = cls;
}

function showPlacement(p) {
  for (const [id, v, digits] of [['floorX', p.position[0], 3], ['floorY', p.position[1], 3], ['floorRot', p.rotation, 1]]) {
    if (document.activeElement !== $(id)) $(id).value = v.toFixed(digits);
  }
  const dirty = !samePlacement(p, savedPlacement());
  setFloorState(dirty ? 'Unsaved changes' : 'Saved', dirty ? 'dirty' : '');
  $('floorSave').disabled = !dirty;
  $('floorRevert').disabled = !dirty;
}
view.onPlacement(showPlacement);

$('toggleFloor').addEventListener('click', (e) => {
  floorPanel.hidden = !floorPanel.hidden;
  view.setEditing(!floorPanel.hidden);
  e.target.classList.toggle('active', !floorPanel.hidden);
  showPlacement(view.getPlacement());
});

function nudge(dx, dy, drot) {
  const p = view.getPlacement();
  view.setPlacement({
    position: [round(p.position[0] + dx, 0.001), round(p.position[1] + dy, 0.001)],
    rotation: round(p.rotation + drot, 0.1),
  });
}

for (const id of ['floorX', 'floorY', 'floorRot']) {
  $(id).addEventListener('input', () => {
    const x = parseFloat($('floorX').value);
    const y = parseFloat($('floorY').value);
    const rot = parseFloat($('floorRot').value);
    if ([x, y, rot].every(Number.isFinite)) view.setPlacement({ position: [x, y], rotation: rot });
  });
}

window.addEventListener('keydown', (e) => {
  if (floorPanel.hidden || e.target.tagName === 'INPUT') return;
  const step = e.shiftKey ? 0.1 : 0.01;
  const turn = e.shiftKey ? 15 : 1;
  const moves = {
    ArrowLeft: [-step, 0, 0], ArrowRight: [step, 0, 0], ArrowUp: [0, step, 0], ArrowDown: [0, -step, 0],
    BracketLeft: [0, 0, turn], BracketRight: [0, 0, -turn],
  };
  const m = moves[e.code];
  if (!m) return;
  e.preventDefault();
  nudge(...m);
});

$('floorRevert').addEventListener('click', () => view.setPlacement(savedPlacement()));

$('floorSave').addEventListener('click', async () => {
  const p = view.getPlacement();
  const body = { position: [round(p.position[0], 0.001), round(p.position[1], 0.001)], rotation: round(p.rotation, 0.1) };
  setFloorState('Saving…');
  try {
    const res = await fetch('stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    // The bridge rewrites config.json and broadcasts the new config, which marks this saved.
    config = { ...config, stage: { ...config.stage, ...body } };
    showPlacement(view.getPlacement());
  } catch (err) {
    setFloorState(`Not saved: ${err.message}`, 'error');
  }
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
      // Only a size/origin change moves the camera; a new floor placement keeps the view.
      const shape = (s = {}) => JSON.stringify([s.width, s.depth, s.height, s.origin]);
      const shapeChanged = shape(msg.config.stage) !== shape(config.stage);
      const stageChanged = JSON.stringify(msg.config.stage) !== JSON.stringify(config.stage);
      const draft = view.getPlacement();
      const keepDraft = !floorPanel.hidden && !samePlacement(draft, savedPlacement());
      config = msg.config;
      if (stageChanged) {
        view.setStage(config.stage);
        if (keepDraft) view.setPlacement(draft);
        if (shapeChanged) view.resetView();
      }
      if (!floorPanel.hidden) showPlacement(view.getPlacement());
      $('floorSize').textContent = `${config.stage?.width ?? '?'} × ${config.stage?.depth ?? '?'} m`;
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
