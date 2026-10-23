// Minimal OSC 1.0 codec: enough to decode tracking feeds (messages + bundles)
// and encode simple messages for the simulator. No dependencies.

function pad4(n) {
  return (n + 3) & ~3;
}

function readString(buf, offset) {
  let end = offset;
  while (end < buf.length && buf[end] !== 0) end++;
  if (end >= buf.length) throw new Error('OSC string not terminated');
  return { value: buf.toString('utf8', offset, end), next: pad4(end + 1) };
}

function readMessage(buf, offset, end) {
  const addr = readString(buf, offset);
  let pos = addr.next;
  const args = [];
  if (pos >= end) return { address: addr.value, args };
  const tags = readString(buf, pos);
  pos = tags.next;
  if (tags.value[0] !== ',') return { address: addr.value, args };
  for (const tag of tags.value.slice(1)) {
    switch (tag) {
      case 'i': args.push(buf.readInt32BE(pos)); pos += 4; break;
      case 'f': args.push(buf.readFloatBE(pos)); pos += 4; break;
      case 'd': args.push(buf.readDoubleBE(pos)); pos += 8; break;
      case 'h': args.push(Number(buf.readBigInt64BE(pos))); pos += 8; break;
      case 't': pos += 8; break;
      case 's':
      case 'S': {
        const s = readString(buf, pos);
        args.push(s.value);
        pos = s.next;
        break;
      }
      case 'b': {
        const len = buf.readInt32BE(pos);
        args.push(buf.subarray(pos + 4, pos + 4 + len));
        pos = pad4(pos + 4 + len);
        break;
      }
      case 'c': args.push(String.fromCharCode(buf.readInt32BE(pos))); pos += 4; break;
      case 'r':
      case 'm': args.push(buf.readUInt32BE(pos)); pos += 4; break;
      case 'T': args.push(true); break;
      case 'F': args.push(false); break;
      case 'N': args.push(null); break;
      case 'I': args.push(Infinity); break;
      default: throw new Error(`Unsupported OSC type tag '${tag}'`);
    }
    if (pos > end) throw new Error('OSC message truncated');
  }
  return { address: addr.value, args };
}

// Decode a UDP packet into a flat list of { address, args } messages
// (bundles are flattened, timetags ignored: we render on arrival).
export function decode(buf, offset = 0, end = buf.length, out = []) {
  if (buf.toString('ascii', offset, offset + 8) === '#bundle\0') {
    let pos = offset + 16; // skip '#bundle\0' + 8-byte timetag
    while (pos + 4 <= end) {
      const size = buf.readInt32BE(pos);
      pos += 4;
      decode(buf, pos, pos + size, out);
      pos += size;
    }
  } else if (buf[offset] === 0x2f /* '/' */) {
    out.push(readMessage(buf, offset, end));
  } else {
    throw new Error('Not an OSC packet');
  }
  return out;
}

function writeString(s) {
  const raw = Buffer.from(s + '\0', 'utf8');
  const b = Buffer.alloc(pad4(raw.length));
  raw.copy(b);
  return b;
}

// Encode a message. Numbers become floats unless wrapped as { type: 'i', value }.
export function encodeMessage(address, args = []) {
  let tags = ',';
  const parts = [];
  for (const a of args) {
    if (typeof a === 'string') {
      tags += 's';
      parts.push(writeString(a));
    } else if (a && a.type === 'i') {
      tags += 'i';
      const b = Buffer.alloc(4);
      b.writeInt32BE(a.value);
      parts.push(b);
    } else {
      tags += 'f';
      const b = Buffer.alloc(4);
      b.writeFloatBE(a);
      parts.push(b);
    }
  }
  return Buffer.concat([writeString(address), writeString(tags), ...parts]);
}

export function encodeBundle(messages) {
  const head = Buffer.alloc(16);
  head.write('#bundle\0', 0, 'ascii');
  head.writeUInt32BE(0, 8);
  head.writeUInt32BE(1, 12); // timetag "immediately"
  const parts = [head];
  for (const m of messages) {
    const size = Buffer.alloc(4);
    size.writeInt32BE(m.length);
    parts.push(size, m);
  }
  return Buffer.concat(parts);
}
