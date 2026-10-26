import { createScene } from './scene.js';
import { createMonitor } from './monitor.js';
import { createTable } from './table.js';

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

const tableEl = $('table');
const table = createTable(tableEl, (id) => view.colorOf(id));
$('toggleTable').addEventListener('click', (e) => {
  tableEl.hidden = !tableEl.hidden;
  e.target.classList.toggle('active', !tableEl.hidden);
});

$('toggleMonitor').addEventListener('click', () => {
  monitorEl.hidden = !monitorEl.hidden;
});

// ---- Floor: set its size and line it up with the real one, then save to config.json ----
const floorPanel = $('floorPanel');
const round = (v, step) => Math.round(v / step) * step;
const sameFloor = (a, b) =>
  Math.abs(a.width - b.width) < 5e-4 && Math.abs(a.depth - b.depth) < 5e-4 &&
  Math.abs(a.position[0] - b.position[0]) < 5e-4 && Math.abs(a.position[1] - b.position[1]) < 5e-4 &&
  Math.abs(a.rotation - b.rotation) < 0.05;

function savedFloor() {
  const s = config.stage ?? {};
  return { width: s.width ?? 3.66, depth: s.depth ?? 3.66, position: s.position ?? [0, 0], rotation: s.rotation ?? 0 };
}

function setFloorState(text, cls = '') {
  $('floorState').textContent = text;
  $('floorState').className = cls;
}

function showFloor(f) {
  const fields = [
    ['floorW', f.width, 2], ['floorD', f.depth, 2],
    ['floorX', f.position[0], 3], ['floorY', f.position[1], 3], ['floorRot', f.rotation, 1],
  ];
  for (const [id, v, digits] of fields) {
    if (document.activeElement !== $(id)) $(id).value = v.toFixed(digits);
  }
  const dirty = !sameFloor(f, savedFloor());
  setFloorState(dirty ? 'Unsaved changes' : 'Saved', dirty ? 'dirty' : '');
  $('floorSave').disabled = !dirty;
  $('floorRevert').disabled = !dirty;
}
view.onPlacement(showFloor);

