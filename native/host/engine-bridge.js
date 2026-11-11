'use strict';
// Talks to Zalo's own call engine (ZaloCall.exe from the Zalo PC package) the
// same way Zalo PC's Electron main process does:
//   * two named pipes, passed to ZaloCall.exe as argv: [recvPipe, sendPipe]
//     (we listen on both; the engine connects to them),
//   * every message is JSON, encrypted with AES-128-CBC (zero IV) under the
//     "call v2 transport" key, hex encoded and terminated by "$".
// The engine announces itself with {type:"update", command:"native-ready"};
// we then send the stored init data followed by anything queued meanwhile.
//
// Pipe security. Windows lets every account on the PC open these pipes for
// reading, Node cannot tighten that, and the AES key is the same in every Zalo
// install, so the encryption does not keep anyone out. Instead:
//   * every launch gets fresh, unguessable pipe names,
//   * each pipe accepts exactly one client (the engine) and then stops
//     listening, so nothing can connect while a call runs,
//   * nothing is written to the engine until it has said "native-ready" on the
//     other pipe, which an account with read-only access cannot do.

const net = require('net');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const IV = Buffer.alloc(16, 0);
// File paths the engine writes to. They always come from the helper, never
// from the web page.
const PATH_KEYS = ['logPath', 'zrtcLogPath', 'dumpPath'];

