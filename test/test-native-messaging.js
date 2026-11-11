'use strict';
// Full-chain test through Edge's real native messaging, using the fake engine:
//   page hook -> content script -> service worker -> Edge -> .cmd -> node host
//   -> named pipes -> fake engine -> ... and back.
// Temporarily registers the host for Edge (HKCU) and removes it afterwards.
//   node test/test-native-messaging.js <scratch dir>

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');

const HOST_NAME = 'com.zalo_web_call.host';
const KEY_PATH = `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`;
const EXT_ID = 'iogpmbjhpgejbjkegcdphbiepgcjcdab';
const scratch = path.resolve(process.argv[2] || path.join(__dirname, '.scratch', 'nm-test'));

function regQuery() {
  const r = spawnSync('reg.exe', ['query', KEY_PATH, '/ve'], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

const before = regQuery();
if (before) {
  console.log(`A host is already registered at ${KEY_PATH}; not touching it. Aborting.`);
  process.exit(2);
}

fs.rmSync(scratch, { recursive: true, force: true });
fs.mkdirSync(scratch, { recursive: true });
const key = crypto.randomBytes(16).toString('base64');
const config = path.join(scratch, 'host-config.json');
fs.writeFileSync(
  config,
  JSON.stringify({
    engineExe: process.execPath,
    engineCommand: [process.execPath, path.join(__dirname, 'fake-engine.js')],
    transportKey: key,
    logDir: path.join(scratch, 'logs'),
    lazyStart: true,
    idleStopMinutes: 0,
  }),
);
const cmd = path.join(scratch, 'test-host.cmd');
fs.writeFileSync(
  cmd,
  [
    '@echo off',
    `set "ZALO_WEB_CALL_CONFIG=${config}"`,
    `set "FAKE_ENGINE_KEY=${key}"`,
    `"${process.execPath}" "${path.join(__dirname, '..', 'native', 'host', 'zalo-call-host.js')}" %*`,
    '',
  ].join('\r\n'),
);
const manifest = path.join(scratch, `${HOST_NAME}.json`);
fs.writeFileSync(
  manifest,
  JSON.stringify({ name: HOST_NAME, description: 'test', path: cmd, type: 'stdio', allowed_origins: [`chrome-extension://${EXT_ID}/`] }, null, 2),
);

const add = spawnSync('reg.exe', ['add', KEY_PATH, '/ve', '/t', 'REG_SZ', '/d', manifest, '/f'], { encoding: 'utf8' });
if (add.status !== 0) {
  console.log('could not register test host', add.stderr);
  process.exit(1);
}
console.log('registered test host (will be removed)');

const probe = `
  const ask = (msg, want, ms = 8000) => new Promise((resolve) => {
    const t = setTimeout(() => { document.removeEventListener('zalo-web-call:to-page', on); resolve({ timeout: want }); }, ms);
    function on(e) {
      const m = JSON.parse(e.detail);
      if (want(m)) { clearTimeout(t); document.removeEventListener('zalo-web-call:to-page', on); resolve(m); }
    }
    document.addEventListener('zalo-web-call:to-page', on);
    if (msg) document.dispatchEvent(new CustomEvent('zalo-web-call:to-ext', { detail: JSON.stringify({ kind: 'host', msg }) }));
  });
`;

const child = spawn(process.execPath, [path.join(__dirname, 'test-page-hook.js'), path.join(scratch, 'profile'), '--extension', '--nm-chain'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, ZWC_NM_PROBE: probe },
});
let out = '';
child.stdout.on('data', (d) => {
  out += d;
  process.stdout.write(d);
});
child.stderr.on('data', (d) => process.stderr.write(d));
child.on('exit', (code) => {
  const del = spawnSync('reg.exe', ['delete', KEY_PATH, '/f'], { encoding: 'utf8' });
  console.log(del.status === 0 ? 'removed test host registration' : `WARNING: could not remove ${KEY_PATH}`);
  const hostLog = path.join(scratch, 'logs', 'host.log');
  if (fs.existsSync(hostLog)) {
    console.log('\nhost.log (last lines):');
    console.log(fs.readFileSync(hostLog, 'utf8').trim().split('\n').slice(-14).map((l) => `  ${l}`).join('\n'));
  }
  fs.rmSync(scratch, { recursive: true, force: true });
  process.exitCode = code;
});