$('toggleFloor').addEventListener('click', (e) => {
  floorPanel.hidden = !floorPanel.hidden;
  view.setEditing(!floorPanel.hidden);
  e.target.classList.toggle('active', !floorPanel.hidden);
  showFloor(view.getFloor());
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

for (const id of ['floorW', 'floorD']) {
  $(id).addEventListener('input', () => {
    const w = parseFloat($('floorW').value);
    const d = parseFloat($('floorD').value);
    if (w >= 0.1 && d >= 0.1) view.setSize(w, d);
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

$('floorRevert').addEventListener('click', () => {
  view.setStage(config.stage);
  showFloor(view.getFloor());
});

$('floorSave').addEventListener('click', async () => {
  const f = view.getFloor();
  const body = {
    width: round(f.width, 0.001), depth: round(f.depth, 0.001),
    position: [round(f.position[0], 0.001), round(f.position[1], 0.001)], rotation: round(f.rotation, 0.1),
  };
  setFloorState('Saving…');
  try {
    const res = await fetch('stage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(await res.text());
    // The bridge rewrites config.json and broadcasts the new config, which marks this saved.
    config = { ...config, stage: { ...config.stage, ...body } };
    showFloor(view.getFloor());
  } catch (err) {
    setFloorState(`Not saved: ${err.message}`, 'error');
  }
});

// ---- Inputs: switch OSC / PSN on and off, and show what each is receiving ----
let inputStatus = {};
const inputError = {}; // kind -> why the last switch failed, until the next one
const inputLabels = {
  osc: () => ({ name: 'OSC', where: `:${config.oscPort ?? '?'}` }),
  psn: () => ({ name: 'PSN', where: config.psn ? `${config.psn.group}:${config.psn.port}` : '' }),
};

function showInputs() {
  for (const kind of ['osc', 'psn']) {
    const el = $(`input-${kind}`);
    const s = inputStatus[kind];
    const on = config.inputs?.[kind] ?? true;
    const { name, where } = inputLabels[kind]();
    const receiving = s && s.ago != null && s.ago < 2000;
    let state, detail, tip;
    if (s?.error) {
      [state, detail, tip] = ['error', 'error', `Cannot listen on ${where}: ${s.error}`];
    } else if (!on) {
      state = 'off';
      detail = receiving ? `off · ${s.hz} Hz available` : 'off';
      tip = receiving ? `${name} is arriving from ${s.from} but is switched off. Click to use it.` : `${name} is switched off. Click to use it.`;
    } else if (receiving) {
      [state, detail, tip] = ['live', `${s.hz} Hz`, `Receiving ${name} on ${where} from ${s.from}. Click to switch off.`];
    } else {
      state = 'waiting';
      detail = s?.listening === false ? 'starting' : 'no data';
      tip = `Listening for ${name} on ${where}, nothing received${s?.from ? ` (last from ${s.from})` : ''}. Click to switch off.`;
    }
    const other = config.inputs?.[kind === 'osc' ? 'psn' : 'osc'] ?? true;
    if (on && !other) tip += ' (Switch the other input on first: at least one stays on.)';
    if (inputError[kind]) tip = inputError[kind];
    el.className = `input ${state}`;
    el.setAttribute('aria-pressed', String(on));
    el.disabled = on && !other;
    el.title = tip;
    el.innerHTML = `<b>${name}</b> <small>${where} · ${detail}</small>`;
  }
}

for (const kind of ['osc', 'psn']) {
  $(`input-${kind}`).addEventListener('click', async () => {
    const next = { osc: config.inputs?.osc ?? true, psn: config.inputs?.psn ?? true };
    next[kind] = !next[kind];
    delete inputError[kind];
    try {
      const res = await fetch('inputs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
      if (!res.ok) throw new Error(await res.text());
      config = { ...config, inputs: next }; // the bridge also broadcasts it to every page
      showInputs();
    } catch (err) {
      inputError[kind] = `Not switched: ${err.message}`;
      showInputs();
    }
  });
}

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
    inputStatus = {};
    showInputs();
    setTimeout(connect, 1000);
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'config') {
      // Only a size/origin change moves the camera; a new floor placement keeps the view.
      const shape = (s = {}) => JSON.stringify([s.width, s.depth, s.height, s.origin]);
      const shapeChanged = shape(msg.config.stage) !== shape(config.stage);
      const stageChanged = JSON.stringify(msg.config.stage) !== JSON.stringify(config.stage);
      const draft = view.getFloor();
      const keepDraft = !floorPanel.hidden && !sameFloor(draft, savedFloor());
      config = msg.config;
      if (stageChanged) {
        view.setStage(keepDraft ? { ...config.stage, ...draft } : config.stage);
        if (shapeChanged && !keepDraft) view.resetView();
      }
      if (!floorPanel.hidden) showFloor(view.getFloor());
      view.relabel(config.names);
      showInputs();
    } else if (msg.type === 'inputs') {
      inputStatus = msg.status;
      showInputs();
    } else if (msg.type === 'batch') {
      const now = performance.now();
      for (const p of msg.pos) view.updateTracker(p.id, p, config.names?.[p.id], now);
      table.add(msg.pos, now);
      for (const [f, n] of Object.entries(msg.feeds ?? {})) {
        const e = feeds.get(f) ?? { count: 0, hz: 0, last: 0 };
        e.count += n;
        e.last = now;
        feeds.set(f, e);
      }
      if (msg.raw.length) monitor.add(msg.raw);
    }
  };
}
connect();

// Which mappings are feeding positions right now (e.g. "/pos/xy 25 Hz"), for the summary bar.
const feeds = new Map(); // mapping address -> { count, hz, last }
setInterval(() => {
  for (const e of feeds.values()) {
    e.hz = e.count;
    e.count = 0;
  }
}, 1000);

function feedText(now) {
  const active = [...feeds].filter(([, e]) => now - e.last <= (config.staleMs ?? 1500));
  if (!active.length) return 'Feed: none';
  return `Feed: ${active.map(([f, e]) => (e.hz ? `${f} ${e.hz} Hz` : f)).join(', ')}`;
}

function frame() {
  const now = performance.now();
  const { total, live } = view.render(now, config);
  table.render(now, config);
  $('summary').textContent = `${live} live / ${total} trackers · ${feedText(now)}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
