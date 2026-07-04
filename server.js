const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const { promisify } = require('util');
const { WebSocketServer } = require('ws');
// node-pty is a native module and the ONLY one the backend uses. It backs just the /ws terminal
// bridge; agent sessions (/chat) and events (/events) are pure pipes. On platforms where the
// prebuilt binary is absent (e.g. an on-device Android build), load it optionally so the whole
// backend still boots — only the raw terminal is disabled.
let pty = null;
try { pty = require('node-pty'); }
catch (e) { console.warn('[terminal] node-pty unavailable — /ws terminal disabled:', e.message); }
const crypto = require('crypto');
const chat = require('./chat');
const tunnels = require('./tunnels');
const pushCfg = require('./push');
const webpush = require('./webpush');
const remoteCfg = require('./remote');
const queue = require('./queue');
const demo = process.env.CORRAL_DEMO === '1' ? require('./demo') : null;

const SELFTEST = process.argv[2] === 'selftest';
const execFileAsync = promisify(execFile);
const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

// --- security primitives (Phase 0) ---
// CORRAL_TOKEN is minted by the Tauri shell at launch; when empty (plain `npm start`) auth is
// permissive so local dev still works. Loopback bind + Origin allowlist are the other layers.
// CODAPP_* names are accepted as compatibility aliases from the pre-rename era.
const TOKEN = process.env.CORRAL_TOKEN || process.env.CODAPP_TOKEN || '';
const ORIGINS = new Set(['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost']);
function eqTok(provided, expected) {
  if (!expected) return true;            // no token configured => dev mode, allow
  if (!provided) return false;
  const a = Buffer.from(String(provided)), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const tokenEq = provided => eqTok(provided, TOKEN);
// Who may use which token (pure -> selftested): loopback callers use the per-run desktop token
// (dev-permissive when none is set); anything arriving over the LAN listener must present the
// durable pairing token — ALWAYS, even in tokenless dev, and never the per-run token (it's in
// the desktop webview's URL history).
function tokenVerdict({ provided, loopback, runToken, remote }) {
  if (loopback) return eqTok(provided, runToken);
  return !!(remote && remote.enabled && remote.token) && eqTok(provided, remote.token);
}
const reqTokenOk = (req, provided) => tokenVerdict({
  provided,
  loopback: remoteCfg.isLoopbackAddr(req.socket && req.socket.remoteAddress),
  runToken: TOKEN,
  remote: remoteCfg.get(),
});
// Does a fresh socket need a first-frame auth before it may do anything? (WS handlers)
const needsAuth = req => (remoteCfg.isLoopbackAddr(req.socket && req.socket.remoteAddress) ? !!TOKEN : true);
const bearer = req => { const h = req.headers['authorization'] || ''; return h.startsWith('Bearer ') ? h.slice(7) : ''; };
// Token lookup order: dedicated header, Authorization: Bearer, then ?tk= — the query form stays
// because plain <a href> downloads and WS URLs can't set headers.
const reqToken = (req, url) => req.headers['x-corral-token'] || req.headers['x-codapp-token'] || bearer(req) || url.searchParams.get('tk') || '';
// A present Origin must be allowed: the Tauri webview, or any loopback origin (the app served from
// 127.0.0.1/localhost, including the Vite dev server). A remote page (evil.com) can't forge a
// loopback Origin — the browser sets it from the page's real origin — so DNS-rebinding stays
// blocked. An absent Origin (native / same-process) is allowed but still token-gated.
const LOOPBACK_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// With remote access enabled, a page served to the phone (private-network origin) is allowed too;
// public origins stay blocked, so DNS rebinding from the internet still can't reach us.
const originAllowed = origin => !origin || ORIGINS.has(origin) || LOOPBACK_ORIGIN.test(origin)
  || (remoteCfg.get().enabled && remoteCfg.isPrivateOrigin(origin));
// Reject path traversal / NUL / control chars; only absolute or ~-rooted remote paths are valid.
function validRemotePath(p) {
  if (typeof p !== 'string' || !p || p.includes('\0') || /[\x00-\x1f]/.test(p)) return false;
  if (p.split('/').some(seg => seg === '..')) return false;
  return p.startsWith('/') || p.startsWith('~');
}
// A user-supplied new name (mkdir/rename) must be one path segment — strip directory parts and
// control chars, then reject empties and traversal. Mirrors the upload-leaf guard.
function safeLeaf(name) {
  const leaf = path.posix.basename(String(name || '')).replace(/[\\/\x00-\x1f]/g, '');
  return (!leaf || leaf === '..' || leaf === '.') ? '' : leaf;
}
// Never recursively delete a filesystem or drive root, whatever path we were handed.
function protectedRoot(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  return !s || s === '~' || p === '/' || /^[A-Za-z]:$/.test(s);
}
function buildLocalArchiveArgs(p) {
  return ['-czf', '-', '-C', path.dirname(p), '--', path.basename(p)];
}

// node-pty on Windows needs an absolute exe path (no PATH search), so resolve ssh once.
const SSH = (() => {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ssh']).toString().split(/\r?\n/)[0].trim() || 'ssh'; }
  catch { return 'ssh'; }
})();
// Local terminal shell: PowerShell 7 when present, classic powershell otherwise; $SHELL on POSIX.
const LOCAL_SHELL = (() => {
  if (process.platform !== 'win32') return process.env.SHELL || 'bash';
  try { return execFileSync('where', ['pwsh']).toString().split(/\r?\n/)[0].trim() || 'powershell.exe'; }
  catch { return 'powershell.exe'; }
})();
// What one /ws terminal socket spawns (pure -> selftested): a local shell on this machine, plain
// interactive ssh on a remote (optionally cd'ing into a project first), or a tmux attach.
function buildTermSpawn({ host, target, cwd } = {}) {
  if (!host || host === 'local') return { bin: LOCAL_SHELL, args: [], cwd: cwd || undefined };
  if (target) return { bin: SSH, args: ['-tt', host, `tmux attach -t ${shq(target)}`], cwd: undefined };
  if (cwd) return { bin: SSH, args: ['-tt', host, `cd ${shq(cwd)} && exec "$SHELL" -l`], cwd: undefined };
  return { bin: SSH, args: ['-tt', host], cwd: undefined };
}

// Worktree launch argv (pure -> selftested) now lives in queue.js — the overnight ranch and the
// one-off worktree launch share the same corral/<slug>-<ts36> branch-next-to-the-repo recipe.
const { buildWorktreeArgs } = queue;

// Hosts come from ~/.ssh/config Host aliases (skip wildcards). servers.json, if present,
// is just an optional extra list of alias strings. No keys/users here — ssh already knows.
function parseHosts(text) {
  return [...text.matchAll(/^\s*Host\s+(.+)$/gim)]
    .flatMap(m => m[1].trim().split(/\s+/))
    .filter(h => h && !/[*?!]/.test(h));
}
function loadHosts() {
  let fromCfg = [];
  try {
    const cfg = path.join(os.homedir(), '.ssh', 'config');
    if (fs.existsSync(cfg)) fromCfg = parseHosts(fs.readFileSync(cfg, 'utf8'));
  } catch (e) { console.error('[loadHosts] ssh config:', e.message); }
  let extra = [];
  try {
    const extraPath = path.join(__dirname, 'servers.json');
    if (fs.existsSync(extraPath)) { const parsed = JSON.parse(fs.readFileSync(extraPath, 'utf8')); if (Array.isArray(parsed)) extra = parsed; }
  } catch (e) { console.error('[loadHosts] servers.json (ignored):', e.message); }   // malformed file must not crash startup/refresh
  return [...new Set([...fromCfg, ...extra])];
}
let hosts = loadHosts();
const known = () => new Set(hosts);
function jsonError(res, status, error) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  return res.end(JSON.stringify({ ok: false, error }));
}
function listPathError(host, dir) {
  if (host === 'local') {
    if (!dir) return 'Path is required.';
    try { if (!fs.existsSync(dir)) return 'Path does not exist.'; }
    catch { return 'Path is not accessible.'; }
    return '';
  }
  if (!known().has(host)) return 'Unknown host.';
  if (!validRemotePath(dir)) return 'Remote path must start with / or ~ and cannot contain traversal.';
  return '';
}

