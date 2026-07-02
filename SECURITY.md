# corral — security model

corral is a **single-user, local** desktop tool. The backend (Node) does privileged things —
SSH command execution, local + remote file read/**write**, local process spawning, and port
tunnels — so access to it is the security boundary.

## Protections (enforced)

- **Loopback only.** The backend binds `127.0.0.1` (`CORRAL_BIND`; legacy `CODAPP_BIND` also
  honored), never `0.0.0.0`. It is not reachable from the LAN — unless the operator explicitly
  enables **remote access (phone pairing)**, which opens a *second*, separately-authenticated
  listener; see below.
- **Remote access is opt-in and pairing-token-gated.** The phone listener (default port 7879,
  `remote.js`) is off by default, toggled from the desktop UI, and torn down again on disable.
  Non-loopback callers must present the durable 32-byte pairing token — always, even in tokenless
  dev mode, and the desktop's per-run token is *not* accepted from the LAN. The pairing token and
  the machine's addresses are only ever revealed to loopback callers (`/api/remote`), so a remote
  client can't read the credential back; remote callers also cannot change remote-access settings.
  Allowed browser origins for the phone are restricted to private-network hosts (RFC 1918 +
  Tailscale CGNAT) — public origins stay blocked, so internet-side DNS rebinding still fails.
  Tradeoff: by default the transport is plain HTTP, so the pairing token and traffic are visible
  to the local network path — enable it on trusted networks only (home Wi-Fi, tailnet), and
  rotate the code from the pairing dialog if a phone is lost.
- **Optional TLS on the phone listener.** Point the pairing dialog's Transport settings at a PEM
  cert/key pair and the listener serves HTTPS/WSS instead (`tailscale cert` is the easy path on a
  tailnet; mkcert with its CA installed on the phone also works). A half-configured pair is
  rejected rather than silently falling back to plaintext. Self-signed certs encrypt the wire but
  phone browsers will warn; certs the phone actually trusts give the clean experience.
- **Per-run token.** The Tauri shell mints a 32-byte token and passes it to the sidecar via
  `CORRAL_TOKEN` (legacy `CODAPP_TOKEN` also honored). Every `/api/*` request must present it
  (constant-time compare). The WebView
  fetches it via the `get_token` IPC command. `<img>`/`<iframe>`/download GETs carry it as `?tk=`.
  In plain `npm start`/`npm run dev` (no token) the backend is permissive for local development.
- **Origin allowlist.** `/api/*` and WebSocket upgrades reject a present-but-foreign `Origin`;
  loopback origins (`localhost`/`127.0.0.1`/`::1`, any port) and `tauri.localhost` are allowed. A
  remote page cannot forge a loopback origin, so DNS-rebinding stays blocked.
- **WebSocket first-frame auth.** `/chat` (and `/ws`) spawn no process until a valid
  `{type:'auth',token}` frame arrives (when a token is configured).
- **Strict CSP.** The served HTML carries `script-src 'self'` (Vite bundles every dependency
  locally); only the Google font is off-origin (`style-src`/`font-src`). `object-src 'none'`,
  `base-uri 'self'`.
- **Host allowlist.** Remote operations are restricted to aliases from `~/.ssh/config`
  (`known()`), on every endpoint.
- **Injection-safe commands.**
  - Remote: every interpolated path/arg is single-quote-escaped (`shq`); selftests assert it
    neutralizes `; $(...)` backticks/newlines.
  - Local Claude / sidecar spawns use **argv arrays, `shell:false`** — never a shell string.
  - Claude launch hardening: permission mode is allowlisted (`bypassPermissions`/`dontAsk` are
    refused); model must be a bare token (no leading `-`) so it can't smuggle a CLI flag.
  - Uploads: the filename is reduced to `path.posix.basename(...)`, control/separator chars
    stripped, written to `<dest>.corral.part` then atomically renamed; 2 GiB cap.
- **Subscription lock.** Every `claude` child is spawned with `ANTHROPIC_API_KEY` deleted from its
  env and never `--bare`, so it can only authenticate via the user's OAuth/subscription. The Agent
  SDK (which forces API-key billing) is deliberately not used.
- **Tunnels** bind `127.0.0.1` only; "Open" is restricted to `http://127.0.0.1:<port>`. Orphaned
  ssh children are reaped on boot from a PID-file (ssh.exe image-checked) and on shutdown.

## Residual risks / accepted tradeoffs

- **The file browser exposes all of the user's own files** on a host — including sensitive ones
  like `~/.claude/.credentials.json`. This is by design (it's a file manager for *your* machines)
  and is gated by loopback + token, but worth being aware of.
- **`?tk=` puts the token in a URL** (may appear in logs/history). Accepted for a loopback,
  single-user tool; it only guards local file GETs.
- **Driving `claude` headless on a *remote* host under OAuth is a ToS gray area** (subscription
  OAuth is "personal use"; tokens expire 8–12h). Local use is squarely fine.
- **Headless-on-subscription is a *paused* Anthropic policy** (as of 2026-06) that could change;
  if it does, headless usage could move to metered API. corral can't prevent that, only avoid
  forcing API billing itself.
- **The installer is unsigned** → Windows SmartScreen will warn. Add an Authenticode cert before
  distributing beyond your own machine.

## Recommendations before wider distribution

- Code-sign the installer (Authenticode).
- Prune `node_modules/node-pty/prebuilds` to `win32-x64` to shrink the bundle.
- Consider vendoring the Newsreader font to drop the last off-origin asset (then CSP can omit the
  Google domains entirely).
