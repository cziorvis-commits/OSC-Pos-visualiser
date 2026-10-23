import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapper } from '../bridge/mapper.js';
import { decode, encodeBundle, encodeMessage } from '../bridge/osc.js';

test('maps /tracker/{id}/pos with xyz args', () => {
  const m = createMapper({ mappings: [{ address: '/tracker/{id}/pos', args: ['x', 'y', 'z'] }] });
  const r = m.map({ address: '/tracker/3/pos', args: [1, 2, 3] });
  assert.equal(r.matched, true);
  assert.deepEqual(r.positions, [{ id: '3', x: 1, y: 2, z: 3 }]);
  assert.equal(m.map({ address: '/other', args: [1] }).matched, false);
});

test('merges per-axis messages for the same id', () => {
  const m = createMapper({
    mappings: [
      { address: '/{id}/x', args: ['x'] },
      { address: '/{id}/y', args: ['y'] },
    ],
  });
  m.map({ address: '/a/x', args: [5] });
  const r = m.map({ address: '/a/y', args: [7] });
  assert.deepEqual(r.positions, [{ id: 'a', x: 5, y: 7, z: 0 }]);
});

test('merges id-less /pos/x, /pos/y, /pos/z and /pos/xy under a fixed id', () => {
  const m = createMapper({
    mappings: [
      { address: '/pos/xyz', id: 'xyz', args: ['x', 'y', 'z'] },
      { address: '/pos/xy', id: 'xyz', args: ['x', 'y'] },
      { address: '/pos/x', id: 'xyz', args: ['x'] },
      { address: '/pos/y', id: 'xyz', args: ['y'] },
      { address: '/pos/z', id: 'xyz', args: ['z'] },
    ],
  });
  m.map({ address: '/pos/x', args: [1] });
  m.map({ address: '/pos/y', args: [2] });
  assert.deepEqual(m.map({ address: '/pos/z', args: [3] }).positions, [{ id: 'xyz', x: 1, y: 2, z: 3 }]);
  assert.deepEqual(m.map({ address: '/pos/xy', args: [4, 5] }).positions, [{ id: 'xyz', x: 4, y: 5, z: 3 }]);
  assert.deepEqual(m.map({ address: '/pos/xyz', args: [6, 7, 8] }).positions, [{ id: 'xyz', x: 6, y: 7, z: 8 }]);
});

test('drops an axis back to 0 once it has not been updated for staleMs', () => {
  const m = createMapper({
    staleMs: 1500,
    mappings: [
      { address: '/pos/xyz', id: 'xyz', args: ['x', 'y', 'z'] },
      { address: '/pos/xy', id: 'xyz', args: ['x', 'y'] },
    ],
  });
  m.map({ address: '/pos/xyz', args: [1, 2, 3] }, 0);
  assert.deepEqual(m.map({ address: '/pos/xy', args: [4, 5] }, 1500).positions, [{ id: 'xyz', x: 4, y: 5, z: 3 }]);
  assert.deepEqual(m.map({ address: '/pos/xy', args: [6, 7] }, 1501).positions, [{ id: 'xyz', x: 6, y: 7, z: 0 }]);
});

test('takes the id from an argument', () => {
  const m = createMapper({ mappings: [{ address: '/pos', args: ['id', 'x', 'y', 'z'] }] });
  assert.deepEqual(m.map({ address: '/pos', args: [12, 1, 2, 3] }).positions, [{ id: '12', x: 1, y: 2, z: 3 }]);
});

test('applies axis swap, sign flip, scale and offset', () => {
  const m = createMapper({
    mappings: [{ address: '/t/{id}', args: ['x', 'y', 'z'] }],
    transform: { x: '-x', y: 'z', z: 'y', scale: 0.001, offset: [0, 1, 0] },
  });
  assert.deepEqual(m.map({ address: '/t/1', args: [1000, 2000, 3000] }).positions, [{ id: '1', x: -1, y: 4, z: 2 }]);
});

test('decodes bundles from the encoder', () => {
  const buf = encodeBundle([encodeMessage('/tracker/1/pos', [1.5, 2, 0]), encodeMessage('/name', ['bob', { type: 'i', value: 4 }])]);
  assert.deepEqual(decode(buf), [
    { address: '/tracker/1/pos', args: [1.5, 2, 0] },
    { address: '/name', args: ['bob', 4] },
  ]);
});
