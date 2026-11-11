'use strict';
// Security checks for the helper, with the fake engine (no ZaloCall.exe needed):
//   node test/test-security.js
// Covers: the engine pipes accept only the engine, nothing reaches the engine
// before it is ready, the page cannot choose the engine's file paths, messages
// that should not launch the engine don't, host.log keeps no call details, and
// setup's VNG signature check. If native\engine exists, the signature check is
// also run on the real ZaloCall.exe and an unsigned DLL next to it.

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EngineBridge, PATH_KEYS } = require('../native/host/engine-bridge');
const { signedByVng, checkSignature } = require('../native/setup');

const FAKE_ENGINE = path.join(__dirname, 'fake-engine.js');
const scratch = path.join(__dirname, '.scratch', 'security-test');
fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const key = crypto.randomBytes(16).toString('base64');
process.env.FAKE_ENGINE_KEY = key; // read by fake-engine.js
const K = Buffer.from(key, 'base64');
const IV = Buffer.alloc(16, 0);
const enc = (s) => {
  const c = crypto.createCipheriv('aes-128-cbc', K, IV);
  return Buffer.concat([c.update(s, 'utf8'), c.final()]).toString('hex');
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
let failed = 0;
function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log(`  ok - ${label}`);
  } else {
    failed++;
    console.log(`  NOT OK - ${label}${extra ? `\n      ${extra}` : ''}`);
  }
}

function bridge(engineCommand) {
  return new EngineBridge({
    engineExe: process.execPath,
    engineCommand,
    transportKey: key,
    logDir: path.join(scratch, 'bridge-logs'),
  });
}
const waitUntil = async (cond, ms = 5000) => {
  for (let t = 0; t < ms && !cond(); t += 50) await sleep(50);
  return cond();
};
// Connects to a pipe and records what it receives.
function intruder(pipePath) {
  const s = { connected: false, error: null, got: '' };
  s.sock = net.connect(pipePath);
  s.sock.setEncoding('utf8');
  s.sock.on('connect', () => (s.connected = true));
  s.sock.on('error', (e) => (s.error = e.code));
  s.sock.on('data', (d) => (s.got += d));
  return s;
}

async function pipeTests() {
  console.log('Engine pipes:');
  // 1. An intruder that grabs the send pipe before the engine connects gets
  //    nothing: the helper waits for "native-ready" on the other pipe.
  {
    const b = bridge([process.execPath, '-e', 'setTimeout(() => {}, 60000)']); // an engine that never connects
    b.send({ type: 'request', command: 'makeCall', data: { partner: [{ id: '777', name: 'Friend' }], type: 1 } });
    await waitUntil(() => b.running);
    const spy = intruder(b.sendPipe);
    await waitUntil(() => spy.connected, 2000);
    b.send({ type: 'request', command: 'listDevice', data: null });
    await sleep(500);
    ok(spy.connected && spy.got === '', 'a client on the send pipe before the engine is ready receives nothing', `connected=${spy.connected} got=${spy.got.length} bytes`);
    const second = intruder(b.sendPipe);
    await sleep(1000);
    ok(!second.connected, 'the send pipe accepts only one client');
    ok(/^\\\\\.\\pipe\\ZaloWebCall-[0-9a-f]{32}-send$/.test(b.sendPipe), 'pipe names carry a 128-bit random tag', b.sendPipe);
    spy.sock.destroy();
    second.sock.destroy();
    b.dispose();
    await waitUntil(() => !b.running);
  }

  // 2. Once the engine is connected, nobody else can connect to either pipe,
  //    and the engine keeps getting its messages.
  {
    const b = bridge([process.execPath, FAKE_ENGINE]);
    const fromEngine = [];
    b.on('message', (m) => fromEngine.push(m));
    b.send({ type: 'request', command: 'listDevice', data: null });
    await waitUntil(() => b.ready && fromEngine.some((m) => m.type === 'response'));
    const firstPipes = [b.recvPipe, b.sendPipe];
    const spy = intruder(b.sendPipe);
    const inj = intruder(b.recvPipe);
    await sleep(1200);
    ok(!spy.connected && !inj.connected, 'with the engine connected, other clients cannot connect to either pipe', `send=${spy.connected} recv=${inj.connected}`);
    const before = fromEngine.filter((m) => m.type === 'response').length;
    b.send({ type: 'request', command: 'listDevice', data: null });
    await waitUntil(() => fromEngine.filter((m) => m.type === 'response').length > before, 3000);
    ok(fromEngine.filter((m) => m.type === 'response').length > before && spy.got === '', 'the engine still gets its messages; the intruder gets none');
    if (inj.connected) inj.sock.write(`${enc(JSON.stringify({ type: 'sendSignal', command: 401, data: { calleeId: 'FORGED' } }))}$`);
    await sleep(300);
    ok(!fromEngine.some((m) => m.data && m.data.calleeId === 'FORGED'), 'no forged engine messages get through');
    spy.sock.destroy();
    inj.sock.destroy();

    // 3. After a restart the engine gets fresh pipes and the init data again.
    b.setInit({ type: 'update', command: 'init', data: { local: { id: '1' } } });
    b.send({ type: 'request', command: 'test-kill', data: null });
    await waitUntil(() => !b.ready, 3000);
    await waitUntil(() => b.ready, 8000);
    ok(b.ready && b.sendPipe !== firstPipes[1] && b.recvPipe !== firstPipes[0], 'a restarted engine gets new pipe names');
    b.dispose();
    await waitUntil(() => !b.running);
  }
}

