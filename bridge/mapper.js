// Turns OSC messages into tracker positions using the `mappings` and
// `transform` sections of config.json.
//
// A mapping is { "address": "/tracker/{id}/pos", "args": ["x", "y", "z"] }.
//   - `{id}` captures one address segment as the tracker id, `*` matches any one segment.
//   - `args` names each OSC argument by position: "id", "x", "y", "z", or null to skip.
// Partial updates (e.g. /1/x then /1/y) are merged per tracker. An axis that hasn't
// been updated for `staleMs` drops back to 0, so switching a sender from xyz to xy
// doesn't leave z frozen at its last value.

function compile(pattern) {
  const re = pattern
    .split('/')
    .map((seg) => {
      if (seg === '{id}') return '(?<id>[^/]+)';
      if (seg === '*') return '[^/]+';
      return seg.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return new RegExp(`^${re}$`);
}

// "x", "-y", "+z" -> function picking that component from a raw {x,y,z}
function axisPicker(expr) {
  const m = /^([+-]?)([xyz])$/.exec(String(expr).trim());
  if (!m) throw new Error(`Bad transform axis "${expr}" (use x, -y, +z ...)`);
  const sign = m[1] === '-' ? -1 : 1;
  const key = m[2];
  return (p) => sign * p[key];
}

export function createMapper(config) {
  const mappings = (config.mappings || []).map((m) => ({
    ...m,
    re: compile(m.address),
  }));
  const t = config.transform || {};
  const pick = {
    x: axisPicker(t.x ?? 'x'),
    y: axisPicker(t.y ?? 'y'),
    z: axisPicker(t.z ?? 'z'),
  };
  const scale = t.scale ?? 1;
  const [ox, oy, oz] = t.offset ?? [0, 0, 0];
  const staleMs = config.staleMs ?? 1500;
  const raw = new Map(); // id -> { x: { v, t }, y: ..., z: ... } as last received

  // Returns { matched, positions: [{ id, x, y, z }], feeds: [mapping address, ...] } in
  // stage coordinates (x = across stage, y = depth / upstage, z = height), metres.
  // `feeds` lists the mappings that produced a position, for the summary bar.
  function map(msg, now = Date.now()) {
    const positions = [];
    const feeds = [];
    let matched = false;
    for (const m of mappings) {
      const hit = m.re.exec(msg.address);
      if (!hit) continue;
      matched = true;
      const update = {};
      let id = hit.groups?.id ?? m.id;
      (m.args || []).forEach((name, i) => {
        if (name == null || i >= msg.args.length) return;
        if (name === 'id') id = msg.args[i];
        else if (typeof msg.args[i] === 'number') update[name] = msg.args[i];
      });
      if (id == null || Object.keys(update).length === 0) continue;
      id = String(id);
      const axes = raw.get(id) ?? {};
      for (const [k, v] of Object.entries(update)) axes[k] = { v, t: now };
      raw.set(id, axes);
      const p = {};
      for (const k of ['x', 'y', 'z']) p[k] = axes[k] && now - axes[k].t <= staleMs ? axes[k].v : 0;
      feeds.push(m.address);
      positions.push({
        id,
        x: pick.x(p) * scale + ox,
        y: pick.y(p) * scale + oy,
        z: pick.z(p) * scale + oz,
      });
    }
    return { matched, positions, feeds };
  }

  return { map };
}
