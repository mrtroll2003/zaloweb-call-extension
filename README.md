# Zalo Web Call (unofficial)

An Edge extension that adds Zalo voice and video calls to Zalo Web
(chat.zalo.me): the call buttons appear in the chat header like in the Windows
app, incoming calls ring, and calls run in Zalo's own call window.

It is not made by or affiliated with Zalo/VNG.

## How it works

Zalo Web and the Zalo PC app are built from the same code. Zalo Web already
contains the PC app's call module and all of the call signalling (request,
ring, answer, end, ...) over Zalo's normal API, but switched off. The audio and
video are not done in JavaScript. The PC app hands them to a separate program,
`ZaloCall.exe`, which sends raw RTP over UDP to Zalo's media servers. A browser
cannot open UDP sockets, so no extension can carry the call media on its own.

So this project has two parts:

```
chat.zalo.me tab                         your PC
┌──────────────────────────┐   native    ┌──────────────────────┐   2 named pipes  ┌──────────────┐
│ Zalo Web + extension     │ messaging   │ helper (Node.js,     │  (AES, same as   │ ZaloCall.exe │
│ • Zalo's call module on  │ ──────────▶ │ native\host)         │  Zalo PC uses)   │ (Zalo's own  │
│ • call buttons in header │ ◀────────── │ starts/stops engine  │ ◀──────────────▶ │ call window) │
│ • signalling via Zalo API│             └──────────────────────┘                  └──────────────┘
```

1. The extension switches Zalo Web's call module on and connects its stubbed
   `$zcall` bridge to the helper. Zalo's own header then shows the voice and
   video buttons.
2. The helper takes the place of the Zalo PC app's main process. It starts
   `ZaloCall.exe` when you place a call or one comes in, and passes messages
   both ways.
3. `ZaloCall.exe` is taken from the official Zalo PC installer. The setup
   script extracts only the call engine (about 64 MB) and checks it. The full
   Zalo app is never installed or run.

## Install (once)

