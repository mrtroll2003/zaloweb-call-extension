'use strict';
// One-time setup for the Zalo Web Call helper.
//
//  1. Gets the official Zalo PC installer (downloads it from zalo.me, or uses
//     --installer <file>). Nothing is installed or run from it.
//  2. Unpacks only the call engine (ZaloCall.exe and the Qt/runtime DLLs it
//     needs) into native\engine, and reads the engine's pipe key from the
//     package's main.js. The installer and temporary files are deleted.
//  3. Checks that the installer and ZaloCall.exe are validly signed by VNG,
//     and the engine's MD5 against the one Zalo PC expects (CALL_NATIVE_HASH).
//  4. Registers the native messaging host for Microsoft Edge (current user).
//
// Usage: setup.cmd [--installer <ZaloSetup-x.y.z.exe>] [--chrome] [--no-register]
//                  [--engine-dir <dir>] [--keep-download] [--skip-signature-check]

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { NATIVE_DIR, ENGINE_DIR, DEFAULT_LOG_DIR, HOST_NAME, EXTENSION_ID } = require('./host/common');

const DOWNLOAD_PAGE = 'https://zalo.me/download/zalo-pc?utm=90000';
const HOST_DIR = path.join(NATIVE_DIR, 'host');

// Files from plugins\capture that belong to other Zalo tools, not the call engine.
const SKIP_FILES = new Set(['zavimeet.exe', 'zalocap.exe', 'zalo.exe', 'zavi_db.db']);
const SKIP_DIRS = new Set(['pdbs', 'translations']);

function parseArgs(argv) {
  const a = { chrome: false, register: true, keepDownload: false, checkSignature: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--installer') a.installer = argv[++i];
    else if (k === '--engine-dir') a.engineDir = argv[++i];
    else if (k === '--chrome') a.chrome = true;
    else if (k === '--no-register') a.register = false;
    else if (k === '--keep-download') a.keepDownload = true;
    else if (k === '--skip-signature-check') a.checkSignature = false;
    else if (k === '--help' || k === '-h') a.help = true;
    else throw new Error(`Unknown option: ${k}`);
  }
  return a;
}

const say = (...m) => console.log(...m);
function fail(msg) {
  const e = new Error(msg);
  e.userFacing = true;
  throw e;
}

function find7zip() {
  const candidates = [
    path.join(process.env.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', '7-Zip', '7z.exe'),
    path.join(process.env.ProgramW6432 || 'C:\\Program Files', '7-Zip', '7z.exe'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  const r = spawnSync('where', ['7z'], { encoding: 'utf8' });
  if (r.status === 0) {
    const first = r.stdout.split(/\r?\n/).find(Boolean);
    if (first && fs.existsSync(first.trim())) return first.trim();
  }
  return null;
}

function run7z(sevenZip, args, what) {
  const r = spawnSync(sevenZip, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) fail(`7-Zip failed while ${what}:\n${(r.stderr || r.stdout || '').slice(0, 2000)}`);
  return r.stdout;
}

// Paths inside an archive, from `7z l -slt`.
function listArchive(sevenZip, archive) {
  const out = run7z(sevenZip, ['l', '-slt', '-ba', archive], `listing ${path.basename(archive)}`);
  return out
    .split(/\r?\n/)
    .filter((l) => l.startsWith('Path = '))
    .map((l) => l.slice(7));
}

function get(url, redirectsLeft = 8) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        return resolve(get(new URL(res.headers.location, url).toString(), redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      resolve({ res, url });
    });
    req.on('error', reject);
    req.setTimeout(60000, () => req.destroy(new Error('network timeout')));
  });
}

async function download(dest) {
  say(`Downloading the official Zalo PC installer (about 200 MB) from ${DOWNLOAD_PAGE}`);
  const { res, url } = await get(DOWNLOAD_PAGE);
  const host = new URL(url).hostname;
  if (!/(^|\.)zadn\.vn$|(^|\.)zalo\.me$|(^|\.)zdn\.vn$/.test(host)) {
    res.resume();
    fail(`Unexpected download host ${host}; refusing to continue.`);
  }
  const total = Number(res.headers['content-length']) || 0;
  const file = path.join(dest, path.basename(new URL(url).pathname) || 'ZaloSetup.exe');
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(file);
    let got = 0;
    let lastPct = -1;
    res.on('data', (c) => {
      got += c.length;
      if (total) {
        const pct = Math.floor((got * 100) / total);
        if (pct !== lastPct && pct % 5 === 0) {
          process.stdout.write(`\r  ${pct}% (${(got / 1048576).toFixed(0)} MB)   `);
          lastPct = pct;
        }
      }
    });
    res.pipe(out);
    out.on('finish', resolve);
    out.on('error', reject);
    res.on('error', reject);
  });
  process.stdout.write('\n');
  if (total && fs.statSync(file).size !== total) fail('Download was incomplete. Please run setup again.');
  return file;
}

