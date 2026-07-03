// agents/claude.js — Claude Code adapter: spawns the raw `claude` CLI in stream-json mode.
// Claude's native protocol IS the frontend wire format, so the "translator" is a pass-through
// line parser; the other adapters (codex/opencode) translate into these same shapes.
//
// SUBSCRIPTION GUARANTEE: we spawn the raw `claude` CLI (never the Agent SDK, which forces
// API-key billing) and delete ANTHROPIC_API_KEY from the child env and never pass --bare, so a
// session can only ever authenticate via the user's OAuth/subscription. apiKeySource in the
// system/init event must read "none" — if it ever doesn't, something is mis-spawning.
const { spawn, execFile } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { resolveBin, SSH, SSH_OPTS, shq, SAFE_ARG, SAFE_HOST, lineSplitter } = require('./common');

// Resolve the real claude binary once; prefer the .exe so Node 24 can spawn it without a shell.
// Fallback stays 'claude' (not null): claude is the default agent and a miss here still gets a
// clear ENOENT _error at spawn time.
const CLAUDE = resolveBin('claude', 'claude');

// claude ships its own permission modes, so corral's modes pass through 1:1
// (auto | default | plan | acceptEdits — bypassPermissions/dontAsk rejected upstream).
const available = () => '';

// Build the spawn target for a local or remote claude session (pure -> unit-testable).
// Remote runs: ssh host "cd <dir> && claude <stream-json flags>" over clean pipes.
function buildSpawn({ host, cwd, model, permissionMode = 'auto', safe = false, resumeId } = {}) {
  const remote = !!host && host !== 'local';
  const cargs = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json',
    '--verbose', '--include-partial-messages', '--permission-mode', permissionMode];
  // Ask mode: route permission prompts to us over stdio (undocumented but what the Agent SDKs
  // pass). Without it headless -p auto-denies instead of emitting can_use_tool control requests.
  if (permissionMode === 'default') cargs.push('--permission-prompt-tool', 'stdio');
  if (resumeId) cargs.push('--resume', resumeId);
  if (safe) cargs.push('--safe-mode');
  if (model) cargs.push('--model', model);
  if (remote) {
    // Run under a login shell (`bash -lc`) so the user's profile PATH is loaded — a plain
    // `ssh host "claude …"` uses a non-login shell that skips ~/.profile, so `claude` (typically in
    // ~/.local/bin or a version-manager dir) isn't found and the session dies with exit code 127.
    const inner = (cwd ? 'cd ' + shq(cwd) + ' && ' : '') + 'claude ' + cargs.map(shq).join(' ');
    return { remote, bin: SSH, args: [...SSH_OPTS, host, 'bash -lc ' + shq(inner)], cwd: undefined };
  }
  // Pocket/embedded builds override the binary (CORRAL_CLAUDE_BIN) and, when the binary's own
  // PT_INTERP doesn't exist on the platform (claude's musl build on Android), run it through an
  // explicit dynamic loader (CORRAL_EXEC_LOADER <claude> <args…>). Read per-call, not at module
  // load, so the hooks are testable and a launcher can set them for the whole backend process.
  const bin = process.env.CORRAL_CLAUDE_BIN || CLAUDE;
  const loader = process.env.CORRAL_EXEC_LOADER || '';
  if (loader) return { remote, bin: loader, args: [bin, ...cargs], cwd: cwd || process.cwd() };
  return { remote, bin, args: cargs, cwd: cwd || process.cwd() };
}

