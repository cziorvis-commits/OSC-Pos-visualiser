// Raw OSC monitor: senders, per-address rate and a scrolling log.
// Rendered at a few Hz so a busy feed never stalls the 3D view.
const MAX_LOG_LINES = 300;

function fmtArgs(args) {
  return args.map((a) => (typeof a === 'number' && !Number.isInteger(a) ? a.toFixed(3) : String(a))).join(' ');
}

export function createMonitor(root) {
  const logEl = root.querySelector('#log');
  const sendersEl = root.querySelector('#senders');
  const tbody = root.querySelector('#addresses tbody');
  const pauseBtn = root.querySelector('#pauseLog');

  const senders = new Map(); // ip -> count
  const addresses = new Map(); // address -> { count, windowCount, hz, args, matched }
  let lines = [];
  let paused = false;
  let dirty = false;

  pauseBtn.addEventListener('click', () => {
    paused = !paused;
    pauseBtn.textContent = paused ? 'Resume' : 'Pause';
  });
  root.querySelector('#clearLog').addEventListener('click', () => {
    lines = [];
    addresses.clear();
    senders.clear();
    dirty = true;
  });

  function add(raw) {
    for (const m of raw) {
      senders.set(m.from, (senders.get(m.from) || 0) + 1);
      const a = addresses.get(m.address) || { count: 0, windowCount: 0, hz: 0 };
      a.count++;
      a.windowCount++;
      a.args = m.args;
      a.matched = m.matched;
      addresses.set(m.address, a);
      if (!paused) {
        const time = new Date(m.t).toISOString().slice(11, 23);
        lines.push(`${time}  ${m.from}  ${m.address}  ${fmtArgs(m.args)}`);
      }
    }
    if (lines.length > MAX_LOG_LINES) lines = lines.slice(-MAX_LOG_LINES);
    dirty = true;
  }

  // Rates are computed over 1 s windows.
  setInterval(() => {
    for (const a of addresses.values()) {
      a.hz = a.windowCount;
      a.windowCount = 0;
    }
    dirty = true;
  }, 1000);

  setInterval(() => {
    if (!dirty || root.hidden) return;
    dirty = false;

    sendersEl.innerHTML = '';
    for (const [ip, n] of senders) {
      const li = document.createElement('li');
      li.textContent = `${ip}  (${n} msgs)`;
      sendersEl.appendChild(li);
    }
    if (senders.size === 0) sendersEl.innerHTML = '<li>nothing received yet</li>';

    tbody.innerHTML = '';
    for (const [addr, a] of [...addresses].sort((x, y) => x[0].localeCompare(y[0]))) {
      const tr = document.createElement('tr');
      if (!a.matched) tr.className = 'unmapped';
      for (const text of [addr, a.hz, fmtArgs(a.args)]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }

    if (!paused) {
      const atBottom = logEl.scrollTop + logEl.clientHeight >= logEl.scrollHeight - 4;
      logEl.textContent = lines.join('\n');
      if (atBottom) logEl.scrollTop = logEl.scrollHeight;
    }
  }, 200);

  return { add };
}
