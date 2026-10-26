// Table view: the exact latest values for every tracker, with where they came from.
// Redrawn a few times a second so a busy feed never stalls the 3D view.
const DIGITS = 4; // 0.1 mm

const fmt = (v) => (Object.is(v, -0) ? 0 : v).toFixed(DIGITS);

function fmtAge(ms) {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)} min`;
}

function cell(tr, text, className) {
  const td = document.createElement('td');
  if (className) td.className = className;
  td.textContent = text;
  if (text) td.title = text; // full value when a narrow column cuts it off
  tr.appendChild(td);
  return td;
}

export function createTable(root, colorOf) {
  const tbody = root.querySelector('tbody');
  const freezeBtn = root.querySelector('#freezeTable');
  const rows = new Map(); // id -> { p, seen, src, from, feed, windowCount, hz }
  let frozen = false;
  let lastDraw = 0;

  freezeBtn.addEventListener('click', () => {
    frozen = !frozen;
    freezeBtn.textContent = frozen ? 'Frozen: click to resume' : 'Freeze';
    freezeBtn.classList.toggle('active', frozen);
  });
  root.querySelector('#clearTable').addEventListener('click', () => {
    rows.clear();
    lastDraw = 0;
  });

  // pos: [{ id, x, y, z, n, src, from, feed }] from one bridge batch. `n` counts the
  // updates the bridge merged into it, so Hz is the real input rate, not the batch rate.
  function add(pos, now) {
    for (const p of pos) {
      const r = rows.get(p.id) ?? { windowCount: 0, hz: 0 };
      r.p = p;
      r.seen = now;
      r.windowCount += p.n ?? 1;
      rows.set(p.id, r);
    }
  }

  setInterval(() => {
    for (const r of rows.values()) {
      r.hz = r.windowCount;
      r.windowCount = 0;
    }
  }, 1000);

  function render(now, config) {
    if (root.hidden || frozen || now - lastDraw < 100) return;
    lastDraw = now;
    const staleMs = config.staleMs ?? 1500;
    tbody.innerHTML = '';
    if (rows.size === 0) {
      tbody.innerHTML = '<tr class="empty"><td colspan="10">No trackers yet</td></tr>';
      return;
    }
    const ids = [...rows.keys()].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    for (const id of ids) {
      const { p, seen, hz } = rows.get(id);
      const age = now - seen;
      const tr = document.createElement('tr');
      if (age > staleMs) tr.className = 'stale';
      cell(tr, '', 'swatch').innerHTML = `<span style="background:${colorOf(id)}"></span>`;
      const name = cell(tr, config.names?.[id] ?? id, 'name');
      if (config.names?.[id]) name.appendChild(Object.assign(document.createElement('small'), { textContent: `#${id}` }));
      cell(tr, (p.src ?? '?').toUpperCase(), `src ${p.src ?? ''}`);
      cell(tr, p.feed ?? '');
      cell(tr, p.from ?? '');
      cell(tr, fmt(p.x), 'num');
      cell(tr, fmt(p.y), 'num');
      cell(tr, fmt(p.z), 'num');
      cell(tr, age > staleMs ? '0' : String(hz), 'num');
      cell(tr, fmtAge(age), 'num age');
      tbody.appendChild(tr);
    }
  }

  return { add, render };
}