// Serve the built Svelte app from dist/ (run `npm run build`; the Tauri bundle builds it for you).
// For frontend dev use `npm run dev` (Vite) instead of serving through this server.
const WEBROOT = path.join(__dirname, 'dist');
function insideDir(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

// CSP for the served HTML (applies when the Node server serves it — packaged app / `npm start`).
// script-src is strict 'self' (Vite bundles every dep locally); the only off-origin asset is the
// Google font. style 'unsafe-inline' is needed for the inline styles in sanitized/streamed HTML.
// connect-src allows any host: the page may be served from a LAN address (phone pairing) so the
// socket host can't be pinned, and a phone page paired with MORE ranches (0.6) fetches the other
// corral servers directly. ws(s) was always open, so http(s) adds no new exfil channel an XSS
// didn't already have; each ranch still enforces its own token + Origin allowlist.
const CSP = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' http: https: ws: wss:; frame-src 'self'; object-src 'none'; base-uri 'self'";

// --- pooled remote exec: one persistent `ssh <host> bash` per host, so file browsing, probes,
// and file ops pay the ssh handshake once instead of per request. Jobs are serialized per host;
// each command is followed by an RS-framed exit marker so the channel splits outputs. The channel
// closes after 2 idle minutes and respawns on demand; streaming transfers (cat/tar/upload) and
// PTYs keep their own dedicated ssh processes.
const POOL_IDLE_MS = 120000;
// pure (selftested): does the stream end with an exit marker? -> { done, stdout, code }
function poolParse(buf) {
  const m = buf.match(/\x1e(\d+)\x1e\n?$/);
  if (!m) return { done: false };
  return { done: true, stdout: buf.slice(0, m.index), code: +m[1] };
}
const sshPools = new Map();   // host -> { proc, queue, job, buf, err, idleTimer }
function poolFail(p, host, err) {
  const jobs = [p.job, ...p.queue].filter(Boolean);
  p.job = null; p.queue = [];
  if (sshPools.get(host) === p) sshPools.delete(host);
  try { p.proc.kill(); } catch (e) {}
  for (const j of jobs) { clearTimeout(j.timer); j.reject(err); }
}
function poolNext(host, p) {
  if (p.job || !p.queue.length) return;
  const j = p.job = p.queue.shift();
  p.buf = ''; p.err = '';
  j.timer = setTimeout(() => poolFail(p, host, Object.assign(new Error('Command timed out: ssh ' + host + ' ' + j.cmd), { stderr: p.err })), j.timeout);
  j.timer.unref?.();
  try { p.proc.stdin.write(j.cmd + '\nprintf "\\x1e%d\\x1e\\n" "$?"\n'); }
  catch (e) { poolFail(p, host, e); }
}
function poolSettle(host, p) {
  const r = poolParse(p.buf);
  if (!r.done || !p.job) return;
  const j = p.job;
  p.job = null; clearTimeout(j.timer);
  p.idleTimer = setTimeout(() => { if (!p.job && !p.queue.length) poolFail(p, host, new Error('pool idle')); }, POOL_IDLE_MS);
  p.idleTimer.unref?.();
  if (r.code === 0) j.resolve(r.stdout);
  else j.reject(Object.assign(new Error(`Command failed: ssh ${host} ${j.cmd}` + (p.err ? '\n' + p.err : '')), { code: r.code, stderr: p.err }));
  poolNext(host, p);
}
function poolFor(host) {
  let p = sshPools.get(host);
  if (p && p.proc.exitCode === null && !p.proc.killed) return p;
  const proc = spawn(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4', host, 'bash'], { windowsHide: true });
  const pool = p = { proc, queue: [], job: null, buf: '', err: '', idleTimer: null };
  proc.stdout.on('data', d => {
    if (!pool.job) return;
    pool.buf += d;
    if (pool.buf.length > pool.job.maxBuffer + 64) return poolFail(pool, host, new Error('maxBuffer exceeded: ssh ' + host));
    poolSettle(host, pool);
  });
  proc.stderr.on('data', d => { pool.err = (pool.err + d).slice(-65536); });
  proc.on('close', () => poolFail(pool, host, Object.assign(new Error('Command failed: ssh ' + host + ' (connection closed)' + (pool.err ? '\n' + pool.err : '')), { stderr: pool.err })));
  proc.on('error', e => poolFail(pool, host, e));
  if (proc.stdin) proc.stdin.on('error', () => {});
  sshPools.set(host, p);
  return p;
}
function poolKillAll() {
  for (const [, p] of sshPools) { try { p.proc.kill(); } catch (e) {} }
  sshPools.clear();
}

// ssh runs the remote command in the remote shell, so `|| true`/pipes work; no LOCAL shell is used.
function run(host, remoteCmd, opts = {}) {
  const p = poolFor(host);
  clearTimeout(p.idleTimer);
  return new Promise((resolve, reject) => {
    p.queue.push({ cmd: remoteCmd, timeout: opts.timeout || 15000, maxBuffer: opts.maxBuffer || 4e6, resolve, reject, timer: null });
    poolNext(host, p);
  });
}

// tab-separated: name, windows, attached(1/0), group (empty when ungrouped), active-pane cwd
function parseSessions(raw) {
  return raw.split('\n').filter(Boolean).map(l => {
    const f = l.split('\t');
    return { name: f[0], windows: +f[1] || 0, attached: f[2] === '1', group: f[3] || '', path: f.slice(4).join('\t') || '' };
  });
}
function parseCc(raw) {
  return raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

const IMG = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon' };
const TEXT = new Set(['.txt', '.md', '.json', '.jsonl', '.js', '.ts', '.tsx', '.jsx', '.py', '.csv', '.tsv', '.log', '.yaml', '.yml', '.toml', '.sh', '.html', '.css', '.xml', '.ini', '.cfg', '.conf', '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.java', '.rb', '.sql', '.env', '.gitignore', '.dockerfile']);
function ctOf(p) {
  const e = path.extname(p).toLowerCase();
  if (IMG[e]) return IMG[e];
  if (e === '.pdf') return 'application/pdf';
  if (TEXT.has(e)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

async function inspectWithRunner(host, runner = run) {
  // tmux format does NOT expand \t, so use a real tab as the field separator.
  const fmt = ['#{session_name}', '#{session_windows}', '#{?session_attached,1,0}', '#{session_group}', '#{pane_current_path}'].join('\t');
  // Wrap in `bash -lc` (as the chat spawn does) so a host whose default ssh shell isn't POSIX —
  // e.g. a Windows host defaulting to cmd.exe — runs the probe through bash instead of leaking
  // cmd parser errors ("'true' is not recognized" / "f was unexpected") as its status detail.
  const tmuxCmd = 'bash -lc ' + shq(`tmux list-sessions -F ${shq(fmt)} 2>/dev/null || true`);
  const ccCmd = 'bash -lc ' + shq('for f in ~/.claude/sessions/*.json; do [ -e "$f" ] && cat "$f" && echo; done 2>/dev/null || true');
  const [tmuxRaw, ccRaw] = await Promise.all([
    runner(host, tmuxCmd, { timeout: 9000 }),
    runner(host, ccCmd, { timeout: 9000 }),
  ]);
  const tmux = parseSessions(tmuxRaw);
  const cc = parseCc(ccRaw);
  return { name: host, tmux, cc };
}
const inspect = (host) => inspectWithRunner(host, run);
const HOST_INSPECT_BUDGET_MS = 1200;
const hostInspectCache = new Map();
const hostInspectInflight = new Map();

function inspectError(host, e, now) {
  return {
    name: host,
    ok: false,
    error: String(e.stderr || e.message || e).trim(),
    checkedAt: now(),
  };
}

function ensureHostInspect(host, { inspectOne, cache, inflight, now }) {
  if (inflight.has(host)) return inflight.get(host);
  const p = Promise.resolve()
    .then(() => inspectOne(host))
    .then(
      result => ({ ...result, name: result.name || host, ok: true, checkedAt: now() }),
      e => inspectError(host, e, now),
    )
    .then(result => {
      cache.set(host, result);
      return result;
    })
    .finally(() => inflight.delete(host));
  inflight.set(host, p);
  return p;
}

async function inspectHostsWithBudget(hostList, opts = {}) {
  const inspectOne = opts.inspectOne || inspect;
  const cache = opts.cache || hostInspectCache;
  const inflight = opts.inflight || hostInspectInflight;
  const budgetMs = Number.isFinite(opts.budgetMs) ? Math.max(0, opts.budgetMs) : HOST_INSPECT_BUDGET_MS;
  const now = opts.now || Date.now;
  const pendingMissing = [];
  for (const host of hostList) {
    const hasCachedResult = cache.has(host);
    const pending = ensureHostInspect(host, { inspectOne, cache, inflight, now });
    if (!hasCachedResult) pendingMissing.push(pending);
  }

  if (pendingMissing.length && budgetMs > 0) {
    await Promise.race([
      Promise.allSettled(pendingMissing),
      new Promise(resolve => setTimeout(resolve, budgetMs)),
    ]);
  }

  return hostList.map(host => {
    const cached = cache.get(host);
    if (cached) return inflight.has(host) ? { ...cached, stale: true } : cached;
    return { name: host, ok: null, stale: true };
  });
}

if (SELFTEST) {
  (async () => {
  const a = require('assert');
  a.deepEqual(parseHosts('Host box1\n  User x\nHost a b\nHost *\nHost proxy-*'), ['box1', 'a', 'b']);
  const t = parseSessions('claude-arpg\t2\t1\t\t/home/m/proj\nwork\t1\t0\twork\t/tmp');
  a.equal(t.length, 2); a.equal(t[0].attached, true); a.equal(t[0].path, '/home/m/proj'); a.equal(t[0].group, '');
  a.equal(t[1].attached, false); a.equal(t[1].group, 'work'); a.equal(t[1].path, '/tmp');
  a.equal(ctOf('a.PNG'), 'image/png'); a.equal(ctOf('x.py').startsWith('text/'), true); a.equal(ctOf('b.bin'), 'application/octet-stream');
  const wr = path.join(os.tmpdir(), 'corral-dist');
  a.equal(insideDir(wr, path.join(wr, 'index.html')), true);
  a.equal(insideDir(wr, path.join(path.dirname(wr), path.basename(wr) + '-secret', 'x')), false);
  a.equal(insideDir(wr, path.join(wr, '..', 'package.json')), false);
  const c = parseCc('{"sessionId":"x","status":"busy","cwd":"/a"}\nbroken\n{"status":"idle","cwd":"/b"}');
  a.equal(c.length, 2); a.equal(c[1].status, 'idle');
  // security primitives (Phase 0)
  a.equal(shq("a'b"), "'a'\\''b'");                 // single-quote escaping is canonical
  a.equal(shq("$(id)"), "'$(id)'");                 // metachars stay literal inside single quotes
  a.equal(eqTok('anything', ''), true);             // no token configured => dev-permissive
  a.equal(eqTok('', 'secret'), false);
  a.equal(eqTok('nope', 'secret'), false);
  a.equal(eqTok('secret', 'secret'), true);
  // token extraction: x-corral-token header > legacy x-codapp-token > Authorization: Bearer > ?tk= query
  a.equal(reqToken({ headers: { 'x-corral-token': 'h' } }, new URL('http://x/api/a')), 'h');
  a.equal(reqToken({ headers: { 'x-codapp-token': 'h' } }, new URL('http://x/api/a')), 'h');
  a.equal(reqToken({ headers: { authorization: 'Bearer b' } }, new URL('http://x/api/a')), 'b');
  a.equal(reqToken({ headers: {} }, new URL('http://x/api/a?tk=q')), 'q');
  a.equal(reqToken({ headers: { 'x-corral-token': 'h', authorization: 'Bearer b' } }, new URL('http://x/api/a?tk=q')), 'h');
  a.equal(reqToken({ headers: {} }, new URL('http://x/api/a')), '');
  // pocket CONNECT proxy: 443-only, never a relay to loopback/private targets
  const { parseConnectTarget } = require('./connectproxy');
  a.deepEqual(parseConnectTarget('api.anthropic.com:443'), { host: 'api.anthropic.com', port: 443 });
  a.equal(parseConnectTarget('api.anthropic.com:80'), null);      // TLS port only
  a.equal(parseConnectTarget('localhost:443'), null);             // no tunneling back to the backend
  a.equal(parseConnectTarget('127.0.0.2:443'), null);
  a.equal(parseConnectTarget('192.168.1.20:443'), null);          // no LAN pivot
  a.equal(parseConnectTarget('100.64.0.1:443'), null);            // tailnet CGNAT range
  a.equal(parseConnectTarget('169.254.169.254:443'), null);       // link-local/metadata
  a.equal(parseConnectTarget('[::1]:443'), null);                 // IPv6 literals rejected outright
  a.equal(parseConnectTarget('evil.com'), null);
  a.equal(parseConnectTarget(''), null);
  a.equal(originAllowed(undefined), true);
  a.equal(originAllowed('http://tauri.localhost'), true);
  a.equal(originAllowed('http://localhost:5173'), true);
  a.equal(originAllowed('http://127.0.0.1:7878'), true);
  a.equal(originAllowed('http://evil.com'), false);
  a.equal(originAllowed('http://127.0.0.1.evil.com'), false);
  a.equal(validRemotePath('/home/m/x'), true);
  a.equal(validRemotePath('~/x'), true);
  a.equal(validRemotePath('../x'), false);
  a.equal(validRemotePath('/a/../b'), false);
  a.equal(validRemotePath('rel/path'), false);
  a.equal(validRemotePath('/a\0b'), false);
  a.equal(validRemotePath(''), false);
  a.equal(safeLeaf('foo'), 'foo');
  a.equal(safeLeaf('a/b'), 'b');                    // directory parts stripped to the leaf
  a.equal(safeLeaf('../etc'), 'etc');
  a.equal(safeLeaf('..'), '');                      // pure traversal rejected
  a.equal(safeLeaf(''), '');
  a.equal(protectedRoot('/'), true);
  a.equal(protectedRoot('C:\\'), true);             // drive root
  a.equal(protectedRoot('~'), true);                // remote home
  a.equal(protectedRoot('/home/m/x'), false);
  const trickyArchivePath = path.join(path.sep === '\\' ? 'C:\\tmp' : '/tmp', '--checkpoint=1');
  a.deepEqual(buildLocalArchiveArgs(trickyArchivePath), ['-czf', '-', '-C', path.dirname(trickyArchivePath), '--', path.basename(trickyArchivePath)]);
  const savedHosts = hosts;
  hosts = ['box1'];
  a.equal(listPathError('local', ''), 'Path is required.');
  a.equal(listPathError('local', 'Z:/missing'), 'Path does not exist.');
  a.equal(listPathError('missing-host', '/work'), 'Unknown host.');
  a.equal(listPathError('box1', '../work'), 'Remote path must start with / or ~ and cannot contain traversal.');
  hosts = savedHosts;
  // chat argv hardening
  a.equal(chat.SAFE_ARG.test('claude-sonnet-4-6'), true);
  a.equal(chat.SAFE_ARG.test('sonnet'), true);
  a.equal(chat.SAFE_ARG.test('--dangerously-skip-permissions'), false);
  a.equal(chat.SAFE_HOST.test('box1'), true);
  a.equal(chat.SAFE_HOST.test('me@host.example'), true);
  a.equal(chat.SAFE_HOST.test('-oProxyCommand=calc.exe'), false);   // leading-dash flag smuggling rejected
  a.equal(chat.SAFE_HOST.test('a b'), false);
  a.equal(chat.PERM_MODES.has('bypassPermissions'), false);
  a.equal(chat.PERM_MODES.has('auto'), true);
  // remote/local spawn construction
  const rs = chat.buildSpawn({ host: 'box1', cwd: '/home/m/proj', model: 'sonnet' });
  a.ok(rs.remote && rs.args.includes('box1'));
  const remoteCmd = rs.args[rs.args.length - 1];
  a.ok(remoteCmd.startsWith("bash -lc "));                            // login shell => profile PATH loaded
  a.ok(remoteCmd.includes("cd ") && remoteCmd.includes("/home/m/proj") && remoteCmd.includes("claude "));
  a.ok(remoteCmd.includes("stream-json") && remoteCmd.includes("sonnet"));
  a.ok(rs.args.includes('ServerAliveInterval=15') && rs.args.includes('ServerAliveCountMax=4'));   // dropped links surface as process exit
  const lsp = chat.buildSpawn({ host: 'local', cwd: 'C:/x' });
  a.ok(!lsp.remote && lsp.args.includes('-p') && lsp.cwd === 'C:/x');
  const rsm = chat.buildSpawn({ host: 'local', cwd: 'C:/x', resumeId: 'abc-123' });
  a.ok(rsm.args.includes('--resume') && rsm.args.includes('abc-123'));   // resume injects --resume <id>
  // pocket hooks: binary override + explicit-loader prefix (local spawns only)
  {
    process.env.CORRAL_CLAUDE_BIN = '/rt/bin/claude';
    const ovr = chat.buildSpawn({ host: 'local', cwd: '/w' });
    a.equal(ovr.bin, '/rt/bin/claude');
    process.env.CORRAL_EXEC_LOADER = '/rt/bin/ld-musl-aarch64.so.1';
    const ldr = chat.buildSpawn({ host: 'local', cwd: '/w' });
    a.equal(ldr.bin, '/rt/bin/ld-musl-aarch64.so.1');
    a.equal(ldr.args[0], '/rt/bin/claude');
    a.ok(ldr.args.includes('-p') && ldr.args.includes('stream-json'));
    const rmt = chat.buildSpawn({ host: 'box1', cwd: '/w' });
    a.ok(rmt.remote && rmt.bin !== '/rt/bin/ld-musl-aarch64.so.1');      // remote spawns unaffected
    delete process.env.CORRAL_CLAUDE_BIN;
    delete process.env.CORRAL_EXEC_LOADER;
    a.notEqual(chat.buildSpawn({ host: 'local', cwd: '/w' }).bin, '/rt/bin/claude');   // read per-call
  }
  // transcript replay: .jsonl lines -> live-stream events, sidechain/bookkeeping dropped
  const tr = chat.parseTranscript([
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi there' } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } }),
    JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'subagent noise' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue' }),   // no message => skipped
    'not json',
  ].join('\n'));
  a.equal(tr.length, 3);
  a.equal(tr[0].type, '_user'); a.equal(tr[0].text, 'hi there');
  a.equal(tr[1].type, 'assistant');
  a.equal(tr[2].type, 'user');                       // tool_result passes through; sidechain + bookkeeping dropped
  // session roster freshness: list() exposes last activity for operator sorting/readouts.
  chat._sessions.set('selftest-updated', {
    id: 'selftest-updated', host: 'local', cwd: '/tmp', model: null, status: 'idle',
    sessionId: 'sid', createdAt: 1000, updatedAt: 2000, events: [], subs: new Set(), buf: ''
  });
  const listedFresh = chat.list().find(s => s.id === 'selftest-updated');
  a.equal(listedFresh.updatedAt, 2000);
  chat._sessions.delete('selftest-updated');
  // --- multi-agent adapters (Phase 2) ---
  const codexA = require('./agents/codex');
  const opencodeA = require('./agents/opencode');
  const claudeA = require('./agents/claude');
  a.ok(chat.AGENTS.has('claude') && chat.AGENTS.has('codex') && chat.AGENTS.has('opencode'));
  a.throws(() => chat.launch({ agent: 'aider' }), /unknown agent/);
  a.equal(opencodeA.available('box1'), 'opencode remote hosts not supported yet');   // remote gated per-adapter
  a.equal(codexA.available('box1'), '');                                             // remote codex runs the remote binary
  a.equal(claudeA.available('box1'), '');
  // claude stream-json parser is a pass-through
  a.deepEqual(claudeA.parseLine('{"type":"result","is_error":false}'), { type: 'result', is_error: false });
  a.equal(claudeA.parseLine('not json'), null);
  // permission-mode mapping: claude passes its native modes through; codex/opencode translate
  a.equal(chat.PERM_MODES.has('acceptEdits'), true);
  a.deepEqual(codexA.permParams('auto'), { approvalPolicy: 'never', sandbox: 'workspace-write' });
  a.deepEqual(codexA.permParams('acceptEdits'), { approvalPolicy: 'never', sandbox: 'workspace-write' });
  a.deepEqual(codexA.permParams('plan'), { approvalPolicy: 'never', sandbox: 'read-only' });
  a.deepEqual(opencodeA.permissionRuleset('auto'), [{ permission: '*', pattern: '*', action: 'allow' }]);
  a.deepEqual(opencodeA.permissionRuleset('acceptEdits'), [{ permission: '*', pattern: '*', action: 'allow' }]);
  const planRules = opencodeA.permissionRuleset('plan');
  a.ok(planRules.some(r => r.permission === 'edit' && r.action === 'deny'));
  a.ok(planRules.some(r => r.permission === 'bash' && r.action === 'deny'));
  a.equal(planRules[0].action, 'allow');                    // last match wins: allow-all first, denials after
  // approval hooks auto-respond per mode until the interactive UI lands
  a.deepEqual(codexA.onApprovalRequest({ permissionMode: 'plan' }, { method: 'item/commandExecution/requestApproval' }), { decision: 'decline' });
  a.deepEqual(codexA.onApprovalRequest({ permissionMode: 'auto' }, { method: 'item/fileChange/requestApproval' }), { decision: 'accept' });
  a.deepEqual(opencodeA.onApprovalRequest({ permissionMode: 'plan' }, {}), { response: 'reject' });
  a.deepEqual(opencodeA.onApprovalRequest({ permissionMode: 'auto' }, {}), { response: 'once' });
  // --- interactive permission plumbing (Phase 3) ---
  a.ok(chat.PERM_DECISIONS.has('allow') && chat.PERM_DECISIONS.has('allow-always') && chat.PERM_DECISIONS.has('deny'));
  // claude Ask mode routes prompts to us over stdio; other modes must not carry the flag
  a.ok(claudeA.buildSpawn({ host: 'local', cwd: 'C:/x', permissionMode: 'default' }).args.join(' ').includes('--permission-prompt-tool stdio'));
  a.ok(!claudeA.buildSpawn({ host: 'local', cwd: 'C:/x', permissionMode: 'auto' }).args.includes('--permission-prompt-tool'));
  // claude control protocol: both nesting variants parse; non-approval subtypes return null
  const cr = claudeA.parseControlRequest({ type: 'control_request', request_id: 'req_1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'npm test' }, permission_suggestions: [{ rule: 'Bash(npm test)' }] } });
  a.equal(cr.id, 'req_1'); a.equal(cr.tool, 'Bash'); a.deepEqual(cr.input, { command: 'npm test' }); a.equal(cr.suggestions.length, 1);
  a.equal(claudeA.parseControlRequest({ type: 'control_request', request_id: 'req_2', subtype: 'can_use_tool', tool_name: 'Edit', input: {} }).tool, 'Edit');
  a.equal(claudeA.parseControlRequest({ type: 'control_request', request_id: 'req_3', request: { subtype: 'hook_callback' } }), null);
  a.deepEqual(claudeA.buildPermissionResponse({ input: { command: 'x' }, suggestions: [] }, 'deny'), { behavior: 'deny', message: 'Denied by the operator' });
  a.deepEqual(claudeA.buildPermissionResponse({ input: { command: 'x' }, suggestions: [] }, 'allow'), { behavior: 'allow', updatedInput: { command: 'x' } });
  a.deepEqual(claudeA.buildPermissionResponse({ input: { command: 'x' }, suggestions: [{ rule: 'Bash(x)' }] }, 'allow-always').updatedPermissions, [{ rule: 'Bash(x)' }]);
  // codex: 'default' (Ask) flips to on-request approvals; UI prompt fields derive from the method
  a.deepEqual(codexA.permParams('default'), { approvalPolicy: 'untrusted', sandbox: 'workspace-write' });
  a.deepEqual(codexA.approvalInfo({ method: 'item/commandExecution/requestApproval', params: { command: 'rm x' } }), { tool: 'Bash', input: { command: 'rm x' } });
  a.deepEqual(codexA.approvalInfo({ method: 'item/fileChange/requestApproval', params: { changes: [1] } }), { tool: 'Edit', input: { changes: [1] } });
  a.deepEqual(codexA.APPROVAL_DECISIONS, { allow: 'accept', 'allow-always': 'acceptForSession', deny: 'decline' });
  // opencode: 'default' injects an ask-everything ruleset; replies map onto once/always/reject
  a.deepEqual(opencodeA.permissionRuleset('default'), [{ permission: '*', pattern: '*', action: 'ask' }]);
  a.deepEqual(opencodeA.PERM_REPLIES, { allow: 'once', 'allow-always': 'always', deny: 'reject' });
  // codex spawn construction (local + remote)
  const cxl = codexA.buildSpawn({ host: 'local' });
  a.ok(!cxl.remote && cxl.args.length === 1 && cxl.args[0] === 'app-server');
  const cxr = codexA.buildSpawn({ host: 'box1' });
  a.ok(cxr.remote && cxr.args.includes('box1'));
  const cxrCmd = cxr.args[cxr.args.length - 1];
  a.ok(cxrCmd.startsWith('bash -lc ') && cxrCmd.includes('codex app-server'));       // login shell => profile PATH
  a.ok(cxr.args.includes('ServerAliveInterval=15') && cxr.args.includes('ServerAliveCountMax=4'));
  // codex event translation: native app-server notifications -> Claude-style wire events
  {
    const st = codexA.newTranslateState({ model: 'gpt-5.3-codex', permissionMode: 'auto', cwd: '/home/m/proj' });
    const init = codexA.translateEvent(st, { method: 'thread/started', params: { thread: { id: 'thr_123' } } });
    a.equal(init.length, 1); a.equal(init[0].type, 'system'); a.equal(init[0].subtype, 'init');
    a.equal(init[0].session_id, 'thr_123'); a.equal(init[0].model, 'gpt-5.3-codex'); a.equal(init[0].apiKeySource, 'none');
    a.deepEqual(codexA.translateEvent(st, { method: 'thread/started', params: { thread: { id: 'thr_123' } } }), []);   // init once
    codexA.translateEvent(st, { method: 'turn/started', params: { turn: { id: 'turn_1', status: 'inProgress' } } });
    const d1 = codexA.translateEvent(st, { method: 'item/agentMessage/delta', params: { itemId: 'item_0', delta: 'Hel', threadId: 'thr_123', turnId: 'turn_1' } });
    a.deepEqual(d1.map(e => e.event.type), ['message_start', 'content_block_start', 'content_block_delta']);
    a.equal(d1[2].event.delta.type, 'text_delta'); a.equal(d1[2].event.delta.text, 'Hel');
    const d2 = codexA.translateEvent(st, { method: 'item/agentMessage/delta', params: { itemId: 'item_0', delta: 'lo' } });
    a.equal(d2.length, 1); a.equal(d2[0].event.delta.text, 'lo');
    const done = codexA.translateEvent(st, { method: 'item/completed', params: { item: { id: 'item_0', type: 'agentMessage', text: 'Hello' } } });
    a.equal(done[0].event.type, 'content_block_stop');
    a.equal(done[1].type, 'assistant'); a.deepEqual(done[1].message.content, [{ type: 'text', text: 'Hello' }]);
    const think = codexA.translateEvent(st, { method: 'item/reasoning/summaryTextDelta', params: { itemId: 'item_r', delta: 'pondering', summaryIndex: 0 } });
    a.equal(think[think.length - 1].event.delta.type, 'thinking_delta');
    a.equal(think[think.length - 1].event.delta.thinking, 'pondering');
    const tdone = codexA.translateEvent(st, { method: 'item/completed', params: { item: { id: 'item_r', type: 'reasoning', summary: ['pondering'] } } });
    a.equal(tdone[1].message.content[0].type, 'thinking');
    const tu = codexA.translateEvent(st, { method: 'item/started', params: { item: { id: 'item_1', type: 'commandExecution', command: 'ls -la', status: 'inProgress' } } });
    const tuse = tu.find(e => e.type === 'assistant');
    a.equal(tuse.message.content[0].type, 'tool_use'); a.equal(tuse.message.content[0].id, 'item_1');
    a.equal(tuse.message.content[0].name, 'Bash'); a.equal(tuse.message.content[0].input.command, 'ls -la');
    const tr = codexA.translateEvent(st, { method: 'item/completed', params: { item: { id: 'item_1', type: 'commandExecution', command: 'ls -la', aggregatedOutput: 'a.txt\n', exitCode: 0, status: 'completed' } } });
    const tres = tr.find(e => e.type === 'user');
    a.deepEqual(tres.message.content, [{ type: 'tool_result', tool_use_id: 'item_1', content: 'a.txt\n', is_error: false }]);
    const trf = codexA.translateEvent(st, { method: 'item/completed', params: { item: { id: 'item_2', type: 'commandExecution', command: 'false', aggregatedOutput: '', exitCode: 1, status: 'failed' } } });
    a.equal(trf.find(e => e.type === 'user').message.content[0].is_error, true);      // non-zero exit => tool error
    codexA.translateEvent(st, { method: 'thread/tokenUsage/updated', params: { threadId: 'thr_123', turnId: 'turn_1', tokenUsage: { last: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 55, reasoningOutputTokens: 0, totalTokens: 1055 }, total: { inputTokens: 900, cachedInputTokens: 100, outputTokens: 55, reasoningOutputTokens: 0, totalTokens: 1055 }, modelContextWindow: 272000 } } });
    const fin = codexA.translateEvent(st, { method: 'turn/completed', params: { threadId: 'thr_123', turn: { id: 'turn_1', status: 'completed', durationMs: 1234 } } });
    const res1 = fin.find(e => e.type === 'result');
    a.equal(res1.subtype, 'success'); a.equal(res1.is_error, false);
    a.equal(res1.usage.input_tokens, 900); a.equal(res1.usage.output_tokens, 55); a.equal(res1.usage.cache_read_input_tokens, 100);
    const retry = codexA.translateEvent(st, { method: 'error', params: { willRetry: true, error: { message: 'rate limited' } } });
    a.equal(retry[0].type, 'system'); a.equal(retry[0].subtype, 'api_retry');
    const fatal = codexA.translateEvent(st, { method: 'error', params: { willRetry: false, error: { message: 'boom' } } });
    a.deepEqual(fatal, [{ type: '_error', message: 'boom' }]);
    a.deepEqual(codexA.translateEvent(st, { method: 'some/future/notification', params: {} }), []);   // unknown methods ignored
    const interrupted = codexA.translateEvent(st, { method: 'turn/completed', params: { turn: { id: 'turn_2', status: 'interrupted' } } });
    a.equal(interrupted.find(e => e.type === 'result').subtype, 'error_during_execution');   // mirrors claude's interrupt result
  }
  // codex resume replay: thread/resume history (turns[].items) -> buffered events
  {
    const hist = codexA.translateThreadItems({ id: 'thr_9', turns: [{ items: [
      { id: 'i1', type: 'userMessage', content: [{ type: 'text', text: 'hi' }] },
      { id: 'i2', type: 'agentMessage', text: 'hello' },
    ] }] });
    a.equal(hist.length, 2);
    a.deepEqual(hist[0], { type: '_user', text: 'hi' });
    a.equal(hist[1].type, 'assistant'); a.equal(hist[1].message.content[0].text, 'hello');
  }
  // opencode event translation: SSE bus events -> Claude-style wire events
  {
    const st = opencodeA.newTranslateState({});
    const init = opencodeA.initEvent(st, { id: 'ses_1', directory: '/tmp/x', model: { providerID: 'anthropic', modelID: 'claude-sonnet-4-5' } });
    a.equal(init.subtype, 'init'); a.equal(init.session_id, 'ses_1'); a.equal(init.model, 'claude-sonnet-4-5');
    opencodeA.translateEvent(st, { type: 'message.updated', properties: { sessionID: 'ses_1', info: { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', modelID: 'claude-sonnet-4-5' } } });
    const d1 = opencodeA.translateEvent(st, { type: 'message.part.delta', properties: { sessionID: 'ses_1', messageID: 'msg_1', partID: 'prt_1', field: 'text', delta: 'Hi ' } });
    a.deepEqual(d1.map(e => e.event.type), ['message_start', 'content_block_start', 'content_block_delta']);
    a.equal(d1[2].event.delta.text, 'Hi ');
    // full-part snapshot: only the unseen suffix streams, then the block closes + buffers complete
    const d2 = opencodeA.translateEvent(st, { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_1', messageID: 'msg_1', sessionID: 'ses_1', type: 'text', text: 'Hi there', time: { start: 1, end: 2 } } } });
    a.ok(d2.some(e => e.type === 'stream_event' && e.event.type === 'content_block_delta' && e.event.delta.text === 'there'));
    a.equal(d2.find(e => e.type === 'assistant').message.content[0].text, 'Hi there');
    const trun = opencodeA.translateEvent(st, { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_2', messageID: 'msg_1', sessionID: 'ses_1', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'running', input: { command: 'ls' }, time: { start: 1 } } } } });
    const ocUse = trun.find(e => e.type === 'assistant');
    a.equal(ocUse.message.content[0].type, 'tool_use'); a.equal(ocUse.message.content[0].id, 'call_1');
    a.equal(ocUse.message.content[0].name, 'bash'); a.equal(ocUse.message.content[0].input.command, 'ls');
    const tdone2 = opencodeA.translateEvent(st, { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_2', messageID: 'msg_1', sessionID: 'ses_1', type: 'tool', callID: 'call_1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'a.txt', time: { start: 1, end: 2 } } } } });
    const ocRes = tdone2.find(e => e.type === 'user');
    a.deepEqual(ocRes.message.content, [{ type: 'tool_result', tool_use_id: 'call_1', content: 'a.txt', is_error: false }]);
    opencodeA.translateEvent(st, { type: 'message.updated', properties: { sessionID: 'ses_1', info: { id: 'msg_1', sessionID: 'ses_1', role: 'assistant', cost: 0.01, tokens: { input: 10, output: 4, reasoning: 0, cache: { read: 3, write: 0 } } } } });
    const idle = opencodeA.translateEvent(st, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'idle' } } });
    const res2 = idle.find(e => e.type === 'result');
    a.equal(res2.subtype, 'success'); a.equal(res2.usage.input_tokens, 10); a.equal(res2.usage.output_tokens, 4);
    a.equal(res2.usage.cache_read_input_tokens, 3); a.equal(res2.total_cost_usd, 0.01);
    // session.idle follows session.status{idle} on the live bus — only one result per turn
    a.deepEqual(opencodeA.translateEvent(st, { type: 'session.idle', properties: { sessionID: 'ses_1' } }), []);
    // reasoning part on a fresh message -> thinking block
    opencodeA.translateEvent(st, { type: 'message.updated', properties: { sessionID: 'ses_1', info: { id: 'msg_2', sessionID: 'ses_1', role: 'assistant' } } });
    const rp = opencodeA.translateEvent(st, { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_3', messageID: 'msg_2', sessionID: 'ses_1', type: 'reasoning', text: 'mulling', time: { start: 1, end: 2 } } } });
    a.equal(rp.find(e => e.type === 'assistant').message.content[0].thinking, 'mulling');
    a.ok(rp.some(e => e.type === 'stream_event' && e.event.type === 'content_block_delta' && e.event.delta.type === 'thinking_delta'));
    // user-role message parts never render as assistant output (we echo _user ourselves)
    opencodeA.translateEvent(st, { type: 'message.updated', properties: { sessionID: 'ses_1', info: { id: 'msg_3', sessionID: 'ses_1', role: 'user' } } });
    a.deepEqual(opencodeA.translateEvent(st, { type: 'message.part.updated', properties: { sessionID: 'ses_1', part: { id: 'prt_4', messageID: 'msg_3', sessionID: 'ses_1', type: 'text', text: 'echo', time: { start: 1, end: 2 } } } }), []);
    // retry surfaces as claude's api_retry pill; errors end the turn
    const rtry = opencodeA.translateEvent(st, { type: 'session.status', properties: { sessionID: 'ses_1', status: { type: 'retry', attempt: 1, message: 'model busy', next: 2 } } });
    a.equal(rtry[0].subtype, 'api_retry');
    const errEvs = opencodeA.translateEvent(st, { type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'UnknownError', data: { message: 'kaput' } } } });
    a.equal(errEvs[0].type, '_error'); a.ok(errEvs[0].message.includes('kaput'));
    a.ok(errEvs.some(e => e.type === 'result' && e.is_error));
    const abortEvs = opencodeA.translateEvent(st, { type: 'session.error', properties: { sessionID: 'ses_1', error: { name: 'MessageAbortedError', data: { message: 'aborted' } } } });
    a.ok(!abortEvs.some(e => e.type === '_error'));         // user-initiated stop: no error pill, just the turn result
    a.equal(abortEvs.find(e => e.type === 'result').subtype, 'error_during_execution');
  }
  // opencode resume replay: stored messages -> buffered events
  {
    const hist = opencodeA.translateMessages([
      { info: { id: 'msg_1', role: 'user' }, parts: [{ type: 'text', text: 'do it' }] },
      { info: { id: 'msg_2', role: 'assistant', modelID: 'claude-sonnet-4-5' }, parts: [
        { type: 'reasoning', text: 'hmm' },
        { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'completed', input: { command: 'ls' }, output: 'ok' } },
        { type: 'text', text: 'done' },
      ] },
    ], 'ses_1');
    a.deepEqual(hist[0], { type: '_user', text: 'do it' });
    a.deepEqual(hist[1].message.content.map(b => b.type), ['thinking', 'tool_use', 'text']);
    a.equal(hist[2].type, 'user'); a.equal(hist[2].message.content[0].tool_use_id, 'c1');
  }
  // roster records carry the agent field (and default old records to claude)
  chat._sessions.set('selftest-agent', { id: 'selftest-agent', agent: 'codex', host: 'local', cwd: '/tmp', model: null, status: 'idle', sessionId: 'thr_x', createdAt: 1, updatedAt: 2, events: [], subs: new Set() });
  chat._sessions.set('selftest-agentless', { id: 'selftest-agentless', host: 'local', cwd: '/tmp', model: null, status: 'idle', sessionId: 'sid2', createdAt: 1, updatedAt: 2, events: [], subs: new Set() });
  a.equal(chat.list().find(s => s.id === 'selftest-agent').agent, 'codex');
  a.equal(chat.list().find(s => s.id === 'selftest-agentless').agent, 'claude');
  chat._sessions.delete('selftest-agent'); chat._sessions.delete('selftest-agentless');
  // stuck-busy watchdog: only a busy session whose process is actually gone gets demoted
  a.equal(chat.watchdogVerdict({ status: 'busy', exited: true, alive: false, msSinceEvent: 0 }), true);
  a.equal(chat.watchdogVerdict({ status: 'busy', exited: false, alive: true, msSinceEvent: 9e9 }), false);   // long turns with a live proc are legitimate
  a.equal(chat.watchdogVerdict({ status: 'busy', exited: false, alive: false, msSinceEvent: 6 * 60 * 1000 }), true);
  a.equal(chat.watchdogVerdict({ status: 'busy', exited: false, alive: false, msSinceEvent: 60 * 1000 }), false);
  a.equal(chat.watchdogVerdict({ status: 'idle', exited: true, alive: false, msSinceEvent: 9e9 }), false);
  let activeInspects = 0, maxActiveInspects = 0;
  const ih = await inspectWithRunner('box1', async (host, cmd) => {
    activeInspects += 1;
    maxActiveInspects = Math.max(maxActiveInspects, activeInspects);
    await new Promise(r => setTimeout(r, 30));
    activeInspects -= 1;
    return cmd.includes('tmux') ? 'work\t1\t0\t/tmp\n' : '{"status":"busy","cwd":"/tmp"}\n';
  });
  a.equal(maxActiveInspects, 2);                         // tmux + Claude metadata probes run together
  a.equal(ih.tmux.length, 1);
  a.equal(ih.cc.length, 1);
  const inspectCache = new Map();
  const startedAt = Date.now();
  const bounded = await inspectHostsWithBudget(['fastbox', 'slowbox'], {
    cache: inspectCache,
    budgetMs: 35,
    inspectOne: async (host) => {
      await new Promise(r => setTimeout(r, host === 'fastbox' ? 10 : 120));
      return { name: host, tmux: [], cc: [{ status: host }] };
    },
  });
  a.ok(Date.now() - startedAt < 90);                      // one slow SSH host cannot stall the route
  a.deepEqual(bounded.map(h => [h.name, h.ok, h.stale || false]), [
    ['fastbox', true, false],
    ['slowbox', null, true],
  ]);
  await new Promise(r => setTimeout(r, 140));
  a.equal(inspectCache.get('slowbox').ok, true);           // slow result still lands for the next poll
  const warmCache = new Map([['warmbox', { name: 'warmbox', ok: true, tmux: [], cc: [{ status: 'cached' }], checkedAt: 1 }]]);
  const warmStartedAt = Date.now();
  const warm = await inspectHostsWithBudget(['warmbox'], {
    cache: warmCache,
    budgetMs: 80,
    inspectOne: async (host) => {
      await new Promise(r => setTimeout(r, 120));
      return { name: host, tmux: [], cc: [{ status: 'fresh' }] };
    },
  });
  a.ok(Date.now() - warmStartedAt < 40);                   // cached hosts return immediately while refreshing
  a.equal(warm[0].stale, true);
  a.equal(warm[0].checkedAt, 1);
  await new Promise(r => setTimeout(r, 140));
  a.equal(warmCache.get('warmbox').cc[0].status, 'fresh');
  const ta = tunnels.buildForwardArgs({ host: 'box1', remoteHost: '127.0.0.1', remotePort: 8080, localPort: 5500 });
  a.ok(ta.includes('box1') && ta.join(' ').includes('-L 127.0.0.1:5500:127.0.0.1:8080'));
  // pooled remote exec framing: output splits on the RS exit marker, end-of-stream only
  a.deepEqual(poolParse('partial output'), { done: false });
  a.deepEqual(poolParse('hello\n\x1e0\x1e\n'), { done: true, stdout: 'hello\n', code: 0 });
  a.deepEqual(poolParse('\x1e7\x1e\n'), { done: true, stdout: '', code: 7 });
  a.equal(poolParse('mid\x1e5\x1e\nmore').done, false);
  // terminal bridge spawns: local shell / tmux attach / plain ssh / ssh with a project cwd
  a.ok(buildTermSpawn({ host: 'local', cwd: 'C:/x' }).args.length === 0 && buildTermSpawn({ host: 'local', cwd: 'C:/x' }).cwd === 'C:/x');
  const tmuxSp = buildTermSpawn({ host: 'box1', target: 'main' });
  a.ok(tmuxSp.args.includes('-tt') && tmuxSp.args.includes('box1') && tmuxSp.args.join(' ').includes("tmux attach -t 'main'"));
  a.ok(buildTermSpawn({ host: 'box1', cwd: '/home/m/proj' }).args.join(' ').includes("cd '/home/m/proj' && exec"));
  a.deepEqual(buildTermSpawn({ host: 'box1' }).args, ['-tt', 'box1']);
  // tunnels.json migration: legacy pid-only entries can only be reaped; full configs restore
  a.deepEqual(tunnels.parsePersistedTunnels('[{"pid":123,"localPort":5500,"host":"box1"}]'), { pids: [123], configs: [] });
  const fullTf = tunnels.parsePersistedTunnels('[{"pid":9,"host":"box1","localPort":5500,"remoteHost":"127.0.0.1","remotePort":8080,"http":true},{"host":"box2","remotePort":3000}]');
  a.deepEqual(fullTf.pids, [9]);
  a.deepEqual(fullTf.configs, [
    { host: 'box1', remoteHost: '127.0.0.1', remotePort: 8080, localPort: 5500, http: true },
    { host: 'box2', remoteHost: '127.0.0.1', remotePort: 3000, localPort: undefined, http: false },
  ]);
  a.deepEqual(tunnels.parsePersistedTunnels('not json'), { pids: [], configs: [] });
  a.deepEqual(tunnels.parsePersistedTunnels('{}'), { pids: [], configs: [] });
  const probeServer = http.createServer((req, res) => { res.statusCode = 404; res.end('probe ok'); });
  await new Promise(resolve => probeServer.listen(0, '127.0.0.1', resolve));
  const probePort = probeServer.address().port;
  const probeOk = await tunnels.probeHttpService(probePort, { timeoutMs: 500 });
  a.equal(probeOk.ok, true);
  a.equal(probeOk.statusCode, 404);                      // any HTTP response means the forwarded service is reachable
  await new Promise(resolve => probeServer.close(resolve));
  const closedPort = await tunnels.freePort();
  const probeDown = await tunnels.probeHttpService(closedPort, { timeoutMs: 100 });
  a.equal(probeDown.ok, false);
  a.equal(tunnels.initialServiceStatus({ status: 'up', http: true }), 'probing');
  a.equal(tunnels.initialServiceStatus({ status: 'up', http: false }), 'not-checked');
  // --- operator extras (Phase 6) ---
  // history search: literal case-insensitive scan; sidechain/tool_result don't count; first cwd wins
  const hFix = [
    JSON.stringify({ type: 'user', cwd: '/home/m/proj', message: { role: 'user', content: 'let us build a TUNNEL today' } }),
    JSON.stringify({ type: 'assistant', cwd: '/home/m/other', message: { role: 'assistant', content: [{ type: 'text', text: 'tunnel plan: ' + 'x'.repeat(400) }] } }),
    JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'tunnel noise from a sub-agent' } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'tunnel inside tool output' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'more tunnel talk' }] } }),
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'a fourth tunnel mention' }] } }),
    'not json',
  ].join('\n');
  const hs = claudeA.searchTranscriptText(hFix, 'Tunnel', 3);
  a.equal(hs.cwd, '/home/m/proj');                                           // first cwd seen wins
  a.deepEqual(hs.matches.map(m => m.role), ['user', 'assistant', 'assistant']);   // capped at 3
  a.ok(hs.matches[0].snippet.includes('TUNNEL'));
  a.ok(hs.matches[1].snippet.length <= 200);                                 // long line trimmed to ~180 around the match
  a.equal(claudeA.searchTranscriptText(hFix, 't.nnel', 3).matches.length, 0);      // literal substring — no regex
  a.equal(claudeA.searchTranscriptText(hFix, 'zzz-none', 3).matches.length, 0);
  const hq = claudeA.searchTranscriptText(JSON.stringify({ type: 'user', cwd: '/x', message: { role: 'user', content: 'she said "hello" loudly' } }), '"hello"', 3);
  a.equal(hq.matches.length, 1);                                             // JSON-escaped needle still found in decoded text
  // worktree argv construction (pure — no git runs in selftest)
  const wtRepo = path.sep === '\\' ? 'C:\\repos\\my-app' : '/repos/my-app';
  const wtDir = path.join(wtRepo, 'Sub Dir!');
  const wt = buildWorktreeArgs({ dir: wtDir, repoRoot: wtRepo, now: 1234567 });
  a.equal(wt.branch, 'corral/sub-dir-' + (1234567).toString(36));           // slug: sanitized dir basename
  a.equal(wt.target, path.join(path.dirname(wtRepo), 'my-app-corral-' + (1234567).toString(36)));
  a.deepEqual(wt.args, ['-C', wtDir, 'worktree', 'add', '-b', wt.branch, wt.target]);
  a.equal(buildWorktreeArgs({ dir: path.join(wtRepo, '!!!'), repoRoot: wtRepo, now: 1 }).branch, 'corral/work-1');   // all-junk basename falls back
  // the overnight ranch (queue.js): review-gate git argv builders — argv arrays only, never a shell
  a.deepEqual(queue.buildWorktreeRemoveArgs({ repoRoot: wtRepo, target: '/x/wt' }), ['-C', wtRepo, 'worktree', 'remove', '/x/wt']);
  a.deepEqual(queue.buildWorktreeRemoveArgs({ repoRoot: wtRepo, target: '/x/wt', force: true }), ['-C', wtRepo, 'worktree', 'remove', '--force', '/x/wt']);
  a.deepEqual(queue.buildBranchDeleteArgs({ repoRoot: wtRepo, branch: 'corral/x-1' }), ['-C', wtRepo, 'branch', '-d', 'corral/x-1']);
  a.deepEqual(queue.buildBranchDeleteArgs({ repoRoot: wtRepo, branch: 'corral/x-1', force: true }), ['-C', wtRepo, 'branch', '-D', 'corral/x-1']);
  a.deepEqual(queue.buildMergeArgs({ repoRoot: wtRepo, branch: 'corral/x-1', label: 'ship it' }), ['-C', wtRepo, 'merge', '--no-ff', 'corral/x-1', '-m', 'corral: ship it (kept)']);
  a.deepEqual(queue.buildCommitArgs({ dir: '/x/wt', label: 'ship it' }), ['-C', '/x/wt', 'commit', '-m', 'corral: ship it']);
  // shortstat parsing: both singular/plural forms, missing sides, garbage
  a.deepEqual(queue.parseShortstat(' 3 files changed, 120 insertions(+), 30 deletions(-)'), { files: 3, add: 120, del: 30 });
  a.deepEqual(queue.parseShortstat(' 1 file changed, 2 insertions(+)'), { files: 1, add: 2, del: 0 });
  a.deepEqual(queue.parseShortstat(' 1 file changed, 1 deletion(-)'), { files: 1, add: 0, del: 1 });
  a.deepEqual(queue.parseShortstat(''), { files: 0, add: 0, del: 0 });
  a.equal(queue.diffstatEmpty({ files: 0, add: 0, del: 0, untracked: 0 }), true);
  a.equal(queue.diffstatEmpty({ files: 0, add: 0, del: 0, untracked: 2 }), false);   // untracked files ARE work
  a.equal(queue.diffstatEmpty(null), true);
  // runner gate: sequential, hold-until, nothing to do
  a.equal(queue.shouldStart({ hold: null, running: false, queued: 2, now: 1000 }), true);
  a.equal(queue.shouldStart({ hold: null, running: true, queued: 2, now: 1000 }), false);    // one at a time
  a.equal(queue.shouldStart({ hold: 2000, running: false, queued: 2, now: 1000 }), false);   // held for tonight
  a.equal(queue.shouldStart({ hold: 500, running: false, queued: 2, now: 1000 }), true);     // hold expired
  a.equal(queue.shouldStart({ hold: null, running: false, queued: 0, now: 1000 }), false);
  // boot reconcile: judge a mid-drain crash by the evidence on disk
  a.equal(queue.reconcileVerdict({ worktreeExists: true, diffEmpty: false }), 'landed');
  a.equal(queue.reconcileVerdict({ worktreeExists: true, diffEmpty: true }), 'failed');
  a.equal(queue.reconcileVerdict({ worktreeExists: false, diffEmpty: true }), 'failed');
  // review-gate verdicts per status
  a.equal(queue.canKeep('landed') && queue.canKeep('conflict'), true);
  a.equal(queue.canKeep('failed') || queue.canKeep('queued') || queue.canKeep('kept'), false);
  a.equal(queue.canBounce('landed') && queue.canBounce('conflict') && queue.canBounce('failed'), true);
  a.equal(queue.canBounce('running') || queue.canBounce('bounced'), false);
  a.equal(queue.canRemove('queued') && queue.canRemove('kept') && queue.canRemove('bounced') && queue.canRemove('empty') && queue.canRemove('failed'), true);
  a.equal(queue.canRemove('running') || queue.canRemove('landed') || queue.canRemove('conflict'), false);   // mid-flight/reviewable: bounce first
  a.equal(queue.jobLabel('  Fix the flaky test\nand more detail'), 'Fix the flaky test');
  a.equal(queue.jobLabel('x'.repeat(99)).length, 60);
  // landed push copy + drain summary (pure)
  a.equal(pushCfg.diffstatText({ files: 3, add: 120, del: 30 }), '+120 -30 across 3 files');
  a.equal(pushCfg.diffstatText({ files: 0, add: 0, del: 0, untracked: 1 }), '+0 -0 across 1 file (1 new)');
  a.equal(pushCfg.messageFor('landed', { agent: 'claude', cwd: '/x/corral' }, { diffstat: { files: 2, add: 14, del: 6 } }).body, 'corral - +14 -6 across 2 files - review when ready');
  a.equal(pushCfg.queueSummaryText({ landed: 3, failed: 1, empty: 0 }), '3 landed - 1 failed');
  a.equal(pushCfg.queueSummaryText({}), 'nothing ran');
  // a landing's click deep-links to the review screen, not the transcript
  a.equal(pushCfg.notificationExtras({ kind: 'landed', sessionId: 's1', reviewId: 'j1', base: 'http://10.0.0.2:7879', token: 'tok' }).click, 'http://10.0.0.2:7879/#review=j1');
  a.equal(pushCfg.notificationExtras({ kind: 'landed', sessionId: 's1', reviewId: 'j1', base: 'http://10.0.0.2:7879', token: 'tok', appClick: true }).click, 'corral://review/j1');
  a.equal(pushCfg.notificationExtras({ kind: 'landed', sessionId: 's1', base: 'http://10.0.0.2:7879', token: 'tok' }).click, 'http://10.0.0.2:7879/#session=s1');   // no job id -> session fallback
  // session labels: pure cleaner (setLabel = cleanLabel + persist, not run here — selftest must never write the roster)
  a.equal(chat.cleanLabel('  ship it  '), 'ship it');
  a.equal(chat.cleanLabel('x'.repeat(80)).length, 60);                       // 60-char cap
  a.equal(chat.cleanLabel('a\x00b\x1fc\x7fd'), 'abcd');                      // control chars stripped
  a.equal(chat.cleanLabel(''), '');                                          // empty clears (setLabel stores null)
  a.equal(chat.cleanLabel(null), '');
  a.equal(chat.setLabel('no-such-session', 'x'), false);                     // unknown id: no-op, no persist
  // label + worktree flags surface through list() (and durable(): same fields)
  chat._sessions.set('selftest-label', { id: 'selftest-label', host: 'local', cwd: '/tmp', model: null, status: 'idle', sessionId: 'sidL', createdAt: 1, updatedAt: 2, label: 'ship it', worktree: true, events: [], subs: new Set() });
  chat._sessions.set('selftest-plain', { id: 'selftest-plain', host: 'local', cwd: '/tmp', model: null, status: 'idle', sessionId: 'sidP', createdAt: 1, updatedAt: 2, events: [], subs: new Set() });
  a.equal(chat.list().find(s => s.id === 'selftest-label').label, 'ship it');
  a.equal(chat.list().find(s => s.id === 'selftest-label').worktree, true);
  a.equal(chat.list().find(s => s.id === 'selftest-plain').label, null);     // unlabeled defaults
  a.equal(chat.list().find(s => s.id === 'selftest-plain').worktree, false);
  chat._sessions.delete('selftest-label'); chat._sessions.delete('selftest-plain');
  // pending permission prompts surface on the roster: { count, latest ask's tool + summary } or null
  a.equal(chat.permSummary({ command: 'npm test' }), 'npm test');
  a.equal(chat.permSummary({ file_path: '/etc/hosts' }), '/etc/hosts');
  a.equal(chat.permSummary({ command: 'x'.repeat(400) }).length, 120);       // capped for the roster
  a.equal(chat.permSummary({ weird: 1 }), '');                               // unknown shapes stay quiet
  a.equal(chat.permSummary(null), '');
  chat._sessions.set('selftest-perm', { id: 'selftest-perm', host: 'local', cwd: '/tmp', model: null, status: 'busy', sessionId: 'sidQ', createdAt: 1, updatedAt: 2, pendingPerms: new Map([['r1', { tool: 'Bash', summary: 'rm -rf build' }], ['r2', { tool: 'Edit', summary: 'README.md' }]]), events: [], subs: new Set() });
  a.deepEqual(chat.list().find(s => s.id === 'selftest-perm').pendingPerm, { count: 2, id: 'r2', tool: 'Edit', summary: 'README.md' });
  chat._sessions.get('selftest-perm').pendingPerms = null;
  a.equal(chat.list().find(s => s.id === 'selftest-perm').pendingPerm, null);
  chat._sessions.delete('selftest-perm');
  // remote access (phone pairing): pure classification helpers
  a.equal(remoteCfg.isPrivateIp('192.168.1.20'), true);
  a.equal(remoteCfg.isPrivateIp('10.0.0.7'), true);
  a.equal(remoteCfg.isPrivateIp('172.16.0.1'), true);
  a.equal(remoteCfg.isPrivateIp('172.32.0.1'), false);              // just past the RFC1918 172 range
  a.equal(remoteCfg.isPrivateIp('100.100.1.9'), true);              // Tailscale CGNAT
  a.equal(remoteCfg.isPrivateIp('100.63.0.1'), false);
  a.equal(remoteCfg.isPrivateIp('8.8.8.8'), false);
  a.equal(remoteCfg.isPrivateIp('192.168.1.999'), false);
  a.equal(remoteCfg.isPrivateIp('evil.com'), false);
  a.equal(remoteCfg.isPrivateOrigin('http://192.168.1.20:7879'), true);
  a.equal(remoteCfg.isPrivateOrigin('https://100.101.1.2'), true);
  a.equal(remoteCfg.isPrivateOrigin('http://evil.com'), false);
  a.equal(remoteCfg.isPrivateOrigin('http://8.8.8.8:7879'), false);
  a.equal(remoteCfg.isPrivateOrigin('ftp://192.168.1.20'), false);
  a.equal(remoteCfg.isPrivateOrigin(''), false);
  a.equal(remoteCfg.isLoopbackAddr('127.0.0.1'), true);
  a.equal(remoteCfg.isLoopbackAddr('::1'), true);
  a.equal(remoteCfg.isLoopbackAddr('::ffff:127.0.0.1'), true);
  a.equal(remoteCfg.isLoopbackAddr('192.168.1.5'), false);
  a.equal(remoteCfg.isLoopbackAddr(undefined), false);
  // TLS pair loading: both files or a path-naming error (no silent plaintext fallback)
  a.throws(() => remoteCfg.loadTls({ certPath: 'Z:/nope.crt', keyPath: 'Z:/nope.key' }), /could not read certificate at Z:\/nope.crt/);
  a.deepEqual(remoteCfg.lanAddresses({
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [{ family: 'IPv4', address: '10.1.2.3', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    wifi: [{ family: 4, address: '192.168.1.5', internal: false }],   // numeric family (older node)
    wan: [{ family: 'IPv4', address: '203.0.113.9', internal: false }],
  }), ['192.168.1.5', '10.1.2.3']);                                  // public + internal filtered, 192.168 first
  // token verdicts: loopback keeps the per-run rules; LAN callers need the pairing token, always
  a.equal(tokenVerdict({ provided: 'x', loopback: true, runToken: '', remote: { enabled: true, token: 'r' } }), true);     // dev loopback stays permissive
  a.equal(tokenVerdict({ provided: 'run', loopback: true, runToken: 'run', remote: { enabled: false, token: '' } }), true);
  a.equal(tokenVerdict({ provided: 'r', loopback: false, runToken: '', remote: { enabled: true, token: 'r' } }), true);
  a.equal(tokenVerdict({ provided: 'run', loopback: false, runToken: 'run', remote: { enabled: true, token: 'r' } }), false);  // per-run token is loopback-only
  a.equal(tokenVerdict({ provided: '', loopback: false, runToken: '', remote: { enabled: true, token: 'r' } }), false);        // no dev-permissive LAN
  a.equal(tokenVerdict({ provided: 'r', loopback: false, runToken: '', remote: { enabled: false, token: 'r' } }), false);      // disabled = closed
  a.equal(tokenVerdict({ provided: 'r', loopback: false, runToken: '', remote: { enabled: true, token: '' } }), false);        // no token minted yet = closed
  // push messages: pure builder (no config read, nothing sent)
  {
    const s = { agent: 'claude', host: 'gpu1', cwd: '/srv/app' };
    const input = pushCfg.messageFor('input', s, { tool: 'Bash' });
    a.equal(input.title, 'Claude needs you');
    a.equal(input.body, 'app / gpu1 - waiting for permission: Bash');
    a.equal(input.priority, 'high');
    const done = pushCfg.messageFor('done', { agent: 'codex', host: 'local', cwd: 'C:\\work\\app' }, { costUsd: 1.5 });
    a.equal(done.title, 'Codex is ready');
    a.equal(done.body, 'app finished its turn ($1.50 total)');   // local host omitted
    a.equal(pushCfg.messageFor('fail-error', s, { detail: 'boom' }).title, 'Session error');
    a.equal(pushCfg.messageFor('fail', s).title, 'Session ended');
    // notification extras: click deep-link + optional one-tap permission actions (pure)
    const nx = pushCfg.notificationExtras({ kind: 'input', sessionId: 'ses 1', requestId: 'req_1', base: 'http://192.168.1.20:7879', token: 'tok', actionsEnabled: true });
    a.equal(nx.click, 'http://192.168.1.20:7879/#session=ses%201');
    a.ok(nx.actions.startsWith('http, Allow, http://192.168.1.20:7879/api/chat/permission?id=ses%201&requestId=req_1&decision=allow'));
    a.ok(nx.actions.includes('; http, Deny, ') && nx.actions.includes('decision=deny'));
    a.ok(nx.actions.includes('headers.x-corral-token=tok'));
    a.equal(pushCfg.notificationExtras({ kind: 'input', sessionId: 's', requestId: 'r', base: 'http://10.0.0.2:7879', token: 'tok', actionsEnabled: false }).actions, undefined);   // opt-in
    a.equal(pushCfg.notificationExtras({ kind: 'done', sessionId: 's', base: 'http://10.0.0.2:7879', token: 'tok', actionsEnabled: true }).actions, undefined);   // actions only on asks
    a.deepEqual(pushCfg.notificationExtras({ kind: 'input', sessionId: 's', requestId: 'r', base: '', token: 'tok', actionsEnabled: true }), {});   // remote off => no dead links
    const ax = pushCfg.notificationExtras({ kind: 'input', sessionId: 'ses 1', requestId: 'r', base: 'http://10.0.0.2:7879', token: 'tok', actionsEnabled: true, appClick: true });
    a.equal(ax.click, 'corral://session/ses%201');   // appClick opens the APK; actions still target the LAN listener
    a.ok(ax.actions.includes('http://10.0.0.2:7879/api/chat/permission'));
  }
  // Web Push crypto against RFC 8291 Appendix A — same inputs must produce the RFC's exact
  // message (salt+keys injected only here; production uses fresh randomness per send).
  {
    const cryptoNode = require('crypto');
    const msg = webpush.encrypt(
      Buffer.from('When I grow up, I want to be a watermelon'),
      { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
      { asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', salt: 'DGv6ra1nlYgDCS1FRnbzlw' });
    a.equal(msg.subarray(0, 86).toString('base64url'), 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8');
    a.equal(msg.subarray(86).toString('base64url'), '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ');
    // VAPID header: ES256 JWT over the endpoint origin, verifiable with the public half
    const asPub = Buffer.from('BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8', 'base64url');
    const jwk = { kty: 'EC', crv: 'P-256', d: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', x: asPub.subarray(1, 33).toString('base64url'), y: asPub.subarray(33).toString('base64url') };
    const header = webpush.vapidAuth('https://push.example.net/w/abc', jwk, 1700000000);
    const jwt = header.match(/^vapid t=([^,]+), k=(.+)$/);
    a.equal(jwt[2], asPub.toString('base64url'));
    const [h, p, sig] = jwt[1].split('.');
    a.deepEqual(JSON.parse(Buffer.from(h, 'base64url')), { typ: 'JWT', alg: 'ES256' });
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    a.equal(claims.aud, 'https://push.example.net');
    a.equal(claims.exp, 1700000000 + 12 * 3600);
    const pub = cryptoNode.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y }, format: 'jwk' });
    a.ok(cryptoNode.verify('sha256', Buffer.from(h + '.' + p), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url')));
  }
  console.log('selftest ok'); process.exit(0);
  })().catch(e => { console.error(e); process.exit(1); });
}

if (!SELFTEST) {

if (!demo) chat.loadRoster();   // re-hydrate past sessions (dormant) so they can be seen and resumed
if (!demo) queue.init();        // reconcile jobs the last run left mid-drain, then resume draining

// Single-user sidecar: a stray rejection or late stream error in one request must not take down
// every other live session + tunnel. Log loudly, stay up.
process.on('uncaughtException', (e) => console.error('[uncaught]', (e && e.stack) || e));
process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', (e && e.stack) || e));

// The one request handler — served on the loopback listener always, and on the LAN listener too
// while remote access (phone pairing) is enabled.
const handleRequest = async (req, res) => {
  const url = new URL(req.url, 'http://x');
  // --- auth gate for all /api/* routes (loopback bind + token + Origin allowlist) ---
  if (url.pathname.startsWith('/api/')) {
    const origin = req.headers.origin;
    if (origin && originAllowed(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, x-corral-token, x-codapp-token');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
    if (!originAllowed(origin)) { res.statusCode = 403; return res.end('bad origin'); }
    if (!reqTokenOk(req, reqToken(req, url))) { res.statusCode = 401; return res.end('unauthorized'); }
  }
  // --- remote access (phone pairing) ---
  if (url.pathname === '/api/remote') {
    res.setHeader('content-type', 'application/json');
    const loopback = remoteCfg.isLoopbackAddr(req.socket && req.socket.remoteAddress);
    if (req.method === 'POST') {
      try {
        const q = url.searchParams;
        if (!loopback) { res.statusCode = 403; return res.end(JSON.stringify({ ok: false, error: 'remote settings are loopback-only' })); }
        const next = {};
        if (q.has('enabled')) next.enabled = q.get('enabled') === '1';
        if (q.has('port')) next.port = q.get('port');
        if (q.has('certPath')) next.certPath = q.get('certPath');
        if (q.has('keyPath')) next.keyPath = q.get('keyPath');
        if (q.get('rotate') === '1') next.rotate = true;
        remoteCfg.set(next);
        stopRemoteListener();        // config may have changed scheme/port — always re-listen fresh
        syncRemoteListener();
      } catch (e) {
        res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }
    const cfg = remoteCfg.get();
    const out = { ok: true, enabled: cfg.enabled, port: cfg.port, tls: cfg.tls, running: !!(remoteSrv && remoteSrv.listening), error: remoteErr };
    // The pairing secret, cert paths and addresses only ever go to the desktop shell (loopback) —
    // a remote caller already knows its own address and must not be able to read the token back.
    if (loopback) { out.addresses = remoteCfg.lanAddresses(); out.token = cfg.token; out.certPath = cfg.certPath; out.keyPath = cfg.keyPath; }
    return res.end(JSON.stringify(out));
  }
  if (demo && await demo.handleApi(req, res, url)) return;
  if (url.pathname === '/api/servers') {
    hosts = loadHosts(); // re-read config on each refresh, so new Host entries show up live
    const out = await inspectHostsWithBudget(hosts);
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(out));
  }
  if (url.pathname === '/api/launch' && req.method === 'POST') {
    const host = url.searchParams.get('server');
    if (!known().has(host)) { res.statusCode = 400; return res.end('unknown host'); }
    const dir = url.searchParams.get('dir') || '~';
    const name = 'claude-' + (path.basename(dir) || 'sess') + '-' + Date.now().toString(36).slice(-4);
    try {
      await run(host, `tmux new-session -d -s ${shq(name)} -c ${shq(dir)} claude`);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: true, name }));
    } catch (e) {
      res.statusCode = 500;
      return res.end(JSON.stringify({ ok: false, error: String(e.stderr || e.message || e).trim() }));
    }
  }
  if (url.pathname === '/api/ls') {
    const host = url.searchParams.get('server'), dir = url.searchParams.get('path');
    const listError = listPathError(host, dir);
    if (listError) return jsonError(res, 400, listError);
    if (host === 'local') {
      try {
        const ents = fs.readdirSync(dir, { withFileTypes: true });
        const items = ents.map(e => { let size = 0; try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch {} return { type: e.isDirectory() ? 'd' : 'f', size, name: e.name }; });
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(items));
      } catch (e) { return jsonError(res, 500, String(e.message || e) || 'Could not list directory.'); }
    }
    try {
      const raw = await run(host, `find ${shq(dir)} -maxdepth 1 -mindepth 1 -printf '%y\\t%s\\t%f\\n' 2>/dev/null | sort || true`);
      const items = raw.split('\n').filter(Boolean).map(l => { const f = l.split('\t'); return { type: f[0], size: +f[1] || 0, name: f.slice(2).join('\t') }; });
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(items));
    } catch (e) { return jsonError(res, 500, String(e.stderr || e.message || e).trim() || 'Could not list directory.'); }
  }
  if (url.pathname === '/api/file') {
    const host = url.searchParams.get('server'), p = url.searchParams.get('path');
    const localHost = host === 'local', dl = url.searchParams.get('dl') === '1';
    if (localHost) { if (!p || !fs.existsSync(p)) { res.statusCode = 400; return res.end(); } }
    else if (!known().has(host) || !validRemotePath(p)) { res.statusCode = 400; return res.end(); }
    if (url.searchParams.get('meta') === '1') {
      let size = 0;
      try { size = localHost ? fs.statSync(p).size : (+(await run(host, `stat -c %s ${shq(p)} 2>/dev/null || echo 0`)).trim() || 0); } catch {}
      res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ size }));
    }
    res.setHeader('content-type', dl ? 'application/octet-stream' : ctOf(p));
    if (dl) { const nm = path.basename(p); res.setHeader('content-disposition', `attachment; filename="${nm.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(nm)}`); }
    if (localHost) {
      const rs = fs.createReadStream(p);
      rs.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); });
      res.on('close', () => rs.destroy());
      return rs.pipe(res);
    }
    const child = spawn(SSH, ['-o', 'BatchMode=yes', host, `cat -- ${shq(p)}`]);
    res.on('close', () => { try { child.kill(); } catch {} });   // client cancelled → don't orphan the ssh child
    child.stdout.pipe(res);
    child.stdout.on('error', () => {});
    child.stderr.on('data', () => {});
    child.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); });
    return;
  }
  if (url.pathname === '/api/download-dir') {
    const host = url.searchParams.get('server'), p = url.searchParams.get('path'), localHost = host === 'local';
    if (localHost) { if (!p || !fs.existsSync(p)) { res.statusCode = 400; return res.end(); } }
    else if (!known().has(host) || !validRemotePath(p)) { res.statusCode = 400; return res.end(); }
    const tgz = (path.basename(String(p).replace(/[\\/]$/, '')) || 'dir') + '.tar.gz';
    res.setHeader('content-type', 'application/gzip');
    res.setHeader('content-disposition', `attachment; filename="${tgz.replace(/[^\x20-\x7e]/g, '_')}"`);
    let child;
    if (localHost) child = spawn('tar', buildLocalArchiveArgs(p));
    else { const parent = p.replace(/\/[^/]+\/?$/, '') || '/', bn = p.replace(/\/$/, '').split('/').pop(); child = spawn(SSH, ['-o', 'BatchMode=yes', host, `tar -czf - -C ${shq(parent)} -- ${shq(bn)}`]); }
    res.on('close', () => { try { child.kill(); } catch {} });   // cancelled download → kill tar/ssh, don't orphan it
    child.stdout.pipe(res); child.stdout.on('error', () => {}); child.stderr.on('data', () => {});
    child.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(); });
    return;
  }
  if (url.pathname === '/api/upload' && req.method === 'PUT') {
    const host = url.searchParams.get('server'), dir = url.searchParams.get('path'), localHost = host === 'local';
    const leaf = path.posix.basename(String(url.searchParams.get('name') || '')).replace(/[\\/\x00-\x1f]/g, '');
    if (!leaf || leaf === '..') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad name' })); }
    if ((+req.headers['content-length'] || 0) > 2 * 1024 * 1024 * 1024) { res.statusCode = 413; return res.end(JSON.stringify({ ok: false, error: 'too large (2 GiB cap)' })); }
    if (localHost) {
      if (!dir || !fs.existsSync(dir)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad dir' })); }
      const dest = path.join(dir, leaf), tmp = dest + '.corral.part', ws = fs.createWriteStream(tmp);
      req.pipe(ws);
      req.on('aborted', () => { ws.destroy(); try { fs.unlinkSync(tmp); } catch {} });   // client aborted → drop the .part temp + fd
      ws.on('finish', () => { try { fs.renameSync(tmp, dest); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true })); } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: String(e.message) })); } });
      ws.on('error', () => { try { fs.unlinkSync(tmp); } catch {} if (!res.headersSent) res.statusCode = 500; res.end(JSON.stringify({ ok: false })); });
      return;
    }
    if (!known().has(host) || !validRemotePath(dir)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad host/dir' })); }
    const dest = dir.replace(/\/$/, '') + '/' + leaf, tmp = dest + '.corral.part';
    const child = spawn(SSH, ['-o', 'BatchMode=yes', host, `cat > ${shq(tmp)} && mv -f -- ${shq(tmp)} ${shq(dest)}`]);
    if (child.stdin) child.stdin.on('error', () => {});
    req.on('aborted', () => { try { child.kill(); } catch {} });   // abort → don't orphan the remote cat/ssh
    req.pipe(child.stdin);
    child.on('close', code => { if (res.writableEnded) return; res.setHeader('content-type', 'application/json'); if (code === 0) res.end(JSON.stringify({ ok: true })); else { res.statusCode = 500; res.end(JSON.stringify({ ok: false, error: 'remote write failed' })); } });
    child.on('error', () => { if (!res.headersSent) res.statusCode = 500; res.end(JSON.stringify({ ok: false })); });
    return;
  }
  // mkdir / rename / delete — single-user, token-gated file management (same gates as read/upload).
  if (url.pathname === '/api/fileop' && req.method === 'POST') {
    const host = url.searchParams.get('server'), op = url.searchParams.get('op'), p = url.searchParams.get('path') || '';
    const localHost = host === 'local';
    const json = (code, obj) => { res.statusCode = code; res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(obj)); };
    if (!['mkdir', 'rename', 'delete'].includes(op)) return json(400, { ok: false, error: 'bad op' });
    const leaf = safeLeaf(url.searchParams.get('name'));
    if ((op === 'mkdir' || op === 'rename') && !leaf) return json(400, { ok: false, error: 'bad name' });
    if (op === 'delete' && protectedRoot(p)) return json(400, { ok: false, error: 'refusing to delete a root' });
    if (localHost) {
      try {
        if (!p || !fs.existsSync(p)) return json(400, { ok: false, error: 'not found' });
        if (op === 'mkdir') fs.mkdirSync(path.join(p, leaf));
        else if (op === 'rename') fs.renameSync(p, path.join(path.dirname(p), leaf));
        else fs.rmSync(p, { recursive: true, force: true });
        return json(200, { ok: true });
      } catch (e) { return json(500, { ok: false, error: String(e.message || e) }); }
    }
    if (!known().has(host) || !validRemotePath(p)) return json(400, { ok: false, error: 'bad host/path' });
    const noslash = p.replace(/\/+$/, '');
    const cmd = op === 'mkdir' ? `mkdir -- ${shq(noslash + '/' + leaf)}`
      : op === 'rename' ? `mv -- ${shq(noslash)} ${shq((noslash.replace(/\/[^/]*$/, '') || '') + '/' + leaf)}`
      : `rm -rf -- ${shq(noslash)}`;
    try { await run(host, cmd); return json(200, { ok: true }); }
    catch (e) { return json(500, { ok: false, error: String(e.stderr || e.message || e).trim() }); }
  }
  // git diff of a session's working dir — "what did the agent change?" (read-only, token-gated).
  if (url.pathname === '/api/git/diff') {
    const host = url.searchParams.get('server'), p = url.searchParams.get('path') || '', localHost = host === 'local';
    const json = (o) => { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(o)); };
    if (localHost) { if (!p || !fs.existsSync(p)) { res.statusCode = 400; return json({ isRepo: false, diff: '', untracked: [] }); } }
    else if (!known().has(host) || !validRemotePath(p)) { res.statusCode = 400; return json({ isRepo: false, diff: '', untracked: [] }); }
    let isRepo = true, diff = '', untracked = [];
    try {
      if (localHost) {
        try { diff = execFileSync('git', ['-C', p, 'diff', 'HEAD'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }); }
        catch (e) { try { execFileSync('git', ['-C', p, 'rev-parse', '--is-inside-work-tree'], { stdio: 'ignore' }); diff = (e.stdout || '').toString(); } catch { isRepo = false; } }  // diff HEAD fails with no commits => still a repo
        if (isRepo) { try { untracked = execFileSync('git', ['-C', p, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch {} }
      } else {
        const out = await run(host, `cd ${shq(p)} 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 && { git diff HEAD 2>/dev/null; printf '\\n<<<U>>>\\n'; git ls-files --others --exclude-standard 2>/dev/null; } || printf '<<<NOREPO>>>'`);
        if (out.includes('<<<NOREPO>>>')) isRepo = false;
        else { const i = out.indexOf('<<<U>>>'); diff = i >= 0 ? out.slice(0, i) : out; untracked = i >= 0 ? out.slice(i + 7).split('\n').filter(Boolean) : []; }
      }
      return json({ isRepo, diff: diff || '', untracked });
    } catch (e) { res.statusCode = 500; return json({ isRepo, diff: '', untracked: [], error: String(e.message || e) }); }
  }
  // --- agent chat sessions (claude | codex | opencode; Claude-style stream-json wire) ---
  if (url.pathname === '/api/chat/launch' && req.method === 'POST') {
    const host = url.searchParams.get('host') || 'local';
    const dir = url.searchParams.get('dir') || '';
    const model = url.searchParams.get('model') || undefined;
    const permissionMode = url.searchParams.get('perm') || 'auto';
    const agent = url.searchParams.get('agent') || 'claude';
    const prompt = url.searchParams.get('prompt') || undefined;   // optional first message
    const worktree = url.searchParams.get('worktree') === '1';    // isolate the agent in a fresh git worktree
    if (!chat.AGENTS.has(agent)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown agent' })); }
    if (worktree && host !== 'local') { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'worktree launches are supported on local repos only' })); }
    if (host === 'local') {
      let cwd = dir || os.homedir();
      if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad dir' })); }
      if (worktree) {
        // verify dir is inside a repo, then check the branch/worktree out NEXT TO the repo; the
        // session launches in the worktree so the operator's own tree stays untouched.
        const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        const gitErr = e => String(e.stderr || e.message || e).trim();
        let repoRoot;
        try { repoRoot = git(['-C', cwd, 'rev-parse', '--show-toplevel']).trim(); }
        catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: gitErr(e) || 'not a git repository' })); }
        const wt = buildWorktreeArgs({ dir: cwd, repoRoot });
        if (fs.existsSync(wt.target)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'worktree target already exists: ' + wt.target })); }
        try { git(wt.args); } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: gitErr(e) || 'git worktree add failed' })); }
        cwd = wt.target;
      }
      try { const s = chat.launch({ agent, host: 'local', cwd, model, permissionMode, prompt, worktree }); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, id: s.id })); }
      catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    }
    if (!known().has(host)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown host' })); }
    if (dir && !validRemotePath(dir)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'bad dir' })); }
    try { const s = chat.launch({ agent, host, cwd: dir || undefined, model, permissionMode, prompt }); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, id: s.id })); }
    catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
  }
  if (url.pathname === '/api/hosts') {
    hosts = loadHosts();
    res.setHeader('content-type', 'application/json');
    // hostname: what this box calls itself — the phone uses it as the default ranch name.
    return res.end(JSON.stringify({ local: os.homedir().replace(/\\/g, '/'), hosts, hostname: os.hostname() }));
  }
  if (url.pathname === '/api/chat/list') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(chat.list()));
  }
  // stop the current turn but keep the session alive — the fleet view's long-press "whoa there"
  if (url.pathname === '/api/chat/interrupt' && req.method === 'POST') {
    const ok = chat.interrupt(url.searchParams.get('id'));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: ok !== false }));
  }
  if (url.pathname === '/api/chat/kill' && req.method === 'POST') {
    chat.kill(url.searchParams.get('id'));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/chat/remove' && req.method === 'POST') {
    chat.remove(url.searchParams.get('id'));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/chat/resume' && req.method === 'POST') {
    // resume uses the agent stored on the roster record; an explicit param must still be sane
    const agentParam = url.searchParams.get('agent');
    if (agentParam && !chat.AGENTS.has(agentParam)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown agent' })); }
    try {
      const s = await chat.resume(url.searchParams.get('id'));
      res.setHeader('content-type', 'application/json');
      if (s) return res.end(JSON.stringify({ ok: true, id: s.id }));
      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'cannot resume' }));
    } catch (e) {
      res.statusCode = 500; res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }
  // --- the overnight ranch: a per-backend job queue drained sequentially into git worktrees,
  // with a keep/bounce review gate (queue.js). All local-only in 0.7, like worktree launches.
  if (url.pathname === '/api/queue/list') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(queue.list()));
  }
  if (url.pathname === '/api/queue/add' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json');
    try {
      const job = queue.add({ dir: url.searchParams.get('dir') || '', prompt: url.searchParams.get('prompt') || '',
        agent: url.searchParams.get('agent') || 'claude', model: url.searchParams.get('model') || null,
        perm: url.searchParams.get('perm') || 'auto' });
      return res.end(JSON.stringify({ ok: true, id: job.id }));
    } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
  }
  if (url.pathname === '/api/queue/remove' && req.method === 'POST') {
    const ok = await queue.remove(url.searchParams.get('id'));
    res.setHeader('content-type', 'application/json');
    if (!ok) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown job or still running/reviewable' })); }
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/queue/move' && req.method === 'POST') {
    const ok = queue.move(url.searchParams.get('id'), url.searchParams.get('to'));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: ok !== false }));
  }
  if (url.pathname === '/api/queue/hold' && req.method === 'POST') {
    const ok = queue.setHold(+url.searchParams.get('until'));
    res.setHeader('content-type', 'application/json');
    if (!ok) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'until must be a future epoch-ms timestamp' })); }
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/queue/release' && req.method === 'POST') {
    queue.release();
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true }));
  }
  if (url.pathname === '/api/queue/keep' && req.method === 'POST') {
    const r = await queue.keep(url.searchParams.get('id'));
    res.setHeader('content-type', 'application/json');
    if (!r.ok) res.statusCode = r.conflict ? 409 : 400;    // 409: merge refused — job degraded to `conflict`
    return res.end(JSON.stringify(r));
  }
  if (url.pathname === '/api/queue/bounce' && req.method === 'POST') {
    const r = await queue.bounce(url.searchParams.get('id'));
    res.setHeader('content-type', 'application/json');
    if (!r.ok) res.statusCode = 400;
    return res.end(JSON.stringify(r));
  }
  // answer a pending permission prompt over plain HTTP — the phone's herd view responds in one
  // tap using the requestId surfaced on the roster (list().pendingPerm.id), no chat socket needed
  if (url.pathname === '/api/chat/permission' && req.method === 'POST') {
    const ok = chat.respondPermission(url.searchParams.get('id'), String(url.searchParams.get('requestId') || ''), url.searchParams.get('decision'));
    res.setHeader('content-type', 'application/json');
    if (!ok) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown session/request or bad decision' })); }
    return res.end(JSON.stringify({ ok: true }));
  }
  // operator display label on a roster session — trimmed/capped in chat.setLabel, empty clears
  if (url.pathname === '/api/chat/label' && req.method === 'POST') {
    const ok = chat.setLabel(url.searchParams.get('id'), url.searchParams.get('label') || '');
    res.setHeader('content-type', 'application/json');
    if (!ok) { res.statusCode = 404; return res.end(JSON.stringify({ ok: false, error: 'unknown session' })); }
    return res.end(JSON.stringify({ ok: true }));
  }
  // --- phone push (ntfy-compatible relay) ---
  if (url.pathname === '/api/push') {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(pushCfg.get()));
    if (req.method === 'POST') {
      try {
        const q = url.searchParams;
        const next = {};
        for (const k of ['enabled', 'actions', 'appClick', 'input', 'done', 'fail']) if (q.has(k)) next[k] = q.get(k) === '1';
        if (q.has('server')) next.server = q.get('server');
        if (q.has('topic')) next.topic = q.get('topic');
        return res.end(JSON.stringify({ ok: true, config: pushCfg.set(next) }));
      } catch (e) {
        res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
      }
    }
  }
  if (url.pathname === '/api/push/test' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json');
    try {
      await pushCfg.send({ title: 'Corral test', body: 'Push notifications are wired up.', tags: 'bell', priority: 'default' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.statusCode = 502; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }
  // --- Web Push (no relay): the phone subscribes via the service worker and we push straight
  // to the browser vendor's endpoint (webpush.js). Params ride the query string like every
  // other mutation here.
  if (url.pathname === '/api/webpush' && req.method === 'GET') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify(webpush.status()));
  }
  if (url.pathname === '/api/webpush/subscribe' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json');
    try {
      const q = url.searchParams;
      return res.end(JSON.stringify({ ok: true, ...webpush.subscribe({ endpoint: q.get('endpoint'), p256dh: q.get('p256dh'), auth: q.get('auth') }) }));
    } catch (e) {
      res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }
  if (url.pathname === '/api/webpush/unsubscribe' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ ok: true, ...webpush.unsubscribe(url.searchParams.get('endpoint')) }));
  }
  if (url.pathname === '/api/webpush/test' && req.method === 'POST') {
    res.setHeader('content-type', 'application/json');
    try {
      await webpush.notify({ title: 'Corral test', body: 'Web Push is wired up.' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.statusCode = 502; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
  }
  // full-text search across local claude transcripts — "which session talked about X?"
  // Cold path: serial newest-first scan (agents/claude.searchHistory) that bails at `limit`.
  if (url.pathname === '/api/history/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (q.length < 2) return jsonError(res, 400, 'q must be at least 2 characters');
    const limit = Math.max(1, Math.min(100, +url.searchParams.get('limit') || 20));
    res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ hits: chat.searchHistory(q, limit) }));
  }
  // --- port forwarding (ssh -L) ---
  if (url.pathname === '/api/tunnels') {
    if (req.method === 'GET') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(tunnels.list())); }
    if (req.method === 'POST') {
      const host = url.searchParams.get('server');
      if (!known().has(host)) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: 'unknown host' })); }
      try {
        const t = await tunnels.add({ host, remoteHost: url.searchParams.get('remoteHost') || '127.0.0.1', remotePort: url.searchParams.get('remotePort'), localPort: url.searchParams.get('localPort'), http: url.searchParams.get('http') === '1' });
        res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, id: t.id, localPort: t.localPort }));
      } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ ok: false, error: String(e.message || e) })); }
    }
    if (req.method === 'DELETE') { tunnels.remove(url.searchParams.get('id')); res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true })); }
  }
  // An /api path nothing above handled must NOT fall through to the SPA fallback — serving HTML
  // to an API client turns a version mismatch into a cryptic JSON.parse error in the UI.
  if (url.pathname.startsWith('/api/')) return jsonError(res, 404, 'unknown API route: ' + url.pathname);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  const fp = path.join(WEBROOT, rel);
  if (!insideDir(WEBROOT, fp)) { res.statusCode = 403; return res.end(); }
  const CT = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.png': 'image/png', '.map': 'application/json' };
  fs.readFile(fp, (err, buf) => {
    if (err) {
      // SPA fallback: an unknown path with no file extension serves index.html
      if (!path.extname(rel)) return fs.readFile(path.join(WEBROOT, 'index.html'), (e2, b2) => {
        if (e2) { res.statusCode = 404; return res.end('not found'); }
        res.setHeader('content-type', 'text/html'); res.setHeader('content-security-policy', CSP); res.end(b2);
      });
      res.statusCode = 404; return res.end('not found');
    }
    res.setHeader('cache-control', 'no-store'); // local dev tool — always serve fresh
    const ct = CT[path.extname(fp)] || 'application/octet-stream';
    res.setHeader('content-type', ct);
    if (ct === 'text/html') res.setHeader('content-security-policy', CSP);
    res.end(buf);
  });
};
const server = http.createServer(handleRequest);

