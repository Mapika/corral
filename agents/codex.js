// agents/codex.js — OpenAI Codex CLI adapter: one `codex app-server` child per session speaking
// JSON-RPC 2.0 over stdio (one JSON object per line — same interface the VS Code extension uses).
// Native notifications are TRANSLATED into Claude-style stream-json events so the existing Chat
// UI renders codex turns unchanged. Shapes verified against the local 0.141.0 schema bundle
// (`codex app-server generate-json-schema`); see docs/agent-integration-notes.md.
//
// BILLING: CODEX_API_KEY is scrubbed from the child env (mirror of the claude ANTHROPIC_API_KEY
// scrub) so a session authenticates via the user's ChatGPT login in ~/.codex/auth.json.
const { spawn } = require('child_process');
const { resolveBin, SSH, SSH_OPTS, shq, lineSplitter } = require('./common');

const CODEX = resolveBin('codex');            // null => not installed locally (remote is still fine)

function available(host) {
  if (host && host !== 'local') return '';    // remote sessions run the remote host's codex
  return CODEX ? '' : 'codex not installed on this machine';
}

// corral permissionMode -> codex thread/start params (the documented mapping):
//   default     -> { approvalPolicy: 'untrusted', sandbox: 'workspace-write' }  Ask: any non-trivial
//                  command asks FIRST via the in-chat permission UI, and an approved command runs
//                  escalated (outside the sandbox) — which also sidesteps machines where the
//                  Windows sandbox isn't set up. ('on-request' would run sandboxed without asking.)
//   auto        -> { approvalPolicy: 'never', sandbox: 'workspace-write' }
//   acceptEdits -> { approvalPolicy: 'never', sandbox: 'workspace-write' }  (alias of auto)
//   plan        -> { approvalPolicy: 'never', sandbox: 'read-only' }
function permParams(mode) {
  if (mode === 'default') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' };
  return { approvalPolicy: 'never', sandbox: mode === 'plan' ? 'read-only' : 'workspace-write' };
}

// Build the spawn target (pure -> selftested). Local spawns the resolved codex.exe (the npm .cmd
// shim would need shell:true); remote wraps in a login shell over ssh with keepalives, exactly
// like the claude adapter, so PATH loads and dead links surface as process exit.
function buildSpawn({ host } = {}) {
  const remote = !!host && host !== 'local';
  if (!remote) return { remote, bin: CODEX || 'codex', args: ['app-server'], cwd: undefined };
  return { remote, bin: SSH, args: [...SSH_OPTS, host, 'bash -lc ' + shq('codex app-server')], cwd: undefined };
}

// --- native -> Claude-style translation (pure functions over an explicit state; selftested) ---
// One codex TURN maps onto one Claude assistant "message": each item (agent text, reasoning,
// command, tool call) becomes a content block with its own index. Blocks stream live via
// stream_event deltas (transient — not buffered by chat.js) and are finalized as complete
// buffered assistant/user events, mirroring claude's --include-partial-messages behavior.
function newTranslateState({ model = null, permissionMode = 'auto', cwd = null } = {}) {
  return { threadId: null, turnId: null, model, permissionMode, cwd, inited: false,
    msgOpen: false, nextIndex: 0, blocks: new Map(), usage: null };
}
const sev = (st, event) => ({ type: 'stream_event', session_id: st.threadId, event });
const asstEvent = (st, content) => ({ type: 'assistant', session_id: st.threadId,
  message: { role: 'assistant', model: st.model, content, usage: st.usage || undefined } });

// system/init from a thread/start | thread/resume result (or thread/started notification).
// The codex threadId becomes the session's sessionId; apiKeySource 'none' = subscription auth.
function initEvent(st, thread, model) {
  st.threadId = thread.id; st.inited = true;
  if (model) st.model = model;
  return { type: 'system', subtype: 'init', session_id: thread.id, model: st.model, cwd: st.cwd,
    permissionMode: st.permissionMode, apiKeySource: 'none', agent: 'codex', tools: [] };
}

function openBlock(st, key, contentBlock) {   // -> [events, block] (opens message/block as needed)
  const evs = [];
  if (!st.msgOpen) { st.msgOpen = true; evs.push(sev(st, { type: 'message_start', message: { role: 'assistant', content: [] } })); }
  let b = st.blocks.get(key);
  if (!b) {
    b = { index: st.nextIndex++, open: true };
    st.blocks.set(key, b);
    evs.push(sev(st, { type: 'content_block_start', index: b.index, content_block: contentBlock }));
  }
  return [evs, b];
}
function closeBlock(st, key) {
  const b = st.blocks.get(key);
  if (!b || !b.open) return [];
  b.open = false;
  return [sev(st, { type: 'content_block_stop', index: b.index })];
}

