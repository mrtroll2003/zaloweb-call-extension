'use strict';
// End-to-end test of the native messaging host with a fake engine:
//   node test/test-host.js <scratch dir>
// Exercises: native-messaging framing, lazy start, pipe handshake, AES framing
// (including a frame split across writes), init-before-queue ordering, signal
// relay, responses, killMe restart, and clean shutdown when the browser closes.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const scratch = path.resolve(process.argv[2] || path.join(__dirname, '.scratch', 'host-test'));
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const key = crypto.randomBytes(16).toString('base64');
const configPath = path.join(scratch, 'host-config.json');
fs.writeFileSync(
  configPath,
  JSON.stringify({
    engineExe: process.execPath,
    engineCommand: [process.execPath, path.join(__dirname, 'fake-engine.js')],
    transportKey: key,
    logDir: path.join(scratch, 'logs'),
    lazyStart: true,
    idleStopMinutes: 0,
  }),
);

const host = spawn(process.execPath, [path.join(__dirname, '..', 'native', 'host', 'zalo-call-host.js')], {
  env: { ...process.env, ZALO_WEB_CALL_CONFIG: configPath, FAKE_ENGINE_KEY: key },
  stdio: ['pipe', 'pipe', 'inherit'],
});

const inbox = [];
let waiters = [];
let buf = Buffer.alloc(0);
host.stdout.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
    buf = buf.subarray(4 + len);
    inbox.push(msg);
    waiters = waiters.filter((w) => !w(msg));
  }
});
function send(obj) {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  const h = Buffer.alloc(4);
  h.writeUInt32LE(b.length);
  host.stdin.write(Buffer.concat([h, b]));
}
function waitFor(pred, what, ms = 5000) {
  const hit = inbox.find(pred);
  if (hit) {
    inbox.splice(inbox.indexOf(hit), 1);
    return Promise.resolve(hit);
  }
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
    waiters.push((m) => {
      if (!pred(m)) return false;
      clearTimeout(t);
      inbox.splice(inbox.indexOf(m), 1);
      resolve(m);
      return true;
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
function ok(cond, label) {
  if (!cond) throw new Error(`FAILED: ${label}`);
  passed++;
  console.log(`  ok - ${label}`);
}
const isNative = (type, command) => (m) => m.op === 'native' && m.msg && m.msg.type === type && m.msg.command === command;

const initData = {
  local: { id: '42', avatar: '', name: 'Tester' },
  osInfo: '',
  mainWindowId: '42',
  logPath: '',
  zrtcLogPath: '',
  dumpPath: '',
  clientVersion: 695,
  language: 'vi',
};

(async () => {
  send({ op: 'hello' });
  const hello = await waitFor((m) => m.op === 'hello', 'hello');
  ok(hello.ok === true && hello.engineRunning === false, 'hello reports a configured, idle helper');

  send({ op: 'init', msg: { type: 'update', command: 'init', data: initData, _optional: true } });
  send({ op: 'send', msg: { type: 'update', command: 'init', data: initData, _optional: false } });
  await sleep(600);
  ok(!inbox.some((m) => m.op === 'engine'), 'startup init does not launch the engine (lazy start)');

  send({ op: 'send', msg: { type: 'request', command: 'makeCall', data: { partner: [{ id: '777', name: 'Friend' }], type: 3 } } });
  await waitFor((m) => m.op === 'engine' && m.running && !m.ready, 'engine starting');
  ok(true, 'placing a call launches the engine');
  await waitFor((m) => m.op === 'engine' && m.ready, 'engine ready');
  ok(true, 'engine handshake (native-ready) completes, including a split frame');

  const sig = await waitFor(isNative('sendSignal', 401), 'sendSignal 401');
  ok(sig.msg.data.calleeId === '777' && sig.msg.data.type === 3, 'engine signal 401 is relayed with the callee and video type');
  const busy = await waitFor((m) => isNative('update', 'callState')(m) && m.msg.data.state === 'calling', 'callState calling');
  ok(!!busy, 'call state updates are relayed');

  send({ op: 'send', msg: { type: 'recvSignal', command: 401, data: { error_code: 0, data: { sessId: 'x' } } } });
  await waitFor((m) => isNative('update', 'callState')(m) && m.msg.data.state === 'free', 'callState free');
  ok(true, 'server reply is delivered to the engine (engine answered with callState free)');

  send({ op: 'send', msg: { type: 'request', command: 'listDevice', data: null } });
  const dev = await waitFor(isNative('response', 'listDevice'), 'listDevice response');
  ok(dev.msg.data.audioInput[0].name === 'Fake mic', 'responses are relayed');

  send({ op: 'send', msg: { type: 'request', command: 'report', data: null } });
  const rep = await waitFor(isNative('update', 'fake-report'), 'report');
  const order = rep.msg.data.received;
  ok(order[0] === 'update:init', `init data reaches the engine first (got ${order.slice(0, 3).join(', ')})`);
  ok(order.filter((x) => x === 'update:init').length === 2, 'stored init + the queued init update are both delivered');
  ok(rep.msg.data.initLocal && rep.msg.data.initLocal.id === '42', 'init data carries the local user');
  ok(/call\.log$/.test(rep.msg.data.logPath || '') && /_win32_|_linux_|_darwin_/.test(rep.msg.data.osInfo || ''), 'helper fills log paths and OS info');

  send({ op: 'send', msg: { type: 'request', command: 'test-kill', data: null } });
  await waitFor((m) => m.op === 'engine' && !m.running, 'engine stopped after killMe');
  await waitFor((m) => m.op === 'engine' && m.ready, 'engine ready again after restart', 8000);
  ok(true, 'killMe makes the helper restart the engine');
  send({ op: 'send', msg: { type: 'request', command: 'report', data: null } });
  const rep2 = await waitFor(isNative('update', 'fake-report'), 'report after restart');
  ok(rep2.msg.data.received[0] === 'update:init', 'restarted engine gets the init data again');

  // Browser closes the port -> helper stops the engine and exits.
  const exited = new Promise((r) => host.on('exit', r));
  host.stdin.end();
  const code = await Promise.race([exited, sleep(4000).then(() => 'timeout')]);
  ok(code !== 'timeout', 'helper exits when the browser disconnects');
  await sleep(500);
  const ps = execFileSync('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*fake-engine.js*' } | Measure-Object).Count"], { encoding: 'utf8' }).trim();
  ok(ps === '0', 'engine process is gone after the helper exits');

  console.log(`\n${passed} checks passed`);
  fs.rmSync(scratch, { recursive: true, force: true });
})().catch((e) => {
  console.error(e.message);
  console.error('inbox:', JSON.stringify(inbox).slice(0, 2000));
  try {
    host.kill();
  } catch (x) {
    /* ignore */
  }
  process.exitCode = 1;
});
