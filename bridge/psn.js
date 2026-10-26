// Minimal PosiStageNet (PSN v2) codec: decodes tracker positions and names, and
// encodes simple packets for the simulator. No dependencies.
//
// Every chunk starts with a little-endian uint32 header: id (bits 0-15),
// data length (bits 16-30) and a has-subchunks flag (bit 31).

const DATA_PACKET = 0x6755;
const INFO_PACKET = 0x6756;
const DATA_TRACKER_LIST = 0x0001;
const DATA_TRACKER_POS = 0x0000;
const INFO_SYSTEM_NAME = 0x0001;
const INFO_TRACKER_LIST = 0x0002;
const INFO_TRACKER_NAME = 0x0000;

// Split buf[offset, end) into its chunks: [{ id, start, end }].
function chunks(buf, offset = 0, end = buf.length) {
  const out = [];
  let pos = offset;
  while (pos + 4 <= end) {
    const header = buf.readUInt32LE(pos);
    const id = header & 0xffff;
    const len = (header >>> 16) & 0x7fff;
    const start = pos + 4;
    if (start + len > end) throw new Error('PSN chunk truncated');
    out.push({ id, start, end: start + len });
    pos = start + len;
  }
  return out;
}

// Decode a UDP packet into { kind: 'data', trackers: [{ id, pos: { x, y, z } }] }
// or { kind: 'info', systemName, trackers: [{ id, name }] }.
export function decode(buf) {
  const [root] = chunks(buf);
  if (!root || (root.id !== DATA_PACKET && root.id !== INFO_PACKET)) throw new Error('Not a PSN packet');
  const trackers = [];
  if (root.id === DATA_PACKET) {
    for (const list of chunks(buf, root.start, root.end)) {
      if (list.id !== DATA_TRACKER_LIST) continue;
      for (const tr of chunks(buf, list.start, list.end)) {
        for (const field of chunks(buf, tr.start, tr.end)) {
          if (field.id !== DATA_TRACKER_POS || field.end - field.start < 12) continue;
          const pos = {
            x: buf.readFloatLE(field.start),
            y: buf.readFloatLE(field.start + 4),
            z: buf.readFloatLE(field.start + 8),
          };
          trackers.push({ id: tr.id, pos });
        }
      }
    }
    return { kind: 'data', trackers };
  }
  let systemName = '';
  for (const c of chunks(buf, root.start, root.end)) {
    if (c.id === INFO_SYSTEM_NAME) systemName = buf.toString('utf8', c.start, c.end);
    if (c.id !== INFO_TRACKER_LIST) continue;
    for (const tr of chunks(buf, c.start, c.end)) {
      for (const field of chunks(buf, tr.start, tr.end)) {
        if (field.id === INFO_TRACKER_NAME) trackers.push({ id: tr.id, name: buf.toString('utf8', field.start, field.end) });
      }
    }
  }
  return { kind: 'info', systemName, trackers };
}

function chunk(id, payload, hasSubchunks = false) {
  const head = Buffer.alloc(4);
  head.writeUInt32LE(((hasSubchunks ? 0x8000 : 0) | payload.length) * 0x10000 + id);
  return Buffer.concat([head, payload]);
}

function packetHeader(frameId) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(BigInt(Date.now()) * 1000n, 0);
  b.writeUInt8(2, 8); // version 2.03
  b.writeUInt8(3, 9);
  b.writeUInt8(frameId & 0xff, 10);
  b.writeUInt8(1, 11); // one packet per frame
  return chunk(0x0000, b);
}

// trackers: [{ id, pos: { x, y, z } }]
export function encodeData(trackers, frameId = 0) {
  const list = trackers.map(({ id, pos }) => {
    const p = Buffer.alloc(12);
    p.writeFloatLE(pos.x, 0);
    p.writeFloatLE(pos.y, 4);
    p.writeFloatLE(pos.z, 8);
    return chunk(id, chunk(DATA_TRACKER_POS, p), true);
  });
  const body = Buffer.concat([packetHeader(frameId), chunk(DATA_TRACKER_LIST, Buffer.concat(list), true)]);
  return chunk(DATA_PACKET, body, true);
}

// trackers: [{ id, name }]
export function encodeInfo(systemName, trackers, frameId = 0) {
  const list = trackers.map(({ id, name }) => chunk(id, chunk(INFO_TRACKER_NAME, Buffer.from(name, 'utf8')), true));
  const body = Buffer.concat([
    packetHeader(frameId),
    chunk(INFO_SYSTEM_NAME, Buffer.from(systemName, 'utf8')),
    chunk(INFO_TRACKER_LIST, Buffer.concat(list), true),
  ]);
  return chunk(INFO_PACKET, body, true);
}