// WebSocket upgrade routing: /ws = tmux terminal bridge, /chat = local Claude stream-json chat,
// /events = server-push channel (session roster + tunnel snapshots).
const wss = new WebSocketServer({ noServer: true });
const chatWss = new WebSocketServer({ noServer: true });
const eventsWss = new WebSocketServer({ noServer: true });
const handleUpgrade = (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (!originAllowed(req.headers.origin)) return socket.destroy();
  if (pathname === '/ws') wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  else if (pathname === '/chat') chatWss.handleUpgrade(req, socket, head, ws => chatWss.emit('connection', ws, req));
  else if (pathname === '/events') eventsWss.handleUpgrade(req, socket, head, ws => eventsWss.emit('connection', ws, req));
  else socket.destroy();
};
server.on('upgrade', handleUpgrade);

// --- LAN listener for remote access (phone pairing) — opt-in, stopped again on disable.
// With a PEM pair configured (tailscale cert / mkcert / real cert) it serves TLS instead. ---
let remoteSrv = null, remoteErr = '';
function stopRemoteListener() {
  if (!remoteSrv) return;
  const srv = remoteSrv;
  remoteSrv = null;
  try { srv.close(); } catch (e) {}
  console.log('corral remote access stopped');
}
function syncRemoteListener() {
  const cfg = remoteCfg.get();
  if (cfg.enabled && !remoteSrv) {
    remoteErr = '';
    let srv;
    try {
      srv = cfg.tls ? https.createServer(remoteCfg.loadTls(), handleRequest) : http.createServer(handleRequest);
    } catch (e) {
      remoteErr = String((e && e.message) || e);   // unreadable cert/key — surface in the pairing UI
      console.error('[remote] tls:', remoteErr);
      return;
    }
    srv.on('upgrade', handleUpgrade);
    srv.on('error', e => {
      remoteErr = e && e.code === 'EADDRINUSE' ? `port ${cfg.port} is already in use` : String((e && e.message) || e);
      console.error('[remote] listener error:', remoteErr);
      try { srv.close(); } catch (x) {}
      if (remoteSrv === srv) remoteSrv = null;
    });
    remoteSrv = srv;
    srv.listen(cfg.port, '0.0.0.0', () => console.log(`corral remote access on ${cfg.tls ? 'https' : 'http'}://0.0.0.0:${cfg.port}`));
  } else if (!cfg.enabled && remoteSrv) {
    stopRemoteListener();
  }
}

