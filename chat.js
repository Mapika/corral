// chat.js — agent chat sessions (claude | codex | opencode) driven through per-agent adapters
// that all emit the same Claude-style stream-json wire format, so the frontend renders every
// agent unchanged.
//
// This manager owns everything agent-agnostic: the roster + durable persistence, the bounded
// event ring, websocket fan-out, pid tracking + orphan reaping, and the stuck-busy watchdog.
// Everything agent-specific (spawn argv, native-protocol translation, resume, interrupt) lives
// in agents/*.js — including the Claude subscription guarantee (raw CLI + ANTHROPIC_API_KEY
// scrub, see agents/claude.js).
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const os = require('os');
const fs = require('fs');
const path = require('path');

const push = require('./push');
const claude = require('./agents/claude');
const codex = require('./agents/codex');
const opencode = require('./agents/opencode');
const { SSH, SAFE_ARG, SAFE_HOST, PERM_MODES } = require('./agents/common');

const adapters = { claude, codex, opencode };   // permission-mode mapping lives in each adapter
const AGENTS = new Set(Object.keys(adapters));
const CLAUDE = claude.CLAUDE;

const EVENT_CAP = 5000;          // bounded scrollback ring per session
const sessions = new Map();      // id -> session record

// Persist a small roster of sessions to disk so they survive an app restart and can be resumed
// (per-agent: claude --resume, codex thread/resume, opencode ses_* reuse). Only durable metadata
// is stored — never the live process or the event scrollback. ponytail: one shared file; two
// backends running at once would clobber it.
// Data dir: ~/.corral, but an existing ~/.codapp (pre-rename) keeps being used so nobody's
// session roster disappears on upgrade.
const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const ROSTER = path.join(DATA_DIR, 'sessions.json');
const durable = s => ({ id: s.id, agent: s.agent || 'claude', host: s.host, cwd: s.cwd, model: s.model, permissionMode: s.permissionMode, sessionId: s.sessionId, createdAt: s.createdAt, updatedAt: s.updatedAt || s.createdAt, status: s.status, pid: s.pid || null, note: s.note || null, label: s.label || null, worktree: !!s.worktree, costUsd: s.costUsd ?? null, tokIn: s.tokIn || 0, tokOut: s.tokOut || 0 });
const touch = (s, now = Date.now()) => { if (s) s.updatedAt = now; };

// Roster-change hook: the /events push channel subscribes here. Fired on every emit/persist; the
// subscriber debounces, so per-token bursts are fine.
let onChangeCb = null;
function onAnyChange(cb) { onChangeCb = cb; }
const changed = () => { if (onChangeCb) try { onChangeCb(); } catch (e) {} };

const rosterJson = () => JSON.stringify([...sessions.values()].filter(s => s.sessionId).map(durable).slice(-50));
// Debounced async persist: coalesce event bursts into one atomic write (tmp + rename) ~500ms out.
// flush() (shutdown path) forces the pending state to disk synchronously so nothing is lost on exit.
let persistTimer = null;
function persist() {
  changed();
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await fs.promises.mkdir(path.dirname(ROSTER), { recursive: true });
      await fs.promises.writeFile(ROSTER + '.tmp', rosterJson());
      await fs.promises.rename(ROSTER + '.tmp', ROSTER);
    } catch (e) {}
  }, 500);
  persistTimer.unref?.();
}
function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    fs.mkdirSync(path.dirname(ROSTER), { recursive: true });
    fs.writeFileSync(ROSTER + '.tmp', rosterJson());
    fs.renameSync(ROSTER + '.tmp', ROSTER);
  } catch (e) {}
}

