'use strict';
// Removes what setup added: the native messaging registration (Edge and
// Chrome keys), the extracted call engine, logs and generated host files.
// The extension folder itself is left alone; remove it from edge://extensions.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { NATIVE_DIR, ENGINE_DIR, DEFAULT_LOG_DIR, HOST_NAME } = require('./host/common');

for (const k of [
  `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`,
  `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`,
]) {
  const r = spawnSync('reg.exe', ['delete', k, '/f'], { encoding: 'utf8' });
  console.log(r.status === 0 ? `removed ${k}` : `not registered: ${k}`);
}

for (const p of [ENGINE_DIR, DEFAULT_LOG_DIR, path.join(NATIVE_DIR, '.setup-tmp'), path.join(NATIVE_DIR, 'host', `${HOST_NAME}.json`)]) {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { recursive: true, force: true });
      console.log(`deleted ${p}`);
    }
  } catch (e) {
    console.log(`could not delete ${p}: ${e.message} (is a call still running?)`);
  }
}
console.log('Done. Remove the extension itself from edge://extensions.');
