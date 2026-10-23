// Saves the floor size and placement from the UI into config.json.
// Only the "stage" block is rewritten, so the rest of the file keeps its hand formatting.

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

function formatStage(stage) {
  const value = (v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  const lines = Object.entries(stage).map(([k, v]) => `    ${JSON.stringify(k)}: ${value(v)}`);
  return `"stage": {\n${lines.join(',\n')}\n  }`;
}

// Returns the new config.json text with `patch` merged into its "stage" block.
export function updateStageText(text, patch) {
  const config = JSON.parse(text);
  const stage = { ...config.stage, ...patch };
  const block = /"stage"\s*:\s*\{[^{}]*\}/;
  if (block.test(text)) {
    const next = text.replace(block, formatStage(stage));
    JSON.parse(next); // never write a file the bridge can't read back
    return next;
  }
  return `${JSON.stringify({ ...config, stage }, null, 2)}\n`;
}