// /events: push a fresh snapshot whenever anything changes (debounced), so the UI can stop
// polling sessions/tunnels while connected. Hosts stay poll-based — their probes are expensive.
// Same first-frame auth pattern as /chat.
const eventsClients = new Set();
const pushFrame = frame => { const j = JSON.stringify(frame); for (const c of eventsClients) if (c.readyState === 1) c.send(j); };
const debouncedPush = (make, ms = 200) => {
  let timer = null;
  return () => {
    if (timer || !eventsClients.size) return;
    timer = setTimeout(() => { timer = null; pushFrame(make()); }, ms);
    timer.unref?.();
  };
};
chat.onAnyChange(debouncedPush(() => ({ type: 'sessions', sessions: chat.list() })));
tunnels.onChange(debouncedPush(() => ({ type: 'tunnels', tunnels: tunnels.list() })));
queue.onChange(debouncedPush(() => ({ type: 'queue', queue: queue.list() })));
eventsWss.on('connection', (ws, req) => {
  if (demo) return demo.handleEvents(ws);
  let authed = !needsAuth(req);
  const doSub = () => {
    eventsClients.add(ws);
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'sessions', sessions: chat.list() }));    // initial snapshot
    ws.send(JSON.stringify({ type: 'tunnels', tunnels: tunnels.list() }));
    ws.send(JSON.stringify({ type: 'queue', queue: queue.list() }));
  };
  if (authed) doSub();
  const authTimer = !authed ? setTimeout(() => { if (!authed) ws.close(); }, 5000) : null;
  ws.on('message', m => {
    let msg; try { msg = JSON.parse(m); } catch { return; }
    if (!authed) {
      if (msg.type === 'auth' && reqTokenOk(req, msg.token)) { authed = true; clearTimeout(authTimer); doSub(); }
      else ws.close();
    }
  });
  ws.on('close', () => { clearTimeout(authTimer); eventsClients.delete(ws); });
});