// What a corral-spawned agent child looks like: an agent CLI itself (claude/codex/opencode), the
// ssh wrapper for a remote session, or a node shim launching one. Anything else at that pid means
// the pid was reused by an unrelated process — never kill it.
const AGENT_IMAGE = /\b(claude|codex|opencode|ssh|node)(\.exe)?\b/i;
function looksLikeAgentProc(pid) {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { windowsHide: true }).toString()
      : execFileSync('ps', ['-o', 'comm=', '-p', String(pid)]).toString();
    return AGENT_IMAGE.test(out);
  } catch { return false; }
}
function killTree(pid) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
    else process.kill(pid, 'SIGTERM');
  } catch (e) {}
}
// Shutdown: kill every live child so no agent/ssh keeps running headless after the app exits.
// Windows taskkill /T takes the whole tree; POSIX gets SIGTERM now and SIGKILL shortly after
// (the fallback timer is unref()'d — on an immediate process.exit the SIGTERM is all they get).
// Sessions on a shared adapter process (opencode serve) are skipped here — the adapter's own
// killAll takes that process down exactly once.
function killAll() {
  for (const s of sessions.values()) {
    if (!s.proc || (adapters[s.agent] || {}).sharedProc) continue;
    if (process.platform === 'win32' && s.proc.pid) killTree(s.proc.pid);
    else {
      try { s.proc.kill('SIGTERM'); } catch (e) {}
      const t = setTimeout(() => { try { s.proc && s.proc.kill('SIGKILL'); } catch (e) {} }, 1500);
      t.unref?.();
    }
  }
  for (const A of Object.values(adapters)) if (A.killAll) try { A.killAll(); } catch (e) {}
}
// Re-hydrate past sessions as dormant records (no process) so they show up and can be resumed.
// An entry that still carries a pid is a child of a previous run that died without cleanup —
// best-effort kill it, but only after the identity check above so PID reuse never shoots an
// unrelated process (same discipline as tunnels.reapOrphans).
function loadRoster() {
  let reaped = false;
  try {
    for (const r of JSON.parse(fs.readFileSync(ROSTER, 'utf8'))) {
      if (r && r.pid) { if (looksLikeAgentProc(r.pid)) killTree(r.pid); r.pid = null; reaped = true; }
      if (!r || !r.id || !r.sessionId || sessions.has(r.id)) continue;
      const agent = AGENTS.has(r.agent) ? r.agent : 'claude';    // pre-multi-agent rosters were all claude
      sessions.set(r.id, { ...r, agent, updatedAt: r.updatedAt || r.createdAt || Date.now(), status: 'dormant', proc: null, pid: null, events: [], subs: new Set() });
    }
  } catch (e) {}
  if (reaped) persist();                        // clear the stale pids from disk
}

function emit(s, ev) {
  touch(s);
  changed();
  // stream_event deltas are transient (the complete `assistant` event follows). Forward them live
  // for token streaming, but don't buffer them — so a reattaching client replays clean, complete
  // messages instead of thousands of token deltas.
  if (ev.type !== 'stream_event') {
    s.events.push(ev);
    if (s.events.length > EVENT_CAP) s.events.splice(0, s.events.length - EVENT_CAP);
  }
  for (const ws of s.subs) if (ws.readyState === 1) ws.send(JSON.stringify(ev));
}

// Per-session sink handed to the adapter. Every adapter pushes Claude-style events through here,
// so session-id capture, status transitions, persistence and fan-out are identical for all
// agents; exit/fail mirror what the old claude-only proc handlers did.
function mkIO(s) {
  const io = {
    push(ev) {
      s.lastEventAt = Date.now();               // the watchdog's liveness signal
      if (ev.type === 'system' && ev.subtype === 'init') {
        s.sessionId = ev.session_id;            // claude session id / codex thread id / opencode ses_*
        if (ev.model) s.model = ev.model;
        s.apiKeySource = ev.apiKeySource;
        if (s.status === 'starting') s.status = 'idle';
        touch(s);
        persist();
      }
      if (ev.type === 'result') {
        s.status = 'idle'; touch(s);
        // cumulative usage for the roster/dashboard: claude's total_cost_usd is session-cumulative;
        // tokens accumulate per finished turn for every agent.
        if (ev.total_cost_usd != null) s.costUsd = ev.total_cost_usd;
        if (ev.usage) { s.tokIn = (s.tokIn || 0) + (ev.usage.input_tokens || 0); s.tokOut = (s.tokOut || 0) + (ev.usage.output_tokens || 0); }
        persist();
        // phone push only when nothing follows automatically (a queued follow-up keeps the turn going)
        if (!(s.inputQueue && s.inputQueue.length)) push.notifySession('done', s, { costUsd: ev.total_cost_usd });
      }
      if (ev.type === '_permission_request') push.notifySession('input', s, { tool: ev.tool });
      emit(s, ev);
      // a queued follow-up goes out the moment the turn ends (its _user echo already rendered)
      if (ev.type === 'result' && s.inputQueue && s.inputQueue.length && s.status === 'idle') {
        const next = s.inputQueue.shift();
        s.status = 'busy'; touch(s); persist();
        (adapters[s.agent] || claude).write(s, io, next);
      }
    },
    exit(code) {
      s.inputQueue = []; s.status = 'exited'; s.proc = null; s.pid = null; emit(s, { type: '_exit', code }); persist();
      if (!s._userEnded) push.notifySession('fail', s, { detail: code != null ? 'exit code ' + code : '' });
    },
    fail(msg) {
      s.inputQueue = []; s.status = 'error'; emit(s, { type: '_error', message: msg }); persist();
      push.notifySession('fail-error', s, { detail: msg });
    },
  };
  return io;
}
// Adapter start() may be sync (claude spawns inline) or async (codex handshake, opencode HTTP) —
// normalize both failure paths into the session's error state.
function runStart(A, s, io, opts) {
  let r;
  try { r = A.start(s, io, opts); } catch (e) { return io.fail(String((e && e.message) || e)); }
  if (r && typeof r.catch === 'function') r.catch(e => io.fail(String((e && e.message) || e)));
}