// Minimal reader for Electron's .asar format: returns the bytes of one file.
function readFromAsar(asarPath, innerPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    const head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    const headerPickleSize = head.readUInt32LE(4);
    const jsonLen = head.readUInt32LE(12);
    const json = Buffer.alloc(jsonLen);
    fs.readSync(fd, json, 0, jsonLen, 16);
    const header = JSON.parse(json.toString('utf8'));
    const dataStart = 8 + headerPickleSize;
    let node = header;
    for (const part of innerPath.split('/')) {
      node = node && node.files && node.files[part];
      if (!node) return null;
    }
    if (node.unpacked) return null;
    const buf = Buffer.alloc(node.size);
    fs.readSync(fd, buf, 0, node.size, dataStart + Number(node.offset));
    return buf;
  } finally {
    fs.closeSync(fd);
  }
}

function md5(file) {
  return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');
}

function checkSignature(file) {
  const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; ` +
    "[pscustomobject]@{ Status = [string]$s.Status; Subject = [string]$s.SignerCertificate.Subject } | ConvertTo-Json -Compress";
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' });
  try {
    return JSON.parse(r.stdout.trim());
  } catch (e) {
    return { Status: 'Unknown', Subject: (r.stderr || '').trim() };
  }
}

// The exact certificate names VNG signs Zalo with (the installer and
// ZaloCall.exe use the first). A substring test like /VNG/ would also accept
// certificates such as "CN=NotVNG".
const VNG_SIGNERS = new Set(['VNG GROUP JSC', 'VNG Corporation']);

function signerName(subject) {
  const m = /(?:^|,\s*)CN=([^,]+)/.exec(subject || '');
  return m ? m[1].trim() : '';
}

function signedByVng(sig) {
  return !!sig && sig.Status === 'Valid' && VNG_SIGNERS.has(signerName(sig.Subject));
}

function copyTree(src, dst, stats) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    const lower = ent.name.toLowerCase();
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(lower)) continue;
      copyTree(s, d, stats);
    } else {
      if (SKIP_FILES.has(lower) || lower.endsWith('.pdb')) continue;
      fs.copyFileSync(s, d);
      stats.files++;
      stats.bytes += fs.statSync(d).size;
    }
  }
}

function engineIsRunning(engineDir) {
  const exe = path.join(engineDir, 'ZaloCall.exe');
  if (!fs.existsSync(exe)) return false;
  try {
    // Renaming fails while the exe is running.
    fs.renameSync(exe, `${exe}.chk`);
    fs.renameSync(`${exe}.chk`, exe);
    return false;
  } catch (e) {
    return true;
  }
}

function findNode() {
  return process.execPath; // the node.exe running this script
}

function writeHostFiles() {
  const nodeExe = findNode();
  const cmd = path.join(HOST_DIR, 'zalo-call-host.cmd');
  fs.writeFileSync(
    cmd,
    ['@echo off', 'rem Generated by setup. Edge starts this for the Zalo Web Call extension.', `"${nodeExe}" "%~dp0zalo-call-host.js" %*`, ''].join('\r\n'),
  );
  const manifestPath = path.join(HOST_DIR, `${HOST_NAME}.json`);
  const manifest = {
    name: HOST_NAME,
    description: 'Zalo Web Call helper (starts Zalo\'s call engine for chat.zalo.me)',
    path: cmd,
    type: 'stdio',
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { cmd, manifestPath };
}

function register(manifestPath, alsoChrome) {
  const keys = [`HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${HOST_NAME}`];
  if (alsoChrome) keys.push(`HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`);
  for (const k of keys) {
    const r = spawnSync('reg.exe', ['add', k, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], { encoding: 'utf8' });
    if (r.status !== 0) fail(`Could not write registry key ${k}:\n${r.stderr || r.stdout}`);
    say(`  registered ${k}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    say(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 16).join('\n'));
    return;
  }
  if (process.platform !== 'win32') fail('This helper only works on Windows.');

  const engineDir = path.resolve(args.engineDir || ENGINE_DIR);
  const sevenZip = find7zip();
  if (!sevenZip) fail('7-Zip is required to unpack the Zalo installer. Install it from https://www.7-zip.org/ and run setup again.');
  if (engineIsRunning(engineDir)) fail('ZaloCall.exe is running. Close your Zalo Web tabs (or end the call) and run setup again.');

  const tmp = path.join(path.dirname(engineDir), '.setup-tmp');
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });

  try {
    // 1. installer
    let installer = args.installer ? path.resolve(args.installer) : null;
    if (installer) {
      if (!fs.existsSync(installer)) fail(`Installer not found: ${installer}`);
      say(`Using installer ${installer}`);
    } else {
      installer = await download(tmp);
    }
    // The installer's signature also covers the packed files inside it, so this
    // check protects the unsigned Qt DLLs that ZaloCall.exe loads.
    const insSig = checkSignature(installer);
    say(`Installer signature: ${insSig.Status} (${insSig.Subject || 'no signer'})`);
    if (args.checkSignature && !signedByVng(insSig)) {
      fail('The installer is not validly signed by VNG. Stopping. (Use --skip-signature-check only if you know why.)');
    }

    // 2. inner app package (NSIS payload)
    const inner = listArchive(sevenZip, installer).find((p) => /(^|\\)app-(32|64)\.7z$/i.test(p));
    if (!inner) fail('Could not find the app package inside the installer. The installer format may have changed.');
    say(`Unpacking ${inner} ...`);
    run7z(sevenZip, ['e', '-y', `-o${tmp}`, installer, inner], 'extracting the app package');
    const appPkg = path.join(tmp, path.basename(inner));

    const entries = listArchive(sevenZip, appPkg);
    const exeEntry = entries.find((p) => /\\plugins\\capture\\ZaloCall\.exe$/i.test(p));
    const asarEntry = entries.find((p) => /\\resources\\app\.asar$/i.test(p));
    if (!exeEntry || !asarEntry) fail('ZaloCall.exe or app.asar not found in the Zalo package. The package layout may have changed.');
    const top = exeEntry.split('\\')[0]; // e.g. Zalo-26.11.11
    const zaloVersion = (top.match(/(\d+\.\d+\.\d+)/) || [])[1] || top;
    const captureDir = `${top}\\plugins\\capture`;
    say(`Zalo package version ${zaloVersion}; extracting the call engine ...`);
    run7z(sevenZip, ['x', '-y', `-o${path.join(tmp, 'pkg')}`, appPkg, `${captureDir}\\*`, asarEntry], 'extracting the call engine');
    fs.rmSync(appPkg, { force: true });

    // 3. key + expected hash from the desktop app's main process code
    const mainJs = readFromAsar(path.join(tmp, 'pkg', asarEntry), 'main-dist/main.js');
    if (!mainJs) fail('main-dist/main.js not found in app.asar. The package layout may have changed.');
    const src = mainJs.toString('utf8');
    const keyMatch = /callV2TransportAesKey\s*:\s*"([A-Za-z0-9+/=]+)"/.exec(src);
    if (!keyMatch || Buffer.from(keyMatch[1], 'base64').length !== 16) fail('Could not find the call engine key in this Zalo version.');
    const hashMatch = /CALL_NATIVE_HASH\s*:\s*"([0-9a-f]{32})"/.exec(src);

    const srcCapture = path.join(tmp, 'pkg', captureDir);
    const engineExeTmp = path.join(srcCapture, 'ZaloCall.exe');
    const exeMd5 = md5(engineExeTmp);
    if (hashMatch) {
      if (hashMatch[1] !== exeMd5) fail(`ZaloCall.exe hash ${exeMd5} does not match the hash Zalo PC expects (${hashMatch[1]}).`);
      say(`ZaloCall.exe MD5 matches Zalo PC's expected hash (${exeMd5}).`);
    } else {
      say('Note: this Zalo version has no CALL_NATIVE_HASH to compare against.');
    }
    const sig = checkSignature(engineExeTmp);
    say(`ZaloCall.exe signature: ${sig.Status} (${sig.Subject || 'no signer'})`);
    if (args.checkSignature && !signedByVng(sig)) {
      fail('ZaloCall.exe is not validly signed by VNG. Stopping. (Use --skip-signature-check only if you know why.)');
    }

    // 4. install engine files
    fs.rmSync(engineDir, { recursive: true, force: true });
    const stats = { files: 0, bytes: 0 };
    copyTree(srcCapture, engineDir, stats);
    const logDir = args.engineDir ? path.join(path.dirname(engineDir), 'logs') : DEFAULT_LOG_DIR;
    const config = {
      engineExe: path.join(engineDir, 'ZaloCall.exe'),
      transportKey: keyMatch[1],
      logDir,
      zaloVersion,
      lazyStart: true,
      idleStopMinutes: 10,
      installedAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(engineDir, 'host-config.json'), JSON.stringify(config, null, 2));
    say(`Installed the call engine: ${stats.files} files, ${(stats.bytes / 1048576).toFixed(1)} MB in ${engineDir}`);

    // 5. native messaging host
    if (args.register) {
      const { manifestPath } = writeHostFiles();
      register(manifestPath, args.chrome);
    } else {
      say('Skipped host registration (--no-register).');
    }

    if (args.keepDownload && !args.installer) {
      const keep = path.join(path.dirname(engineDir), path.basename(installer));
      fs.renameSync(installer, keep);
      say(`Kept the installer at ${keep}`);
    }
    say('');
    say('Done. Next: load the extension folder in Edge (edge://extensions, Developer mode,');
    say('"Load unpacked" -> the "extension" folder), then reload chat.zalo.me.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error(`\nSetup failed: ${e.userFacing ? e.message : e.stack || e}`);
    process.exitCode = 1;
  });
}

module.exports = { checkSignature, signerName, signedByVng };