// /chat: attach a websocket to a local Claude session (replays scrollback, then streams live).
// Client sends {type:'input',text} to send a user message; {type:'auth',token} first if a token is set.
chatWss.on('connection', (ws, req) => {
  if (demo) return demo.handleChat(ws, req);
  const url = new URL(req.url, 'http://x');
  const id = url.searchParams.get('id');
  let authed = !needsAuth(req), attached = false;
  const doAttach = () => { if (attached) return; attached = true; if (!chat.attach(id, ws)) ws.close(); };
  if (authed) doAttach();
  const authTimer = !authed ? setTimeout(() => { if (!attached) ws.close(); }, 5000) : null;
  ws.on('message', m => {
    let msg; try { msg = JSON.parse(m); } catch { return; }
    if (!authed) {
      if (msg.type === 'auth' && reqTokenOk(req, msg.token)) { authed = true; clearTimeout(authTimer); doAttach(); }
      else ws.close();
      return;
    }
    if (msg.type === 'input' && id) chat.send(id, msg.text);
    else if (msg.type === 'interrupt' && id) chat.interrupt(id);
    else if (msg.type === 'permission' && id) chat.respondPermission(id, String(msg.requestId || ''), msg.decision);
  });
  ws.on('close', () => clearTimeout(authTimer));
});