// Tool-ish items -> claude tool_use naming/inputs. summarize() in the UI looks for
// command/path/query-like keys, so keep the native fields under those names.
function toolInfo(item) {
  if (item.type === 'commandExecution') return { name: 'Bash', input: { command: item.command } };
  if (item.type === 'mcpToolCall') return { name: (item.server ? item.server + '.' : '') + (item.tool || 'tool'), input: item.arguments || {} };
  if (item.type === 'fileChange') return { name: 'Edit', input: { changes: item.changes } };
  if (item.type === 'webSearch') return { name: 'WebSearch', input: { query: item.query } };
  return null;
}
const asText = v => typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v, null, 1);
function toolResult(item) {
  if (item.type === 'commandExecution') return { content: String(item.aggregatedOutput ?? ''), isError: item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0) };
  if (item.type === 'mcpToolCall') return { content: item.error ? asText(item.error.message || item.error) : asText(item.result), isError: item.status === 'failed' || !!item.error };
  if (item.type === 'fileChange') return { content: asText(item.changes), isError: item.status === 'failed' };
  if (item.type === 'webSearch') return { content: asText(item.action || ''), isError: false };
  return null;
}

// Translate one server notification into zero-or-more Claude-style events (the mapping table in
// docs/agent-integration-notes.md). Unknown methods are ignored — new ones appear often.
function translateEvent(st, msg) {
  const p = msg.params || {};
  const out = [];
  switch (msg.method) {
    case 'thread/started':
      if (!st.inited && p.thread) out.push(initEvent(st, p.thread));
      else if (p.thread) st.threadId = p.thread.id;
      break;
    case 'turn/started':                       // fresh claude message per turn
      if (p.turn) st.turnId = p.turn.id;
      st.msgOpen = false; st.nextIndex = 0; st.blocks = new Map();
      break;
    case 'item/agentMessage/delta': {
      const [evs, b] = openBlock(st, p.itemId, { type: 'text' });
      out.push(...evs, sev(st, { type: 'content_block_delta', index: b.index, delta: { type: 'text_delta', text: p.delta || '' } }));
      break;
    }
    case 'item/reasoning/summaryTextDelta': {
      const [evs, b] = openBlock(st, p.itemId, { type: 'thinking' });
      out.push(...evs, sev(st, { type: 'content_block_delta', index: b.index, delta: { type: 'thinking_delta', thinking: p.delta || '' } }));
      break;
    }
    case 'item/started': {                     // tool-ish items open a tool_use block up front
      const item = p.item || {};
      const t = toolInfo(item);
      if (!t) break;
      const [evs, b] = openBlock(st, item.id, { type: 'tool_use', id: item.id, name: t.name });
      out.push(...evs,
        sev(st, { type: 'content_block_delta', index: b.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(t.input || {}) } }),
        ...closeBlock(st, item.id),
        asstEvent(st, [{ type: 'tool_use', id: item.id, name: t.name, input: t.input || {} }]));
      break;
    }
    case 'item/completed': {
      const item = p.item || {};
      if (item.type === 'agentMessage') {
        out.push(...closeBlock(st, item.id), asstEvent(st, [{ type: 'text', text: item.text || '' }]));
      } else if (item.type === 'reasoning') {
        const text = Array.isArray(item.summary) ? item.summary.join('\n\n') : String(item.summary || '');
        out.push(...closeBlock(st, item.id), asstEvent(st, [{ type: 'thinking', thinking: text }]));
      } else if (item.type === 'userMessage') {
        // our own echo already rendered it live; only replay paths translate these (see below)
      } else {
        const r = toolResult(item);
        if (!r) break;                         // plan/todo/review markers etc — no claude shape
        if (!st.blocks.has(item.id)) {         // completed without item/started (replay): emit the pair
          const t = toolInfo(item);
          out.push(asstEvent(st, [{ type: 'tool_use', id: item.id, name: t.name, input: t.input || {} }]));
        }
        out.push(...closeBlock(st, item.id),
          { type: 'user', session_id: st.threadId, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: item.id, content: r.content, is_error: r.isError }] } });
      }
      break;
    }
    case 'thread/tokenUsage/updated': {        // remembered; attached to assistant/result events
      const u = (p.tokenUsage && (p.tokenUsage.last || p.tokenUsage.total)) || {};
      st.usage = { input_tokens: u.inputTokens || 0, output_tokens: u.outputTokens || 0, cache_read_input_tokens: u.cachedInputTokens || 0 };
      break;
    }
    case 'turn/completed': {
      const turn = p.turn || {};
      for (const key of [...st.blocks.keys()]) out.push(...closeBlock(st, key));
      st.msgOpen = false;
      out.push({ type: 'result', session_id: st.threadId,
        subtype: turn.status === 'completed' ? 'success' : 'error_during_execution',
        is_error: turn.status === 'failed',
        duration_ms: turn.durationMs ?? undefined,
        usage: st.usage || undefined,
        ...(turn.error ? { result: asText(turn.error.message || turn.error) } : {}) });
      break;
    }
    case 'error':                              // transient retries render as claude's api_retry pill
      if (p.willRetry) out.push({ type: 'system', subtype: 'api_retry', session_id: st.threadId });
      else out.push({ type: '_error', message: asText((p.error && (p.error.message || p.error)) || 'codex error') });
      break;
    default: break;                            // ignore unknown notification methods
  }
  return out;
}

