'use strict';
// Shared helpers for the native host, the setup script and the self-test.

const fs = require('fs');
const path = require('path');

const NATIVE_DIR = path.resolve(__dirname, '..');
const ENGINE_DIR = path.join(NATIVE_DIR, 'engine');
const CONFIG_PATH = path.join(ENGINE_DIR, 'host-config.json');
const DEFAULT_LOG_DIR = path.join(NATIVE_DIR, 'logs');

const HOST_NAME = 'com.zalo_web_call.host';
const EXTENSION_ID = 'iogpmbjhpgejbjkegcdphbiepgcjcdab';
const HOST_VERSION = '0.1.0';

function readConfig() {
  // ZALO_WEB_CALL_CONFIG lets the tests point the host at a different config.
  const configPath = process.env.ZALO_WEB_CALL_CONFIG || CONFIG_PATH;
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    return { ok: false, error: `Missing or unreadable ${configPath}. Run native\\setup.cmd first.` };
  }
  const engineExe = cfg.engineExe || path.join(ENGINE_DIR, 'ZaloCall.exe');
  if (!cfg.transportKey) return { ok: false, error: 'host-config.json has no transportKey. Re-run setup.' };
  if (!fs.existsSync(engineExe)) return { ok: false, error: `Call engine not found at ${engineExe}. Re-run setup.` };
  return {
    ok: true,
    engineExe,
    // Optional command to launch instead of engineExe (the pipe names are appended).
    engineCommand: Array.isArray(cfg.engineCommand) && cfg.engineCommand.length ? cfg.engineCommand : null,
    transportKey: cfg.transportKey,
    logDir: cfg.logDir || DEFAULT_LOG_DIR,
    zaloVersion: cfg.zaloVersion || 'unknown',
    // Start ZaloCall.exe only when a call starts or rings (instead of when Zalo Web opens).
    lazyStart: cfg.lazyStart !== false,
    // Stop the idle engine after this many minutes without a call (0 = never).
    idleStopMinutes: Number.isFinite(cfg.idleStopMinutes) ? cfg.idleStopMinutes : 10,
    // Write message contents and the engine's console output to the logs. Off
    // by default: they contain user IDs, names and call details.
    debugLog: cfg.debugLog === true,
  };
}

// Small size-capped log file. Never write to stdout: it carries the
// native-messaging protocol.
function createLogger(logDir, name) {
  let file = null;
  try {
    fs.mkdirSync(logDir, { recursive: true });
    file = path.join(logDir, name);
    const st = fs.existsSync(file) ? fs.statSync(file) : null;
    if (st && st.size > 2 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch (e) {
    file = null;
  }
  return (...args) => {
    if (!file) return;
    const line = args
      .map((a) => (typeof a === 'string' ? a : a instanceof Error ? a.stack || a.message : safeJson(a)))
      .join(' ');
    try {
      fs.appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
    } catch (e) {
      /* ignore */
    }
  };
}

function safeJson(v) {
  try {
    return JSON.stringify(v);
  } catch (e) {
    return String(v);
  }
}

module.exports = {
  NATIVE_DIR,
  ENGINE_DIR,
  CONFIG_PATH,
  DEFAULT_LOG_DIR,
  HOST_NAME,
  EXTENSION_ID,
  HOST_VERSION,
  readConfig,
  createLogger,
  safeJson,
};