// terminal bridge: one real PTY per socket — local shell, plain interactive ssh (optional cwd),
// or `ssh -tt … tmux attach` for a named target. Resize propagates through the PTY.
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  if (!originAllowed(req.headers.origin)) return ws.close();
  if (!pty) { try { ws.send('\r\n[terminal unavailable on this platform]\r\n'); } catch (x) {} return ws.close(); }
  const host = url.searchParams.get('server') || 'local';
  const target = url.searchParams.get('target') || '';
  let cwd = url.searchParams.get('cwd') || '';
  const cols = +url.searchParams.get('cols') || 80;
  const rows = +url.searchParams.get('rows') || 24;
  const local = host === 'local';
  if (!local && !known().has(host)) return ws.close();
  if (local) { try { if (cwd && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) cwd = ''; } catch { cwd = ''; } }
  else if (cwd && !validRemotePath(cwd)) cwd = '';
  let p = null;
  const start = () => {
    const sp = buildTermSpawn({ host, target, cwd });
    try { p = pty.spawn(sp.bin, sp.args, { name: 'xterm-256color', cols, rows, cwd: sp.cwd }); }
    catch (e) { try { ws.send('\r\n[terminal spawn failed: ' + String(e.message || e) + ']\r\n'); } catch (x) {} return ws.close(); }
    p.onData(d => ws.readyState === 1 && ws.send(d));
    p.onExit(() => ws.close());
  };
  // When auth is required (token set, or any non-loopback socket), the socket must prove it with
  // a first {type:'auth',token} frame BEFORE any pty is spawned; otherwise we attach immediately.
  const mustAuth = needsAuth(req);
  const authTimer = mustAuth ? setTimeout(() => { if (!p) ws.close(); }, 5000) : null;
  if (!mustAuth) start();
  ws.on('message', m => {
    let msg; try { msg = JSON.parse(m); } catch { return; }
    if (!p) {                                   // not yet authed -> only an auth frame is accepted
      if (msg.type === 'auth' && reqTokenOk(req, msg.token)) { clearTimeout(authTimer); start(); }
      else ws.close();
      return;
    }
    if (msg.type === 'data') p.write(msg.data);
    else if (msg.type === 'resize') p.resize(msg.cols, msg.rows);
  });
  ws.on('close', () => { clearTimeout(authTimer); if (p) p.kill(); });
});

