import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePlacement, updateStageText } from '../bridge/stage-file.js';

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