// Pass-through stream-json line parser (pure): claude already emits the wire format.
function parseLine(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// --- interactive tool approvals (permissionMode 'default'): the CLI emits a control_request
// {subtype:'can_use_tool'} and blocks the turn until a control_response arrives on stdin. Shapes
// vary across CLI versions (subtype/tool fields sometimes nest under .request), so parse both;
// responses use the nested form the official Agent SDKs send. Known caveat: headless -p mode has
// a reported bug (anthropics/claude-code#34046) where these may not emit — corral still handles
// them whenever they do, and answers unknown subtypes with an error so a session never hangs.
function parseControlRequest(ev) {   // pure -> selftested
  const req = ev.request || ev;
  if (req.subtype !== 'can_use_tool') return null;
  return { id: String(ev.request_id), tool: req.tool_name || 'tool', input: req.input || {},
    suggestions: req.permission_suggestions || req.suggestions || [] };
}
function buildPermissionResponse(pend, decision) {   // pure -> selftested
  if (decision === 'deny') return { behavior: 'deny', message: 'Denied by the operator' };
  const r = { behavior: 'allow', updatedInput: pend.input || {} };
  if (decision === 'allow-always' && pend.suggestions && pend.suggestions.length) r.updatedPermissions = pend.suggestions;
  return r;
}
const writeLine = (s, obj) => { try { s.proc.stdin.write(JSON.stringify(obj) + '\n'); return true; } catch { return false; } };
function handleControlRequest(s, io, ev) {
  const pend = parseControlRequest(ev);
  if (pend) {
    (s._claudePerms = s._claudePerms || new Map()).set(pend.id, pend);
    io.push({ type: '_permission_request', id: pend.id, tool: pend.tool, input: pend.input });
    return;
  }
  // unknown control subtype: answer with an error instead of leaving the CLI blocked on us
  writeLine(s, { type: 'control_response', response: { subtype: 'error', request_id: ev.request_id, error: 'unsupported control request' } });
}
function respondPermission(s, io, requestId, decision) {
  const pend = s._claudePerms && s._claudePerms.get(requestId);
  if (!pend || !s.proc) return false;
  s._claudePerms.delete(requestId);
  const ok = writeLine(s, { type: 'control_response',
    response: { subtype: 'success', request_id: pend.id, response: buildPermissionResponse(pend, decision) } });
  if (ok) io.push({ type: '_permission_resolved', id: requestId, decision });
  return ok;
}

// Spawn (or resume: --resume <sessionId>) and wire the child into the session's io sink.
// opts: { cwd, model, safe, resumeId } — resume passes cwd only, mirroring the original manager.
function start(s, io, { cwd, model, safe, resumeId } = {}) {
  const sp = buildSpawn({ host: s.host, cwd, model, permissionMode: s.permissionMode, safe, resumeId });
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;                 // subscription guarantee (local; the remote uses its own env)
  // Pocket builds: route only the agent's traffic through the backend's CONNECT proxy (musl DNS
  // fix). Scoped to the child so the backend's own HTTP keeps using the platform resolver directly.
  if (process.env.CORRAL_AGENT_HTTPS_PROXY) env.HTTPS_PROXY = env.HTTP_PROXY = process.env.CORRAL_AGENT_HTTPS_PROXY;
  const proc = s.proc = spawn(sp.bin, sp.args, { cwd: sp.cwd, env });
  s.pid = proc.pid || null;                     // persisted so a crashed run's orphan can be reaped
  s._claudePerms = new Map();
  proc.stdout.on('data', lineSplitter(line => {
    const ev = parseLine(line);
    if (!ev) return;
    if (ev.type === 'control_request') return handleControlRequest(s, io, ev);   // not a UI event
    if (ev.type === 'control_response') return;                                  // ack of our interrupt
    io.push(ev);
  }));
  proc.stderr.on('data', d => io.push({ type: '_stderr', text: String(d) }));
  proc.on('close', code => { if (s._claudePerms) s._claudePerms.clear(); io.exit(code); });
  proc.on('error', e => io.fail(e.message));
  // A dropped child (claude exits, or the remote ssh link drops) can fire EPIPE on a later write.
  // Without a listener that's an unhandled 'error' event → it crashes the whole backend sidecar.
  if (proc.stdin) proc.stdin.on('error', () => {});
  // SDK-style handshake: without it the CLI treats the client as non-interactive and auto-denies
  // permission prompts instead of sending can_use_tool (verified live against 2.1.198). The ack
  // arrives as a control_response, which the stdout parser above swallows.
  writeLine(s, { type: 'control_request', request_id: 'init-' + Date.now().toString(36), request: { subtype: 'initialize', hooks: null } });
}

// Write one stream-json user message into the session's stdin.
function write(s, io, text) {
  try { s.proc.stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'); }
  catch { /* child stdin already gone; the proc 'close' handler reconciles status */ }
}

let reqSeq = 0;
// Interrupt the current turn but keep the session alive. Verified: claude acks with a
// control_response{success} and ends the turn with result/error_during_execution.
function interrupt(s) {
  try { s.proc.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'int-' + (++reqSeq), request: { subtype: 'interrupt' } }) + '\n'); }
  catch { return false; }
  return true;
}

