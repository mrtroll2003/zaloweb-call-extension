'use strict';
// Stand-in for ZaloCall.exe used by test-host.js. Speaks the same pipe
// protocol as the real engine (as seen from Zalo PC's main process):
//   argv: <pipe we write to> <pipe we read from>
//   frames: hex(AES-128-CBC(JSON)) + "$"
// Key comes from the FAKE_ENGINE_KEY environment variable.

const net = require('net');
const crypto = require('crypto');

const [writePipe, readPipe] = process.argv.slice(2);
const KEY = Buffer.from(process.env.FAKE_ENGINE_KEY || '', 'base64');
const IV = Buffer.alloc(16, 0);
const enc = (s) => {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([c.update(s, 'utf8'), c.final()]).toString('hex');
};
const dec = (h) => {
  const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([d.update(Buffer.from(h, 'hex')), d.final()]).toString('utf8');
};

const received = [];
let out;
let split = true;
function send(obj) {
  const frame = `${enc(JSON.stringify(obj))}$`;
  if (split) {
    // Deliver the first frame in two pieces to exercise the host's buffering.
    split = false;
    out.write(frame.slice(0, 10));
    setTimeout(() => out.write(frame.slice(10)), 30);
  } else {
    out.write(frame);
  }
}

function onMessage(msg) {
  received.push(`${msg.type}:${msg.command}`);
  if (msg.type === 'request' && msg.command === 'makeCall') {
    send({ type: 'update', command: 'callState', data: { state: 'calling' } });
    send({ type: 'sendSignal', command: 401, data: { calleeId: msg.data.partner[0].id, callId: 4242, codec: '[]', type: msg.data.type } });
  } else if (msg.type === 'recvSignal' && msg.command === 401) {
    send({ type: 'update', command: 'callState', data: { state: 'free' } });
  } else if (msg.type === 'request' && msg.command === 'listDevice') {
    send({ type: 'response', command: 'listDevice', data: { audioInput: [{ name: 'Fake mic' }], audioOutput: [{ name: 'Fake speaker' }], video: [] } });
  } else if (msg.type === 'request' && msg.command === 'report') {
    send({ type: 'update', command: 'fake-report', data: { received: received.slice(), initLocal: lastInit && lastInit.local, logPath: lastInit && lastInit.logPath, osInfo: lastInit && lastInit.osInfo } });
  } else if (msg.type === 'request' && msg.command === 'test-kill') {
    send({ type: 'request', command: 'killMe', data: null });
  }
}

let lastInit = null;
out = net.connect(writePipe, () => {
  const inp = net.connect(readPipe, () => {
    send({ type: 'update', command: 'native-ready', data: null });
  });
  let buf = '';
  inp.setEncoding('utf8');
  inp.on('data', (t) => {
    buf += t;
    const parts = buf.split('$');
    buf = parts.pop();
    for (const p of parts) {
      if (!p) continue;
      const msg = JSON.parse(dec(p));
      if (msg.type === 'update' && msg.command === 'init') lastInit = msg.data;
      onMessage(msg);
    }
  });
  inp.on('end', () => process.exit(0));
});
out.on('error', () => process.exit(2));
process.on('SIGINT', () => process.exit(0));