class EngineBridge extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.engineExe   full path of ZaloCall.exe
   * @param {string} opts.transportKey base64 AES-128 key
   * @param {string} opts.logDir      folder for the engine's own log files
   * @param {boolean} [opts.debug]    log message contents and engine output
   * @param {(…args:any[])=>void} [opts.log]
   * Events: 'message' (msg from engine), 'state' ({running, ready}), 'exit' (code)
   */
  constructor(opts) {
    super();
    this.engineExe = opts.engineExe;
    this.engineCommand = opts.engineCommand || null;
    this.key = Buffer.from(opts.transportKey, 'base64');
    if (this.key.length !== 16) throw new Error('transport key must be 16 bytes (AES-128)');
    this.logDir = opts.logDir;
    this.debug = !!opts.debug;
    this.log = opts.log || (() => {});

    this.recvPipe = null; // engine -> us
    this.sendPipe = null; // us -> engine
    this.recvServer = null;
    this.sendServer = null;
    this.sendSock = null;
    this.child = null;
    this.started = false; // like `L` in Zalo PC: spawn requested / running
    this.ready = false; // engine said native-ready
    this.initPending = false; // init data still to be sent after native-ready
    this.restartOnExit = false; // set after a "killMe" request
    this.stopping = false;
    this.initData = null; // like `D`
    this.queue = []; // like `P`
    this.recvBuffer = '';
  }

  // ---- crypto -------------------------------------------------------------
  encrypt(text) {
    const c = crypto.createCipheriv('aes-128-cbc', this.key, IV);
    return Buffer.concat([c.update(text, 'utf8'), c.final()]).toString('hex');
  }

  decrypt(hex) {
    const d = crypto.createDecipheriv('aes-128-cbc', this.key, IV);
    return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8');
  }

  // ---- public API (mirrors ipcMain "call-init" / "call-send-to-native") ----
  setInit(msg) {
    if (!msg || typeof msg !== 'object') return;
    const m = { ...msg };
    delete m._optional;
    this.initData = this.fillInitData(m);
  }

  send(msg) {
    if (!msg || typeof msg !== 'object') return;
    const m = { ...msg };
    if (m._optional) delete m._optional;
    else this.start();
    this.write(this.fillInitData(m));
  }

  stop() {
    this.restartOnExit = false;
    this.stopping = true;
    if (this.child) {
      try {
        this.child.kill();
      } catch (e) {
        /* ignore */
      }
    } else {
      this.closePipes();
    }
  }

  dispose() {
    this.stop();
    this.closePipes();
  }

  get running() {
    return !!this.child;
  }

  // True from the moment a launch is requested until the engine has exited.
  get active() {
    return this.started;
  }

  // ---- internals ------------------------------------------------------------
  // Init/update payloads carry file paths for the engine's logs and an OS
  // string, which Zalo PC fills from Electron/Node. The browser can't, so the
  // helper fills them in. Paths are overwritten in every message that carries
  // them, so a script on the web page cannot choose where the engine writes.
  fillInitData(msg) {
    const d = msg && msg.data;
    if (!d || typeof d !== 'object' || Array.isArray(d)) return msg;
    const isInit = msg.type === 'update' && ('local' in d || 'logPath' in d);
    if (!isInit && !PATH_KEYS.some((k) => k in d)) return msg;
    try {
      fs.mkdirSync(path.join(this.logDir, 'cal'), { recursive: true });
    } catch (e) {
      /* ignore */
    }
    const paths = {
      logPath: path.join(this.logDir, 'call.log'),
      zrtcLogPath: path.join(this.logDir, 'cal'),
      dumpPath: path.join(this.logDir, 'crash.dmp'),
    };
    const data = { ...d };
    for (const k of PATH_KEYS) if (isInit || k in d) data[k] = paths[k];
    if (isInit) {
      const cpu = (os.cpus() || [])[0] || { model: 'unknown', speed: 0 };
      data.osInfo = `${os.type()}_${os.release()}_${os.platform()}_${os.arch()};${cpu.model};${cpu.speed}`;
    }
    return { ...msg, data };
  }

  canWrite() {
    return this.ready && !!this.sendSock && !this.sendSock.destroyed;
  }

  write(msg) {
    if (this.canWrite()) {
      this.writeNow(msg);
      return;
    }
    // Until the engine is connected and ready, keep only the latest "update"
    // of each kind (init, language, device list, ...) and cap the queue.
    if (msg && msg.type === 'update') {
      this.queue = this.queue.filter((q) => !(q && q.type === 'update' && q.command === msg.command));
    }
    this.queue.push(msg);
    if (this.queue.length > 50) this.queue.splice(0, this.queue.length - 50);
  }

  // Sends the init data and the queue once the engine is both ready and connected.
  flush() {
    if (!this.canWrite()) return;
    if (this.initPending) {
      this.initPending = false;
      if (this.initData) this.writeNow(this.initData);
    }
    const queued = this.queue;
    this.queue = [];
    for (const m of queued) this.writeNow(m);
  }

  writeNow(msg) {
    const json = JSON.stringify(msg);
    this.log('-> engine', summarize(msg, this.debug));
    try {
      this.sendSock.write(`${this.encrypt(json)}$`);
    } catch (e) {
      this.log('write to engine failed', e);
    }
  }

  onEngineText(text) {
    this.recvBuffer += text;
    const parts = this.recvBuffer.split('$');
    this.recvBuffer = parts.pop();
    for (const part of parts) {
      if (!part) continue;
      let msg;
      try {
        msg = JSON.parse(this.decrypt(part).replace(/\0/g, ''));
      } catch (e) {
        this.log('cannot decode engine payload', e.message);
        continue;
      }
      this.onEngineMessage(msg);
    }
  }

  onEngineMessage(msg) {
    this.log('<- engine', summarize(msg, this.debug));
    if (msg.type === 'update' && msg.command === 'native-ready') {
      this.ready = true;
      this.initPending = true;
      this.flush();
      this.emit('state', { running: true, ready: true });
      return;
    }
    if (msg.type === 'request' && msg.command === 'killMe') {
      this.log('engine asked to be restarted');
      if (this.child) {
        this.restartOnExit = true;
        try {
          this.child.stdin.pause();
          this.child.kill('SIGINT');
        } catch (e) {
          /* ignore */
        }
      }
      return;
    }
    this.emit('message', msg);
  }

  // Like H() in Zalo PC: fall back to queueing and report the line as free.
  // The pipes no longer accept clients, so an engine that lost its pipe can't
  // reconnect: end it, and the next call starts a fresh one with fresh pipes.
  onPipeLost(which) {
    this.log(`${which} pipe ended`);
    this.sendSock = null;
    this.ready = false;
    this.emit('message', { type: 'update', command: 'callState', data: { state: 'free' } });
    if (this.child) {
      try {
        this.child.kill();
      } catch (e) {
        /* ignore */
      }
    }
  }

  onRecvClient(sock) {
    this.recvBuffer = '';
    sock.setEncoding('utf8');
    sock.on('data', (t) => this.onEngineText(t));
    sock.on('end', () => this.onPipeLost('recv'));
    sock.on('error', (e) => this.log('recv pipe error', e.message));
  }

  onSendClient(sock) {
    this.sendSock = sock;
    sock.on('data', () => {}); // engine never writes here
    sock.on('end', () => {
      if (this.sendSock === sock) this.onPipeLost('send');
    });
    sock.on('error', (e) => this.log('send pipe error', e.message));
    this.flush(); // native-ready may already have arrived on the recv pipe
  }

  // Listens on a pipe for exactly one client, then stops listening. Later
  // clients never connect: they wait for a pipe instance that never comes.
  listenOnce(pipePath, which, onClient) {
    return new Promise((resolve, reject) => {
      let taken = false;
      const server = net.createServer((sock) => {
        if (taken) {
          sock.destroy();
          return;
        }
        taken = true;
        server.close();
        this.log(`engine connected (${which} pipe)`);
        onClient(sock);
      });
      if (which === 'recv') this.recvServer = server;
      else this.sendServer = server;
      let listening = false;
      server.on('error', (e) => {
        if (listening) this.log(`${which} pipe server error`, e.message);
        else reject(e);
      });
      server.listen(pipePath, () => {
        listening = true;
        resolve();
      });
    });
  }

  openPipes() {
    this.closePipes();
    const tag = crypto.randomBytes(16).toString('hex');
    this.recvPipe = `\\\\.\\pipe\\ZaloWebCall-${tag}-recv`;
    this.sendPipe = `\\\\.\\pipe\\ZaloWebCall-${tag}-send`;
    return Promise.all([
      this.listenOnce(this.recvPipe, 'recv', (sock) => this.onRecvClient(sock)),
      this.listenOnce(this.sendPipe, 'send', (sock) => this.onSendClient(sock)),
    ]);
  }

  closePipes() {
    for (const s of [this.recvServer, this.sendServer]) {
      try {
        if (s && s.listening) s.close();
      } catch (e) {
        /* ignore */
      }
    }
    this.recvServer = null;
    this.sendServer = null;
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.stopping = false;
    this.openPipes()
      .then(() => {
        if (this.stopping) {
          this.started = false;
          this.closePipes();
          return;
        }
        this.spawnEngine();
      })
      .catch((e) => {
        this.started = false;
        this.closePipes();
        this.log('could not open pipes', e);
        this.emit('error', e);
      });
  }

  spawnEngine() {
    const [cmd, ...pre] = this.engineCommand || [this.engineExe];
    this.log('starting engine', cmd, ...pre);
    let child;
    try {
      child = spawn(cmd, [...pre, this.recvPipe, this.sendPipe], {
        cwd: path.dirname(this.engineExe),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: false,
      });
    } catch (e) {
      this.started = false;
      this.closePipes();
      this.log('spawn failed', e);
      this.emit('error', e);
      return;
    }
    this.child = child;
    this.emit('state', { running: true, ready: false });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // The engine's console output can include device names and network
    // details, so it is only logged in debug mode.
    const engineOutput = (label) => (t) => {
      if (!this.debug) return;
      const s = t.replace(/\r|\n/g, ' ').trim();
      if (s) this.log(`engine ${label}:`, s.slice(0, 500));
    };
    child.stdout.on('data', engineOutput('stdout'));
    child.stderr.on('data', engineOutput('stderr'));
    child.on('error', (e) => {
      this.log('engine process error', e);
      this.emit('error', e);
    });
    child.on('exit', (code, signal) => {
      this.log('engine exited', code, signal);
      this.child = null;
      this.started = false;
      this.ready = false;
      this.initPending = false;
      this.sendSock = null;
      this.closePipes(); // in case the engine exited before connecting
      this.emit('message', { type: 'update', command: 'callState', data: { state: 'free' } });
      this.emit('state', { running: false, ready: false });
      this.emit('exit', code);
      if (this.restartOnExit && !this.stopping) {
        this.restartOnExit = false;
        this.start();
      }
    });
  }
}

// For the log: only "type:command" unless debug logging is on, because message
// contents include user IDs, names and call details.
function summarize(msg, debug) {
  if (!msg || typeof msg !== 'object') return String(msg);
  const head = `${msg.type || '?'}:${msg.command != null ? msg.command : ''}`;
  if (!debug) return head;
  if (msg.type === 'update' && msg.data && typeof msg.data === 'object' && 'local' in msg.data) {
    return `${head} (init data)`;
  }
  let body = '';
  try {
    body = JSON.stringify(msg.data);
  } catch (e) {
    body = '';
  }
  return body && body.length > 300 ? `${head} ${body.slice(0, 300)}…` : `${head} ${body || ''}`;
}

module.exports = { EngineBridge, PATH_KEYS };