// Launch a new session. opts: { agent, host, cwd, model, permissionMode, prompt, safe, worktree }.
// `prompt` (optional) is the first user message — sent immediately so the agent never idles.
// `worktree` just flags the record — server.js already created the worktree and passes its cwd.
function launch({ agent = 'claude', host, cwd, model, permissionMode = 'auto', prompt, safe = false, worktree = false } = {}) {
  if (!AGENTS.has(agent)) throw new Error('unknown agent: ' + agent);
  const A = adapters[agent];
  const unavailable = A.available ? A.available(host) : '';
  if (unavailable) throw new Error(unavailable);                                             // e.g. 'codex not installed on this machine'
  if (!PERM_MODES.has(permissionMode)) permissionMode = 'auto';                              // refuse bypassPermissions/dontAsk
  if (model != null && !SAFE_ARG.test(model)) throw new Error('invalid model: ' + model);    // block argv flag smuggling
  const id = crypto.randomUUID();
  const now = Date.now();
  const remote = !!host && host !== 'local';
  const s = { id, agent, host: host || 'local', cwd: cwd || (remote ? '~' : process.cwd()), model: model || null, permissionMode,
    worktree: !!worktree, proc: null, status: 'starting', sessionId: null, createdAt: now, updatedAt: now, lastEventAt: now, events: [], subs: new Set() };
  sessions.set(id, s);
  s._io = mkIO(s);
  runStart(A, s, s._io, { cwd, model, safe });   // raw cwd: remote '' means "ssh default dir", not '~'
  persist();
  if (prompt != null) send(id, prompt);
  return s;
}

// Revive an ended/dormant session in its original host/cwd: claude re-spawns with --resume,
// codex re-spawns app-server + thread/resume, opencode re-attaches to its ses_* id. The
// conversation continues with full memory; a dormant session's prior transcript is replayed
// into the scrollback so the panel isn't blank.
async function resume(id) {
  const s = sessions.get(id);
  if (!s) return null;
  if (s.proc && s.status !== 'exited' && s.status !== 'error') return s;     // already live
  if (!s.sessionId || !SAFE_ARG.test(s.sessionId)) return null;             // nothing safe to resume
  if (s.host && s.host !== 'local' && !SAFE_HOST.test(s.host)) return null;  // reject a tampered-roster host before it reaches ssh
  const A = adapters[s.agent] || claude;
  const unavailable = A.available ? A.available(s.host) : '';
  if (unavailable) throw new Error(unavailable);
  // Replay the prior history only when events are empty (a dormant roster session — a
  // still-in-memory session already has them). claude reads its .jsonl transcript up front
  // (local disk / remote ssh-cat); codex/opencode replay inside start() from their own stores.
  const replay = s.events.length === 0;
  if (replay && A.loadTranscriptEvents) {
    const hist = await A.loadTranscriptEvents(s.host, s.sessionId);
    if (hist.length) { s.events.push(...hist); if (s.events.length > EVENT_CAP) s.events.splice(0, s.events.length - EVENT_CAP); }
  }
  if (!PERM_MODES.has(s.permissionMode)) s.permissionMode = 'auto';
  s.status = 'starting'; s.lastEventAt = Date.now(); touch(s);
  s._io = mkIO(s);
  runStart(A, s, s._io, { cwd: s.cwd, resumeId: s.sessionId, replay });
  emit(s, { type: '_resumed' });
  persist();
  return s;
}

// Send a follow-up user message into an existing session (adapters queue until ready). A message
// sent mid-turn is queued here and dispatched by mkIO the moment the current turn's result lands —
// the _user echo renders immediately either way, so the transcript reads in send order.
function send(id, text) {
  const s = sessions.get(id);
  if (!s || s.status === 'exited' || s.status === 'error') return false;
  if (s.status === 'busy') {
    (s.inputQueue = s.inputQueue || []).push(text);
    emit(s, { type: '_user', text });
    persist();
    return true;
  }
  s.status = 'busy';
  emit(s, { type: '_user', text });             // local echo so the UI shows the message instantly
  persist();
  (adapters[s.agent] || claude).write(s, s._io || (s._io = mkIO(s)), text);
  return true;
}

// Route the operator's answer to a pending _permission_request back into the owning adapter
// (claude control_response / codex JSON-RPC approval / opencode permission reply).
const PERM_DECISIONS = new Set(['allow', 'allow-always', 'deny']);
function respondPermission(id, requestId, decision) {
  const s = sessions.get(id);
  if (!s || !requestId || !PERM_DECISIONS.has(decision)) return false;
  const A = adapters[s.agent] || claude;
  if (!A.respondPermission) return false;
  return A.respondPermission(s, s._io || (s._io = mkIO(s)), String(requestId), decision) !== false;
}

