import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMapper } from '../bridge/mapper.js';
import { decode, encode } from '../bridge/freed.js';

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('decodes a D1 message: position in metres, angles in degrees', () => {
  const [r] = decode(encode({ id: 3, pos: { x: 1.5, y: -2.25, z: 1.8 }, pan: -90, tilt: 12.5, roll: 0.25, zoom: 1234, focus: 99 }));
  assert.equal(r.id, 3);
  close(r.pos.x, 1.5);
  close(r.pos.y, -2.25);
  close(r.pos.z, 1.8);
  close(r.pan, -90);
  close(r.tilt, 12.5);
  close(r.roll, 0.25);
  assert.deepEqual([r.zoom, r.focus], [1234, 99]);
});

test('matches a hand-built packet and its checksum', () => {
  // Camera 1 at x = 1 m (64000 = 0x00FA00), everything else 0.
  const buf = Buffer.alloc(29);
  buf[0] = 0xd1;
  buf[1] = 1;
  buf.writeIntBE(64000, 11, 3);
  buf[28] = (0x40 - 0xd1 - 1 - 0xfa) & 0xff;
  assert.deepEqual(encode({ id: 1, pos: { x: 1, y: 0, z: 0 } }), buf);
  assert.deepEqual(decode(buf)[0].pos, { x: 1, y: 0, z: 0 });
});

test('decodes several messages in one packet', () => {
  const buf = Buffer.concat([encode({ id: 1, pos: { x: 1, y: 0, z: 0 } }), encode({ id: 2, pos: { x: 0, y: 2, z: 0 } })]);
  assert.deepEqual(decode(buf).map((r) => r.id), [1, 2]);
});

test('rejects wrong lengths, types and checksums', () => {
  assert.throws(() => decode(Buffer.alloc(10)), /Not a FreeD packet/);
  assert.throws(() => decode(Buffer.alloc(29)), /D1/);
  const bad = encode({ id: 1, pos: { x: 1, y: 2, z: 3 } });
  bad[28] ^= 1;
  assert.throws(() => decode(bad), /checksum/);
});

test('FreeD cameras go through the /freed/{id}/pos mapping', () => {
  const m = createMapper({ mappings: [{ address: '/freed/{id}/pos', args: ['x', 'y', 'z'] }] });
  assert.deepEqual(m.map({ address: '/freed/2/pos', args: [1, 2, 3, 45, 0, 0] }).positions, [{ id: '2', x: 1, y: 2, z: 3 }]);
});