// --- transcript replay: so resuming a dormant session shows its history instead of a blank panel.
// claude writes each session to ~/.claude/projects/<slug>/<sessionId>.jsonl. We locate the file by
// id (filename IS the session id) rather than reconstructing <slug> from cwd — claude normalises the
// cwd into the slug in platform-specific ways that are fragile to mirror.
const PROJECTS = path.join(os.homedir(), '.claude', 'projects');
function transcriptPath(sessionId) {
  if (!sessionId || !SAFE_ARG.test(sessionId)) return null;     // guard the path we build from it
  let dirs; try { dirs = fs.readdirSync(PROJECTS); } catch { return null; }
  for (const d of dirs) {
    const f = path.join(PROJECTS, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}
// Convert claude's .jsonl into the same events the live stream emits, so Chat.svelte renders them
// with its existing code path. Only real user/assistant turns; skip sidechain (sub-agent) and the
// queue-operation/attachment/last-prompt bookkeeping lines. Pure (text in -> events out) for testing.
function parseTranscript(raw) {
  const out = [];
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.isSidechain || !e.message) continue;
    if (e.type === 'assistant') out.push({ type: 'assistant', message: e.message });
    else if (e.type === 'user') {
      const c = e.message.content;
      if (Array.isArray(c) && c.some(b => b && b.type === 'tool_result')) out.push({ type: 'user', message: e.message });
      else {
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b && b.type === 'text').map(b => b.text).join('\n') : '';
        if (text.trim()) out.push({ type: '_user', text });
      }
    }
  }
  return out;
}
// --- history search (Phase 6): full-text scan over the local transcript store, so the operator
// can find "that session where we talked about X". The query is a literal substring (never a
// regex), matched case-insensitively against real user/assistant text only.
// ~180 chars of one message centered on the match, whitespace collapsed for one-line display.
function searchSnippet(text, idx, qlen, width = 180) {
  const half = Math.max(0, Math.ceil((width - qlen) / 2));
  const start = Math.max(0, idx - half), end = Math.min(text.length, idx + qlen + half);
  let snip = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snip = '…' + snip;
  if (end < text.length) snip += '…';
  return snip;
}
// Pure scan of one transcript (raw .jsonl + query -> { cwd, matches }) — selftested. Same line
// discipline as parseTranscript (skip sidechains/bookkeeping) but stops at `max` matches and
// only extracts text blocks; tool_result payloads don't count as conversation text.
function searchTranscriptText(raw, q, max = 3) {
  const needle = String(q).toLowerCase();
  const out = { cwd: '', matches: [] };
  if (!needle) return out;
  // A needle with no JSON-escaped chars must appear literally in the raw line — cheap skip
  // before JSON.parse. Lines still parse until the first cwd (records carry cwd) is captured.
  const literal = !/["\\]|[^\x20-\x7e]/.test(needle);
  for (const line of String(raw).split('\n')) {
    if (!line.trim()) continue;
    if (out.cwd) {
      if (out.matches.length >= max) break;
      if (literal && !line.toLowerCase().includes(needle)) continue;
    }
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (!out.cwd && typeof e.cwd === 'string' && e.cwd) out.cwd = e.cwd;
    if (out.matches.length >= max) continue;                    // parsed only for the cwd
    if (e.isSidechain || !e.message || (e.type !== 'user' && e.type !== 'assistant')) continue;
    const c = e.message.content;
    const text = typeof c === 'string' ? c
      : Array.isArray(c) ? c.filter(b => b && b.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n') : '';
    const i = text.toLowerCase().indexOf(needle);
    if (i >= 0) out.matches.push({ role: e.type, snippet: searchSnippet(text, i, needle.length) });
  }
  return out;
}
const HISTORY_MAX_FILE = 20 * 1024 * 1024;    // a transcript bigger than this is pathological — skip it
// Walk ~/.claude/projects newest-first, one file in memory at a time, bailing once `limit`
// sessions hit — a cold-path search over possibly hundreds of small files.
function searchHistory(q, limit = 20) {
  let dirs; try { dirs = fs.readdirSync(PROJECTS); } catch { return []; }
  const files = [];
  for (const d of dirs) {
    let ents; try { ents = fs.readdirSync(path.join(PROJECTS, d)); } catch { continue; }
    for (const f of ents) {
      if (!f.endsWith('.jsonl')) continue;
      const full = path.join(PROJECTS, d, f);
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || st.size > HISTORY_MAX_FILE) continue;
      files.push({ sessionId: f.slice(0, -6), file: full, mtime: Math.round(st.mtimeMs) });
    }
  }
  files.sort((x, y) => y.mtime - x.mtime);
  const hits = [];
  for (const f of files) {
    if (hits.length >= limit) break;
    let raw; try { raw = fs.readFileSync(f.file, 'utf8'); } catch { continue; }
    const { cwd, matches } = searchTranscriptText(raw, q, 3);
    if (matches.length) hits.push({ sessionId: f.sessionId, file: f.file, cwd, mtime: f.mtime, matches });
  }
  return hits;
}

// Fetch a session's transcript — local from disk, remote by ssh-cat. The filename IS the session id,
// so a glob over the remote projects dir finds it whatever the cwd slug is; sessionId is
// SAFE_ARG-validated, so it can't break out of the remote command.
function localTranscript(sessionId) {
  const f = transcriptPath(sessionId);
  if (!f) return '';
  try { return fs.readFileSync(f, 'utf8'); } catch { return ''; }
}
const remoteTranscript = (host, sid) => new Promise((res) => {
  execFile(SSH, ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', host, 'cat ~/.claude/projects/*/' + sid + '.jsonl 2>/dev/null'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 12000 }, (e, out) => res(e ? '' : out));
});
async function loadTranscriptEvents(host, sessionId) {
  if (!sessionId || !SAFE_ARG.test(sessionId)) return [];
  const local = !host || host === 'local';
  if (!local && !SAFE_HOST.test(host)) return [];        // reject argv flag smuggling into ssh
  const raw = local ? localTranscript(sessionId) : await remoteTranscript(host, sessionId);
  return parseTranscript(raw);
}

module.exports = { kind: 'claude', CLAUDE, available, buildSpawn, parseLine, start, write, interrupt, parseTranscript, loadTranscriptEvents,
  searchTranscriptText, searchHistory, parseControlRequest, buildPermissionResponse, respondPermission };
