// Tiny send-only WebSocket server (RFC 6455), so the app needs nothing but Node.
// The browser never sends us data, so we only handle the handshake, close and ping.
import crypto from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_BUFFERED = 4 * 1024 * 1024; // drop frames for a client that can't keep up

function frame(opcode, payload) {
  const len = payload.length;
  let head;
  if (len < 126) {
    head = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[0] = 0x80 | opcode;
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[0] = 0x80 | opcode;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([head, payload]);
}

export function createWebSocketServer(httpServer, onConnection) {
  const clients = new Set();

  httpServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.destroy();
      return;
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.setNoDelay(true);

    const client = {
      send(text) {
        if (socket.writable && socket.writableLength < MAX_BUFFERED) {
          socket.write(frame(0x1, Buffer.from(text)));
        }
      },
    };
    clients.add(client);

    socket.on('data', (buf) => {
      const opcode = buf[0] & 0x0f;
      if (opcode === 0x8) socket.end(frame(0x8, Buffer.alloc(0)));
      else if (opcode === 0x9) socket.write(frame(0xa, Buffer.alloc(0)));
    });
    const drop = () => clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);

    onConnection(client);
  });

  return {
    broadcast(text) {
      for (const c of clients) c.send(text);
    },
  };
}