// Attach a websocket: replay buffered events, then stream live ones.
function attach(id, ws) {
  const s = sessions.get(id);
  if (!s) return false;
  for (const ev of s.events) if (ws.readyState === 1) ws.send(JSON.stringify(ev));
  s.subs.add(ws);
  ws.on('close', () => s.subs.delete(ws));
  return true;
}

// Interrupt the current turn but keep the session alive (per-agent: claude control_request,
// codex turn/interrupt, opencode POST abort).
function interrupt(id) {
  const s = sessions.get(id);
  if (!s || s.status === 'exited' || s.status === 'error') return false;
  touch(s); persist();
  return (adapters[s.agent] || claude).interrupt(s) !== false;
}
// End the session: adapters with a shared process (opencode) get their own kill so the shared
// child survives; everyone else just gets their child killed (close handler reconciles status).
function kill(id) {
  const s = sessions.get(id);
  if (!s) return;
  s._userEnded = true;                      // operator-initiated end — never a phone buzz
  const A = adapters[s.agent] || claude;
  if (A.kill) return void A.kill(s, s._io || (s._io = mkIO(s)));
  if (s.proc) try { s.proc.kill(); } catch (e) {}
}
function remove(id) {
  const s = sessions.get(id);
  if (!s) return false;
  try { kill(id); } catch (e) {}
  sessions.delete(id); persist(); return true;
}
function get(id) { return sessions.get(id); }
function list() {
  return [...sessions.values()].map(s =>
    ({ id: s.id, agent: s.agent || 'claude', host: s.host, cwd: s.cwd, model: s.model, status: s.status, sessionId: s.sessionId, createdAt: s.createdAt, updatedAt: s.updatedAt || s.createdAt, note: s.note || null, label: s.label || null, worktree: !!s.worktree, costUsd: s.costUsd ?? null, tokIn: s.tokIn || 0, tokOut: s.tokOut || 0 }));
}

// Operator display label: shows on the roster, never reaches an argv. Control chars stripped,
// trimmed, 60-char cap; empty clears. Cleaner is pure -> selftested.
const cleanLabel = label => String(label ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 60);
function setLabel(id, label) {
  const s = sessions.get(id);
  if (!s) return false;
  s.label = cleanLabel(label) || null;
  touch(s); persist();
  return true;
}

// --- stuck-busy watchdog: a session that claims 'busy' while its process is actually gone will
// never see a result event — demote it to 'error' (with a persisted note) so the UI stops showing
// a phantom spinner. A busy session with a LIVE process is always left alone: long turns are
// legitimate, and dropped ssh links surface as process exit via the keepalives in agents/common.
// opencode sessions point s.proc at the shared serve process, so the same verdict applies.
const WATCHDOG_STALE_MS = 5 * 60 * 1000;
function procAlive(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null || !p.pid) return false;
  try { process.kill(p.pid, 0); return true; } catch { return false; }
}
// Pure verdict (selftested): should this busy session be demoted?
function watchdogVerdict({ status, exited, alive, msSinceEvent }, staleMs = WATCHDOG_STALE_MS) {
  if (status !== 'busy') return false;
  if (exited) return true;                                  // exit code set / proc reaped but status never reconciled
  return !alive && msSinceEvent >= staleMs;                 // silent 5+ min AND the pid is gone
}
function watchdogSweep(now = Date.now()) {
  for (const s of sessions.values()) {
    if (s.status !== 'busy') continue;
    const exited = !s.proc || s.proc.exitCode !== null || s.proc.signalCode !== null;
    if (!watchdogVerdict({ status: s.status, exited, alive: procAlive(s.proc), msSinceEvent: now - (s.lastEventAt || s.updatedAt || s.createdAt || 0) })) continue;
    s.status = 'error'; s.note = 'watchdog: process died mid-turn'; s.proc = null; s.pid = null;
    emit(s, { type: '_error', message: s.note });
    persist();
  }
}
const watchdogTimer = setInterval(watchdogSweep, 30000);
watchdogTimer.unref?.();                                    // must never keep the process alive

module.exports = { launch, buildSpawn: claude.buildSpawn, resume, loadRoster, parseTranscript: claude.parseTranscript,
  searchHistory: claude.searchHistory, setLabel, cleanLabel,
  send, respondPermission, interrupt, attach, kill, remove, get, list, killAll, flush, onAnyChange, watchdogVerdict,
  CLAUDE, SSH, AGENTS, PERM_MODES, PERM_DECISIONS, SAFE_ARG, SAFE_HOST, _sessions: sessions };
