// Minimal FreeD codec: decodes D1 (camera position/orientation) messages, and encodes
// them for the simulator. No dependencies.
//
// A D1 message is 29 bytes: 0xD1, camera id, then pan, tilt, roll, x, y, z, zoom and
// focus as big-endian 24-bit fields, 2 spare bytes and a checksum. Angles are signed
// in 1/32768 degree, positions signed in 1/64 mm, zoom and focus are raw encoder counts.
// FreeD's z is height, which already matches the stage axes. Some senders pack several
// messages into one UDP packet, so every 29-byte message in it is decoded.

const D1 = 0xd1;
const LENGTH = 29;
const ANGLE = 32768; // units per degree
const POS = 64 * 1000; // units per metre

const int24 = (buf, at) => buf.readIntBE(at, 3);
const uint24 = (buf, at) => buf.readUIntBE(at, 3);

function checksum(buf, start) {
  let sum = 0x40;
  for (let i = start; i < start + LENGTH - 1; i++) sum -= buf[i];
  return sum & 0xff;
}

// Decode a UDP packet into [{ id, pos: { x, y, z }, pan, tilt, roll, zoom, focus }]
// with positions in metres and angles in degrees.
export function decode(buf) {
  if (buf.length < LENGTH || buf.length % LENGTH !== 0) throw new Error(`Not a FreeD packet (${buf.length} bytes)`);
  const out = [];
  for (let at = 0; at < buf.length; at += LENGTH) {
    if (buf[at] !== D1) throw new Error(`Not a FreeD D1 message (type 0x${buf[at].toString(16)})`);
    if (checksum(buf, at) !== buf[at + LENGTH - 1]) throw new Error('FreeD checksum mismatch');
    out.push({
      id: buf[at + 1],
      pan: int24(buf, at + 2) / ANGLE,
      tilt: int24(buf, at + 5) / ANGLE,
      roll: int24(buf, at + 8) / ANGLE,
      pos: { x: int24(buf, at + 11) / POS, y: int24(buf, at + 14) / POS, z: int24(buf, at + 17) / POS },
      zoom: uint24(buf, at + 20),
      focus: uint24(buf, at + 23),
    });
  }
  return out;
}

// Encode one D1 message from { id, pos: { x, y, z }, pan?, tilt?, roll?, zoom?, focus? }.
export function encode({ id, pos, pan = 0, tilt = 0, roll = 0, zoom = 0, focus = 0 }) {
  const buf = Buffer.alloc(LENGTH);
  buf[0] = D1;
  buf[1] = id;
  const clamp = (v) => Math.max(-0x800000, Math.min(0x7fffff, Math.round(v)));
  [pan, tilt, roll].forEach((a, i) => buf.writeIntBE(clamp(a * ANGLE), 2 + i * 3, 3));
  [pos.x, pos.y, pos.z].forEach((v, i) => buf.writeIntBE(clamp(v * POS), 11 + i * 3, 3));
  buf.writeUIntBE(zoom, 20, 3);
  buf.writeUIntBE(focus, 23, 3);
  buf[LENGTH - 1] = checksum(buf, 0);
  return buf;
}
