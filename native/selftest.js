'use strict';
// Checks that this PC can drive Zalo's call engine without a browser or a Zalo
// account: starts ZaloCall.exe over the two pipes, waits for "native-ready",
// asks it for the audio/video device list, then stops it.

const { readConfig, createLogger } = require('./host/common');
const { EngineBridge } = require('./host/engine-bridge');

const cfg = readConfig();
if (!cfg.ok) {
  console.error(`Not set up: ${cfg.error}`);
  process.exit(1);
}

const log = createLogger(cfg.logDir, 'selftest.log');
const engine = new EngineBridge({
  engineExe: cfg.engineExe,
  engineCommand: cfg.engineCommand,
  transportKey: cfg.transportKey,
  logDir: cfg.logDir,
  log,
});
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
let gotReady = false;
let gotDevices = false;

engine.on('state', (s) => {
  if (s.ready && !gotReady) {
    gotReady = true;
    console.log(`[${elapsed()}] engine is ready (pipe handshake and encryption OK)`);
  }
});
engine.on('message', (msg) => {
  if (msg.type === 'response' && msg.command === 'listDevice') {
    gotDevices = true;
    const d = msg.data || {};
    const names = (list) => (Array.isArray(list) ? list.map((x) => x && (x.name || x.deviceName || x.id)).filter(Boolean) : []);
    console.log(`[${elapsed()}] device list received:`);
    for (const [k, v] of Object.entries(d)) {
      if (Array.isArray(v)) console.log(`  ${k}: ${names(v).join(' | ') || '(none)'}`);
    }
    finish(0);
  } else if (!(msg.type === 'update' && msg.command === 'callState')) {
    console.log(`[${elapsed()}] engine says ${msg.type}:${msg.command}`);
  }
});
engine.on('exit', (code) => {
  if (!gotDevices) {
    console.log(`[${elapsed()}] engine exited early (code ${code}). See ${cfg.logDir}\\selftest.log`);
    finish(1);
  }
});
engine.on('error', (e) => {
  console.log(`[${elapsed()}] error: ${e.message || e}`);
  finish(1);
});

engine.setInit({
  type: 'update',
  command: 'init',
  data: {
    local: { id: '0', avatar: '', name: 'Self-test' },
    mainWindowId: '0',
    clientVersion: 695,
    language: 'vi',
    timeoutMakeCall2ZRtp: 0,
    enablePreviewDeviceOutgoing: false,
    enablePreviewDeviceIncall: false,
    enableUnstableConnecting: false,
    autoAudioInput: true,
    autoAudioOutput: true,
    defaultAudInputDevice: null,
    defaultAudOutputDevice: null,
    defaultVidDevice: null,
  },
});
console.log(`Starting ${cfg.engineExe} (Zalo ${cfg.zaloVersion}) ...`);
engine.send({ type: 'request', command: 'listDevice', data: null });

const timer = setTimeout(() => {
  console.log(`[${elapsed()}] timed out: ${gotReady ? 'engine ready but no device list' : 'engine never became ready'}.`);
  console.log(`Details: ${cfg.logDir}\\selftest.log`);
  finish(1);
}, 30000);

let done = false;
function finish(code) {
  if (done) return;
  done = true;
  clearTimeout(timer);
  console.log(code === 0 ? 'Self-test passed.' : 'Self-test failed.');
  engine.dispose();
  setTimeout(() => process.exit(code), 800);
}
