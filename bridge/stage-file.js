// Saves the floor size and placement, and the input selection, from the UI into config.json.
// Only the block being saved is rewritten, so the rest of the file keeps its hand formatting.

// Checks a { width?, depth?, position: [x, y], rotation } body and rounds it to mm / 0.1°.
export function parsePlacement(body) {
  const { width, depth, position, rotation } = body ?? {};
  if (!Array.isArray(position) || position.length !== 2 || !position.every(Number.isFinite)) {
    throw new Error('position must be [x, y] in metres');
  }
  if (!Number.isFinite(rotation)) throw new Error('rotation must be a number of degrees');
  const mm = (v) => Math.round(v * 1000) / 1000 || 0; // `|| 0` turns -0 into 0
  const out = {};
  for (const [key, v] of [['width', width], ['depth', depth]]) {
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < 0.1 || v > 200) throw new Error(`${key} must be between 0.1 and 200 metres`);
    out[key] = mm(v);
  }
  return { ...out, position: position.map(mm), rotation: Math.round(rotation * 10) / 10 || 0 };
}

export const INPUTS = ['osc', 'psn', 'freed'];

// Checks an { osc, psn, freed } body of booleans; at least one input has to stay on.
export function parseInputs(body) {
  const out = {};
  for (const kind of INPUTS) {
    if (typeof body?.[kind] !== 'boolean') throw new Error(`${INPUTS.join(', ')} must each be true or false`);
    out[kind] = body[kind];
  }
  if (!Object.values(out).some(Boolean)) throw new Error('keep at least one input on');
  return out;
}

function formatBlock(key, obj) {
  const value = (v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  const lines = Object.entries(obj).map(([k, v]) => `    ${JSON.stringify(k)}: ${value(v)}`);
  return `${JSON.stringify(key)}: {\n${lines.join(',\n')}\n  }`;
}

// Returns the new config.json text with `patch` merged into its top-level `key` block
// (a flat object such as "stage" or "inputs").
export function updateBlockText(text, key, patch) {
  const config = JSON.parse(text);
  const merged = { ...config[key], ...patch };
  const block = new RegExp(`"${key}"\\s*:\\s*\\{[^{}]*\\}`);
  if (block.test(text)) {
    const next = text.replace(block, formatBlock(key, merged));
    JSON.parse(next); // never write a file the bridge can't read back
    return next;
  }
  return `${JSON.stringify({ ...config, [key]: merged }, null, 2)}\n`;
}

export const updateStageText = (text, patch) => updateBlockText(text, 'stage', patch);