Requirements: Windows, Microsoft Edge, [Node.js](https://nodejs.org/) and
[7-Zip](https://www.7-zip.org/).

1. **Set up the helper.** Run `native\setup.cmd`. It:
   - downloads the official Zalo PC installer (about 210 MB) into a temporary
     folder next to the script, without running it,
   - extracts `ZaloCall.exe` and the Qt/runtime DLLs it needs into
     `native\engine` (about 64 MB),
   - checks that the installer and `ZaloCall.exe` are validly signed by VNG
     (setup stops if not), and that `ZaloCall.exe` matches the MD5 that Zalo
     PC itself expects,
   - registers the helper with Edge for your Windows user, and
   - deletes the installer and the temporary files.

   If you already have the installer, run
   `native\setup.cmd --installer path\to\ZaloSetup-x.y.z.exe` instead.
2. **Load the extension.** Go to `edge://extensions`, turn on *Developer mode*,
   click *Load unpacked* and choose the `extension` folder.
3. **Reload chat.zalo.me.**
4. Optional: run `native\selftest.cmd`. It starts the call engine, checks the
   pipe handshake and lists your microphones, speakers and cameras. No Zalo
   account is needed.

## Use

- **Call buttons** sit in the chat header, as in Zalo PC: voice call (1-to-1
  chats with friends) and video call.
- **Gọi lại / Call back** on call bubbles places the same kind of call again.
- **Incoming calls** ring in Zalo's call window while a Zalo Web tab is open.
- The call window has accept/decline, mute, camera, device choice and hang-up.
  It is the same window as in Zalo PC.
- The engine starts only when needed. It stops after 10 idle minutes, and when
  you close the Zalo Web tab.

The toolbar button shows the status: whether Zalo's call module is switched on,
whether the helper is connected, and whether the engine is running.

## Settings

`native\engine\host-config.json` (written by setup):

| key               | default | meaning                                                          |
|-------------------|---------|------------------------------------------------------------------|
| `lazyStart`       | `true`  | start `ZaloCall.exe` only for a call (not when Zalo Web opens)   |
| `idleStopMinutes` | `10`    | stop the engine after this many minutes without a call (0 = never) |
| `debugLog`        | `false` | also log message contents and the engine's console output to `host.log`. These include user IDs, names and call details, so turn it on only for troubleshooting. |

## When something doesn't work

- Toolbar popup shows the helper as *not found*: `native\setup.cmd` hasn't
  been run, or the `zalo-ext` folder was moved afterwards. Run setup again.
- DevTools console on chat.zalo.me: `__zaloWebCall.diag()` shows which Zalo
  internals were found. Messages from the extension start with `[Zalo Web Call]`.
- Logs: `native\logs\host.log` (helper), plus `call.log` and `cal\` (written by
  `ZaloCall.exe`). By default `host.log` records only message types; set
  `"debugLog": true` (see Settings) for details.
- **After a Zalo update:** re-run `native\setup.cmd` to get the matching engine.
  If Zalo reorganises Zalo Web's code, the page hook may stop finding its hook
  points. `diag()` shows which one is missing.

## Security notes

- **Who can use the helper.** Edge starts it only for this extension (its ID is
  the only one in the helper's `allowed_origins`). The extension only runs on
  chat.zalo.me, and its service worker only takes connections from that site.
- **What the page can send.** The helper passes on only the message types
  Zalo's call module uses, and it always sets the engine's file paths (logs,
  crash dumps) itself. The page cannot choose where the engine writes.
- **The pipes to `ZaloCall.exe`.** Windows lets every account on the PC open
  these named pipes for reading, Node.js cannot restrict that, and the
  encryption key is the same in every Zalo install. So the helper uses new
  random pipe names for every launch, accepts one connection per pipe (the
  engine's), stops listening once the engine has connected, and sends nothing
  until the engine reports ready. What remains: while the engine starts (about
  2-4 seconds), another account signed in to the same PC that is watching for
  these pipes could take the engine's place. The call would then fail, and that
  account could see your Zalo user ID, display name and who you were calling.
  Once the engine is connected, nothing else can connect.
- **The engine is Zalo's.** `ZaloCall.exe` and its DLLs come unchanged from
  Zalo's installer. They include OpenSSL 1.0.2g (2016), which only Zalo can
  update. Setup refuses an installer or engine that isn't validly signed by VNG.
- **Logs.** `host.log` keeps only message types unless `debugLog` is on.
  `ZaloCall.exe` writes its own logs (`call.log`, `cal\`) to `native\logs`, as
  in Zalo PC. `native\uninstall.cmd` deletes them.

## Uninstall

Run `native\uninstall.cmd`. It removes the Edge registration, the engine and the
logs. Then remove the extension in `edge://extensions`.

## Status: what is tested and what isn't

Tested on Windows 11 with Microsoft Edge (scripts in `test\`):

- `test-host.js`: the helper with a fake engine that speaks ZaloCall.exe's pipe
  protocol (taken from Zalo PC's main process). Covers native-messaging framing,
  lazy start, the handshake, AES framing including split frames, the order of
  init data, signal relay, the restart on `killMe`, and clean shutdown.
- `test-page-hook.js`: the page hook against the **live chat.zalo.me code** in
  headless Edge, both injected and as the loaded extension. The login page still
  works, all hook points are found and patched in the current Zalo build, and
  messages flow in both directions.
- `test-native-messaging.js`: the whole chain through Edge's real native
  messaging (page → extension → Edge → helper → fake engine → back).
- `test-security.js`: other clients can't connect to the engine pipes or get
  data from them, the page can't set the engine's file paths, messages that
  shouldn't launch the engine don't, `host.log` keeps no call details, and
  setup's VNG signature check (also on the real files, if set up).
- `setup.js` was run against the real installer (26.11.11). The engine was
  extracted, its hash and signature checked, and the key found.
- `native\selftest.cmd` with the real `ZaloCall.exe` (26.11.11): the pipe
  handshake and encryption work and the engine lists the PC's microphones,
  speakers and cameras.

**Not tested yet**, because it needs a Zalo login and a second person to call:

- A real call end to end.
- Whether Zalo's servers accept call signalling from a Zalo Web session.
  Zalo Web has the `voice_call` API domain in its login data, which is a good
  sign. Also whether they deliver incoming-call events to Zalo Web.
- Group calls: wired the same way as Zalo PC, but they only work if Zalo has
  enabled them for your account (`enable_group_call_for_user`).

Using an unofficial client is against the spirit of Zalo's terms, and it is
possible (though not known) that Zalo notices or restricts it. Use your own
judgement.