// thread/resume returns the full turn history (thread.turns[].items) — convert it to the same
// buffered events a live turn produces so a resumed panel isn't blank (pure -> selftested).
function translateThreadItems(thread) {
  const st = newTranslateState({});
  st.threadId = thread.id; st.inited = true;
  const out = [];
  for (const turn of thread.turns || []) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') {
        const c = item.content;
        const text = typeof c === 'string' ? c
          : Array.isArray(c) ? c.map(x => (x && (x.text || x.type === 'text' && x.text)) || '').filter(Boolean).join('\n') : asText(c);
        if (String(text).trim()) out.push({ type: '_user', text: String(text) });
        continue;
      }
      out.push(...translateEvent(st, { method: 'item/completed', params: { item } }).filter(e => e.type !== 'stream_event'));
    }
  }
  return out;
}

// APPROVALS — codex sends them as server->client JSON-RPC *requests* (they carry an id; the turn
// blocks until answered). In 'default' (Ask) mode they surface as _permission_request events and
// wait for the operator; every other mode auto-responds (plan declines, the rest accept — with
// approvalPolicy 'never' these should rarely fire at all).
function onApprovalRequest(s, req) {
  if (!/requestApproval$/.test(req.method || '')) return {};   // unknown request kinds: empty result
  return { decision: s.permissionMode === 'plan' ? 'decline' : 'accept' };
}
// UI-facing prompt fields from a JSON-RPC approval request (pure -> selftested).
function approvalInfo(req) {
  const p = req.params || {};
  if (req.method === 'item/commandExecution/requestApproval') return { tool: 'Bash', input: { command: p.command || '' } };
  if (req.method === 'item/fileChange/requestApproval') return { tool: 'Edit', input: { changes: p.changes || p.fileChanges || [] } };
  return { tool: String(req.method || 'tool').replace(/\/requestApproval$/, ''), input: p };
}
const APPROVAL_DECISIONS = { allow: 'accept', 'allow-always': 'acceptForSession', deny: 'decline' };
function respondPermission(s, io, requestId, decision) {
  const st = s._codex;
  const m = st && st.pendingApprovals.get(requestId);
  if (!m) return false;
  st.pendingApprovals.delete(requestId);
  st.send({ id: m.id, result: { decision: APPROVAL_DECISIONS[decision] || 'decline' } });
  io.push({ type: '_permission_resolved', id: requestId, decision });
  return true;
}

// Route one parsed JSONL message: our request's response, a server->client request (approval),
// or a notification to translate.
function onMessage(s, io, st, m) {
  if (m.id != null && m.method) {
    if (/requestApproval$/.test(m.method) && s.permissionMode === 'default') {
      const key = String(m.id);
      st.pendingApprovals.set(key, m);
      const info = approvalInfo(m);
      io.push({ type: '_permission_request', id: key, tool: info.tool, input: info.input, reason: (m.params || {}).reason || undefined });
      return;
    }
    return st.send({ id: m.id, result: onApprovalRequest(s, m) });
  }
  if (m.id != null) {
    const pend = st.pending.get(m.id);
    if (pend) { st.pending.delete(m.id); m.error ? pend.reject(new Error(m.error.message || 'codex rpc error')) : pend.resolve(m.result); }
    return;
  }
  if (m.method) for (const ev of translateEvent(st.ts, m)) io.push(ev);
}