function pathTests() {
  console.log('Engine file paths:');
  const b = bridge(null);
  const evil = 'C:/Users/Public/evil.dmp';
  const unc = '//attacker-host/share';
  const cases = [
    { type: 'update', command: 'init', data: { local: { id: '1' }, dumpPath: evil } },
    { type: 'update', command: 'init', data: { dumpPath: evil, zrtcLogPath: evil } },
    { type: 'update', command: 'updateLocal', data: { zrtcLogPath: unc } },
    { type: 'request', command: 'makeCall', data: { dumpPath: evil, logPath: unc } },
  ];
  const logDir = path.join(scratch, 'bridge-logs');
  const allSafe = cases.every((c) => {
    const out = b.fillInitData(c);
    return PATH_KEYS.every((k) => !(k in c.data) || String(out.data[k]).startsWith(logDir));
  });
  ok(allSafe, 'paths sent by the page are always replaced by the helper\'s own');
  const plain = { type: 'request', command: 'makeCall', data: { partner: [] } };
  ok(b.fillInitData(plain) === plain, 'messages without paths pass through unchanged');
}

// Runs the real host process with the fake engine and sends it one message.
async function hostTrial(msg, configExtra = {}) {
  const logDir = path.join(scratch, `host-logs-${crypto.randomBytes(3).toString('hex')}`);
  const configPath = path.join(scratch, `host-config-${crypto.randomBytes(3).toString('hex')}.json`);
  fs.writeFileSync(configPath, JSON.stringify({
    engineExe: process.execPath,
    engineCommand: [process.execPath, FAKE_ENGINE],
    transportKey: key,
    logDir,
    lazyStart: true,
    idleStopMinutes: 0,
    ...configExtra,
  }));
  const host = spawn(process.execPath, [path.join(__dirname, '..', 'native', 'host', 'zalo-call-host.js')], {
    env: { ...process.env, ZALO_WEB_CALL_CONFIG: configPath },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  let launched = false;
  let ready = false;
  let buf = Buffer.alloc(0);
  host.stdout.on('data', (c) => {
    buf = Buffer.concat([buf, c]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const m = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8'));
      buf = buf.subarray(4 + buf.readUInt32LE(0));
      if (m.op === 'engine' && m.running) launched = true;
      if (m.op === 'engine' && m.ready) ready = true;
    }
  });
  const body = Buffer.from(JSON.stringify({ op: 'send', msg }), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length);
  host.stdin.write(Buffer.concat([head, body]));
  await sleep(1200);
  if (launched) await waitUntil(() => ready, 3000);
  host.stdin.end();
  await new Promise((r) => host.on('exit', r));
  let hostLog = '';
  try {
    hostLog = fs.readFileSync(path.join(logDir, 'host.log'), 'utf8');
  } catch (e) {
    /* none */
  }
  return { launched, hostLog };
}

async function hostTests() {
  console.log('Helper (lazy start, message filter, log contents):');
  const idle = [
    ['request:endCall (Zalo sends it on logout or session kick)', { type: 'request', command: 'endCall', data: null }],
    ['update:listDevice (call device settings changed)', { type: 'update', command: 'listDevice', data: {} }],
    ['update:advancedOptions (call settings changed)', { type: 'update', command: 'advancedOptions', data: {} }],
    ['recvSignal while no engine runs', { type: 'recvSignal', command: 401, data: {} }],
    ['response while no engine runs', { type: 'response', command: 'serverTime', data: {} }],
    ['an unknown message type', { type: 'shell', command: 'x', data: {} }],
  ];
  for (const [label, msg] of idle) {
    const r = await hostTrial(msg);
    ok(!r.launched, `${label} does not launch the engine`);
  }
  const secretName = 'Secret Friend Name';
  const call = { type: 'request', command: 'makeCall', data: { partner: [{ id: '98765', name: secretName }], type: 1 } };
  const r = await hostTrial(call);
  ok(r.launched, 'request:makeCall still launches the engine');
  ok(r.hostLog.includes('request:makeCall') && !r.hostLog.includes(secretName) && !r.hostLog.includes('98765'), 'host.log records the message type but not who was called');
  const dbg = await hostTrial(call, { debugLog: true });
  ok(dbg.hostLog.includes(secretName), 'with "debugLog": true the details are logged (for troubleshooting)');
}

function signatureTests() {
  console.log('Setup signature check:');
  const subj = (cn) => `CN=${cn}, O=VNG GROUP JSC, S=Ho Chi Minh City, C=VN`;
  ok(signedByVng({ Status: 'Valid', Subject: subj('VNG GROUP JSC') }), 'accepts a valid "VNG GROUP JSC" signature');
  ok(signedByVng({ Status: 'Valid', Subject: 'CN=VNG Corporation, O=VNG Corporation, C=VN' }), 'accepts a valid "VNG Corporation" signature');
  ok(!signedByVng({ Status: 'Valid', Subject: subj('NotVNG Ltd') }), 'rejects another signer whose name merely contains "VNG"');
  ok(!signedByVng({ Status: 'HashMismatch', Subject: subj('VNG GROUP JSC') }), 'rejects a tampered (hash mismatch) file');
  ok(!signedByVng({ Status: 'NotSigned', Subject: '' }), 'rejects an unsigned file');
  const engineDir = path.join(__dirname, '..', 'native', 'engine');
  if (fs.existsSync(path.join(engineDir, 'ZaloCall.exe'))) {
    ok(signedByVng(checkSignature(path.join(engineDir, 'ZaloCall.exe'))), 'the real ZaloCall.exe passes');
    ok(!signedByVng(checkSignature(path.join(engineDir, 'Qt5Core.dll'))), 'an unsigned DLL from the engine folder fails');
  } else {
    console.log('  (native\\engine not set up: skipped the checks on real files)');
  }
}

(async () => {
  await pipeTests();
  pathTests();
  await hostTests();
  signatureTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  process.exitCode = failed ? 1 : 0;
})().catch((e) => {
  console.error('test error:', e);
  process.exitCode = 1;
});
