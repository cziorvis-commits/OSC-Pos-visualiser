import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapper } from '../bridge/mapper.js';
import { decode, encodeData, encodeInfo } from '../bridge/psn.js';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-5, `${a} != ${b}`);

test('decodes tracker positions from a data packet', () => {
  const r = decode(encodeData([
    { id: 1, pos: { x: 1.5, y: 0, z: -2.25 } },
    { id: 7, pos: { x: -3, y: 1.8, z: 4 } },
  ]));
  assert.equal(r.kind, 'data');
  assert.deepEqual(r.trackers.map((t) => t.id), [1, 7]);
  close(r.trackers[0].pos.x, 1.5);
  close(r.trackers[0].pos.z, -2.25);
  close(r.trackers[1].pos.y, 1.8);
});

test('decodes system and tracker names from an info packet', () => {
  const r = decode(encodeInfo('Kratos', [{ id: 1, name: 'Lead' }, { id: 2, name: 'Dancer A' }]));
  assert.deepEqual(r, { kind: 'info', systemName: 'Kratos', trackers: [{ id: 1, name: 'Lead' }, { id: 2, name: 'Dancer A' }] });
});

test('rejects non-PSN and truncated packets', () => {
  assert.throws(() => decode(Buffer.from('/tracker/1/pos\0\0')), /PSN/);
  const buf = encodeData([{ id: 1, pos: { x: 1, y: 2, z: 3 } }]);
  assert.throws(() => decode(buf.subarray(0, buf.length - 4)), /truncated/);
  assert.throws(() => decode(Buffer.alloc(2)), /Not a PSN packet/);
});

test('PSN trackers go through the /psn/{id}/pos mapping', () => {
  const m = createMapper({ mappings: [{ address: '/psn/{id}/pos', args: ['x', 'y', 'z'] }] });
  const r = m.map({ address: '/psn/4/pos', args: [1, 2, 3] });
  assert.deepEqual(r.positions, [{ id: '4', x: 1, y: 2, z: 3 }]);
});