const PORT = process.env.PORT || 7878;
const BIND = process.env.CORRAL_BIND || process.env.CODAPP_BIND || '127.0.0.1';   // loopback only; never 0.0.0.0
// On-device (pocket) builds: host the CONNECT proxy the musl claude binary needs for DNS.
if (process.env.CORRAL_DNS_PROXY_PORT) {
  const p = Math.floor(+process.env.CORRAL_DNS_PROXY_PORT);
  if (p >= 1024 && p <= 65535) require('./connectproxy').startConnectProxy({ port: p });
  else console.error(`CORRAL_DNS_PROXY_PORT=${process.env.CORRAL_DNS_PROXY_PORT} invalid (1024-65535) — proxy not started`);
}
if (!demo) tunnels.restorePersisted();                   // reap orphaned ssh forwards, then bring last run's tunnels back up
if (!demo) syncRemoteListener();                         // phone pairing left enabled last run comes back up with it
// Kill every child (agent sessions + ssh forwards) and flush the roster on the way out. The
// 'exit' hook covers any path that actually brings the process down — including a fatal throw —
// while the uncaughtException handler above deliberately keeps the sidecar alive.
const cleanup = () => { try { chat.killAll(); } catch (e) {} try { tunnels.killAll(); } catch (e) {} try { poolKillAll(); } catch (e) {} try { chat.flush(); } catch (e) {} try { queue.flush(); } catch (e) {} };
const shutdown = () => { cleanup(); process.exit(); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('exit', cleanup);
// Single-instance guard: another backend already bound means a second instance would clobber the
// shared roster/tunnel files and reap its children — exit loudly instead of lingering half-alive
// (the global uncaughtException keep-alive would otherwise swallow this fatal startup error).
server.on('error', e => {
  if (e && e.code === 'EADDRINUSE') { console.error(`another instance is already listening on ${BIND}:${PORT} — exiting`); process.exit(1); }
  throw e;
});
server.listen(PORT, BIND, () => console.log(`corral on http://${BIND}:${PORT}  (${hosts.length} hosts, ssh=${SSH}, auth=${TOKEN ? 'token' : 'dev'})`));
}