function startTurn(s, io, st, text) {
  st.rpc('turn/start', { threadId: st.ts.threadId, input: [{ type: 'text', text }] })
    .then(r => { if (r && r.turn) st.ts.turnId = r.turn.id; })
    .catch(e => {                             // failed turn: surface + unstick the busy status
      io.push({ type: '_error', message: 'codex turn/start: ' + String(e && e.message || e) });
      io.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: st.ts.threadId });
    });
}

// Spawn the app-server child, do the initialize/initialized handshake, then thread/start (or
// thread/resume). opts: { cwd, model, resumeId, replay } — replay pushes the resumed thread's
// history into the scrollback (chat.js sets it only for dormant roster sessions).
function start(s, io, { cwd, model, resumeId, replay } = {}) {
  const sp = buildSpawn({ host: s.host });
  const env = { ...process.env };
  delete env.CODEX_API_KEY;                   // billing guarantee: ChatGPT-subscription auth
  const proc = s.proc = spawn(sp.bin, sp.args, { env });
  s.pid = proc.pid || null;                   // chat.js persists this for orphan reaping
  const st = s._codex = { seq: 0, pending: new Map(), pendingApprovals: new Map(), queue: [], ready: false,
    ts: newTranslateState({ model, permissionMode: s.permissionMode, cwd: cwd && cwd !== '~' ? cwd : null }) };
  st.send = obj => { try { proc.stdin.write(JSON.stringify(obj) + '\n'); } catch { /* close handler reconciles */ } };
  st.rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++st.seq; st.pending.set(id, { resolve, reject }); st.send({ id, method, params });
  });
  proc.stdout.on('data', lineSplitter(line => { let m; try { m = JSON.parse(line); } catch { return; } onMessage(s, io, st, m); }));
  proc.stderr.on('data', d => io.push({ type: '_stderr', text: String(d) }));
  proc.on('close', code => { for (const p of st.pending.values()) p.reject(new Error('codex exited')); st.pending.clear(); st.pendingApprovals.clear(); io.exit(code); });
  proc.on('error', e => io.fail(e.message));
  if (proc.stdin) proc.stdin.on('error', () => {});
  return (async () => {
    await st.rpc('initialize', { clientInfo: { name: 'corral', title: 'Corral', version: '1.0.0' }, capabilities: { experimentalApi: false } });
    st.send({ method: 'initialized', params: {} });
    const perm = permParams(s.permissionMode);
    const res = resumeId
      ? await st.rpc('thread/resume', { threadId: resumeId, cwd: st.ts.cwd || undefined, model: model || undefined, ...perm })
      : await st.rpc('thread/start', { cwd: st.ts.cwd || undefined, model: model || undefined, ...perm });
    const thread = (res && res.thread) || {};
    if (!st.ts.inited) io.push(initEvent(st.ts, thread, (res && res.model) || model));
    if (resumeId && replay) for (const ev of translateThreadItems(thread)) io.push(ev);
    st.ready = true;
    for (const text of st.queue.splice(0)) startTurn(s, io, st, text);
  })();
  // chat.js attaches .catch(io.fail) to this promise — a failed handshake lands as _error+status.
}

// Queue user messages until the thread exists, then turn/start each one.
function write(s, io, text) {
  const st = s._codex;
  if (!st) return;
  if (!st.ready) { st.queue.push(text); return; }
  startTurn(s, io, st, text);
}

// Interrupt the running turn but keep the thread alive (turnId arrives via turn/started).
function interrupt(s) {
  const st = s._codex;
  if (!st || !st.ts.threadId || !st.ts.turnId) return false;
  st.rpc('turn/interrupt', { threadId: st.ts.threadId, turnId: st.ts.turnId }).catch(() => {});
  return true;
}

module.exports = { kind: 'codex', CODEX, available, permParams, buildSpawn,
  newTranslateState, translateEvent, translateThreadItems, initEvent, onApprovalRequest,
  approvalInfo, APPROVAL_DECISIONS, respondPermission, start, write, interrupt };
