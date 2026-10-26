import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputs, parsePlacement, updateBlockText, updateStageText } from '../bridge/stage-file.js';

const CONFIG = `{
  "oscPort": 9111,

  "stage": {
    "width": 3.66,
    "depth": 3.66,
    "origin": "downstage-centre"
  },

  "mappings": [
    { "address": "/pos/xyz", "id": "xyz", "args": ["x", "y", "z"] }
  ]
}
`;

test('rewrites only the stage block, keeping the rest of the file as written', () => {
  const next = updateStageText(CONFIG, { position: [0.5, -1.25], rotation: 12.5 });
  assert.deepEqual(JSON.parse(next).stage, {
    width: 3.66, depth: 3.66, origin: 'downstage-centre', position: [0.5, -1.25], rotation: 12.5,
  });
  assert.ok(next.includes('{ "address": "/pos/xyz", "id": "xyz", "args": ["x", "y", "z"] }'));
  assert.ok(next.includes('"position": [0.5, -1.25]'));
  assert.ok(next.startsWith('{\n  "oscPort": 9111,\n\n  "stage": {\n'));
});

test('updates an existing placement in place', () => {
  const once = updateStageText(CONFIG, { position: [1, 1], rotation: 0 });
  const twice = updateStageText(once, { position: [2, 3], rotation: -90 });
  assert.deepEqual(JSON.parse(twice).stage.position, [2, 3]);
  assert.equal(JSON.parse(twice).stage.rotation, -90);
  assert.equal(twice.match(/"position"/g).length, 1);
});

test('rounds placements to mm and 0.1 degrees, and rejects bad input', () => {
  assert.deepEqual(parsePlacement({ position: [1.23456, -0.0004], rotation: 10.04 }), { position: [1.235, 0], rotation: 10 });
  assert.throws(() => parsePlacement({ position: [1], rotation: 0 }));
  assert.throws(() => parsePlacement({ position: [1, 'a'], rotation: 0 }));
  assert.throws(() => parsePlacement({ position: [1, 2] }));
  assert.throws(() => parsePlacement(null));
});

test('accepts an optional floor size and rejects silly ones', () => {
  assert.deepEqual(parsePlacement({ width: 4.8765, depth: 3.66, position: [0, 0], rotation: 0 }), {
    width: 4.877, depth: 3.66, position: [0, 0], rotation: 0,
  });
  assert.throws(() => parsePlacement({ width: 0, depth: 3, position: [0, 0], rotation: 0 }), /width/);
  assert.throws(() => parsePlacement({ width: 3, depth: 'big', position: [0, 0], rotation: 0 }), /depth/);
  const next = updateStageText(CONFIG, parsePlacement({ width: 6, depth: 4, position: [0, 0], rotation: 0 }));
  assert.deepEqual([JSON.parse(next).stage.width, JSON.parse(next).stage.depth], [6, 4]);
});

test('saves the input selection into its own block, and keeps one input on', () => {
  const next = updateBlockText(CONFIG, 'inputs', parseInputs({ osc: false, psn: true }));
  assert.deepEqual(JSON.parse(next).inputs, { osc: false, psn: true });
  assert.deepEqual(JSON.parse(next).stage, JSON.parse(CONFIG).stage);
  const again = updateBlockText(next, 'inputs', { osc: true, psn: true });
  assert.match(again, /"inputs": \{\n    "osc": true,\n    "psn": true\n  \}/);
  assert.throws(() => parseInputs({ osc: false, psn: false }), /at least one/);
  assert.throws(() => parseInputs({ osc: 'yes', psn: true }), /true or false/);
});
