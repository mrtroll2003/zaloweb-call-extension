'use strict';
// Native messaging host for the "Zalo Web Call" Edge extension.
//
// Edge starts one copy of this process per Zalo Web tab (through
// zalo-call-host.cmd). It plays the part of Zalo PC's Electron main process:
// it keeps the call init data, starts Zalo's ZaloCall.exe on demand and relays
// messages between the engine and the Zalo Web page.
//
// Extension -> host messages:
//   {op:"hello"}                     -> replies {op:"hello", ...status}
//   {op:"init", msg}                 (= ipc "call-init")
//   {op:"send", msg}                 (= ipc "call-send-to-native")
//   {op:"stop"}                      stop the engine
// Host -> extension messages:
//   {op:"hello", ok, error?, ...}
//   {op:"native", msg}               message from the engine (update/sendSignal/request/response)
//   {op:"engine", running, ready}    engine process state
//   {op:"error", error}

const { readConfig, createLogger, HOST_VERSION, DEFAULT_LOG_DIR } = require('./common');
const { EngineBridge } = require('./engine-bridge');

const cfg = readConfig();
const log = createLogger(cfg.ok ? cfg.logDir : DEFAULT_LOG_DIR, 'host.log');
log(`host ${HOST_VERSION} started, pid ${process.pid}, node ${process.version}`);

// ---- native messaging framing (4-byte little-endian length + UTF-8 JSON) ----
function sendToExtension(obj) {
  let json;
  try {
    json = Buffer.from(JSON.stringify(obj), 'utf8');
  } catch (e) {
    log('cannot serialize message for extension', e);
    return;
  }
  if (json.length > 1024 * 1024) {
    log('dropping message larger than 1 MB');
    return;
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(json.length, 0);
  if (shuttingDown || process.stdout.destroyed) return;
  try {
    process.stdout.write(Buffer.concat([header, json]));
  } catch (e) {
    shutdown(0);
  }
}
// The browser closed its end (tab closed, Edge exited): stop quietly.
process.stdout.on('error', () => shutdown(0));

let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (len > 64 * 1024 * 1024) {
      log('invalid message length', len);
      shutdown(1);
      return;
    }
    if (inBuf.length < 4 + len) break;
    const body = inBuf.subarray(4, 4 + len);
    inBuf = inBuf.subarray(4 + len);
    let msg;
    try {
      msg = JSON.parse(body.toString('utf8'));
    } catch (e) {
      log('bad JSON from extension', e.message);
      continue;
    }
    try {
      onExtensionMessage(msg);
    } catch (e) {
      log('error handling extension message', e);
    }
  }
});
process.stdin.on('end', () => {
  log('browser closed the connection');
  shutdown(0);
});
process.stdin.on('error', (e) => {
  log('stdin error', e.message);
  shutdown(0);
});

// ---- engine -----------------------------------------------------------------
let engine = null;
let idleTimer = null;
let callBusy = false;

// The message types Zalo Web's call helper sends to the engine. Anything else
// from the page is dropped.
const ENGINE_TYPES = new Set(['update', 'request', 'response', 'recvSignal', 'control']);

if (cfg.ok) {
  engine = new EngineBridge({
    engineExe: cfg.engineExe,
    engineCommand: cfg.engineCommand,
    transportKey: cfg.transportKey,
    logDir: cfg.logDir,
    debug: cfg.debugLog,
    log,
  });
  engine.on('message', (msg) => {
    if (msg && msg.type === 'update' && msg.command === 'callState' && msg.data) {
      callBusy = msg.data.state !== 'free';
      armIdleTimer();
    }
    sendToExtension({ op: 'native', msg });
  });
  engine.on('state', (st) => {
    armIdleTimer();
    sendToExtension({ op: 'engine', running: st.running, ready: st.ready });
  });
  engine.on('error', (e) => sendToExtension({ op: 'error', error: String((e && e.message) || e) }));
} else {
  log('not configured:', cfg.error);
}

function armIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  if (!engine || !engine.running || callBusy || !(cfg.idleStopMinutes > 0)) return;
  idleTimer = setTimeout(() => {
    if (engine && engine.running && !callBusy) {
      log(`engine idle for ${cfg.idleStopMinutes} min, stopping it`);
      engine.stop();
    }
  }, cfg.idleStopMinutes * 60 * 1000);
}

function onExtensionMessage(m) {
  switch (m && m.op) {
    case 'hello':
      sendToExtension({
        op: 'hello',
        ok: cfg.ok,
        error: cfg.ok ? undefined : cfg.error,
        hostVersion: HOST_VERSION,
        zaloVersion: cfg.ok ? cfg.zaloVersion : undefined,
        engineRunning: !!(engine && engine.running),
        engineReady: !!(engine && engine.ready),
      });
      return;
    case 'init':
      if (engine) engine.setInit(m.msg);
      return;
    case 'send': {
      if (!engine) {
        sendToExtension({ op: 'error', error: cfg.error || 'not configured' });
        return;
      }
      const msg = m.msg && typeof m.msg === 'object' ? { ...m.msg } : null;
      if (!msg || !ENGINE_TYPES.has(msg.type)) {
        log('dropped a message of unknown type', msg && String(msg.type).slice(0, 40));
        return;
      }
      // These only mean something to an engine that is already running (Zalo
      // Web sends endCall on logout, for example). Never launch it for them.
      if (!engine.active && (msg.type === 'recvSignal' || msg.type === 'response' || (msg.type === 'request' && msg.command === 'endCall'))) {
        log(`engine not running; dropped ${msg.type}:${msg.command}`);
        return;
      }
      // With lazyStart, state updates (init, language, devices, call settings)
      // wait for the next launch instead of causing one. Calls and incoming-call
      // events still launch the engine.
      if (cfg.lazyStart && msg.type === 'update') msg._optional = true;
      engine.send(msg);
      armIdleTimer();
      return;
    }
    case 'stop':
      if (engine) engine.stop();
      return;
    default:
      log('unknown op from extension', m && m.op);
  }
}

let shuttingDown = false;
function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    if (engine) engine.dispose();
  } catch (e) {
    /* ignore */
  }
  setTimeout(() => process.exit(code), 300);
}

process.on('uncaughtException', (e) => {
  log('uncaught exception', e);
});
process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));
