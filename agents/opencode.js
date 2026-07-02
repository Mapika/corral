// agents/opencode.js — OpenCode adapter (LOCAL ONLY for now): one shared `opencode serve`
// process on a dedicated loopback port — spawned lazily on the first opencode session, reused by
// the rest, killed in killAll. Client is Node's built-in http (REST + SSE, no npm deps); native
// SSE events are TRANSLATED into Claude-style stream-json events. Shapes verified against the
// live v1.17.13 OpenAPI (`GET /doc`); see docs/agent-integration-notes.md.
//
// ENV: the child gets the full process env (provider API keys included) — OpenCode is
// API-key-billed by design, unlike the claude/codex subscription scrubs.
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { resolveBin } = require('./common');

// npm ships opencode as a .cmd shim on Windows; prefer the real launcher .exe next to it so we
// can spawn without a shell and get a killable/reapable pid.
const OPENCODE = (() => {
  const found = resolveBin('opencode');
  if (!found || !/\.(cmd|bat)$/i.test(found)) return found;
  const exe = path.join(path.dirname(found), 'node_modules', 'opencode-ai', 'bin', 'opencode.exe');
  try { if (fs.existsSync(exe)) return exe; } catch {}
  return found;
})();

function available(host) {
  if (host && host !== 'local') return 'opencode remote hosts not supported yet';
  return OPENCODE ? '' : 'opencode not installed on this machine';
}

// corral permissionMode -> opencode per-session permission ruleset, injected at POST /session
// ({permission, pattern, action:allow|ask|deny}; last match wins). The documented mapping:
//   default     -> everything asks; permission.asked round-trips through the in-chat UI
//   auto        -> everything allowed (mirrors codex approvalPolicy 'never')
//   acceptEdits -> everything allowed
//   plan        -> edit + bash denied outright (read/explore only); any residual permission.asked
//                  is auto-rejected by onApprovalRequest below.
function permissionRuleset(mode) {
  const all = { permission: '*', pattern: '*', action: 'allow' };
  if (mode === 'default') return [{ permission: '*', pattern: '*', action: 'ask' }];
  if (mode === 'plan') return [all, { permission: 'edit', pattern: '*', action: 'deny' }, { permission: 'bash', pattern: '*', action: 'deny' }];
  return [all];
}

// Auto-response for permission.asked outside 'default' mode (plan rejects, everything else
// approves once); should be rare given the injected rulesets above.
function onApprovalRequest(s, ask) {
  return { response: s.permissionMode === 'plan' ? 'reject' : 'once' };
}
// Operator's answer from the in-chat UI -> opencode permission reply.
const PERM_REPLIES = { allow: 'once', 'allow-always': 'always', deny: 'reject' };
function respondPermission(s, io, requestId, decision) {
  const sid = s.sessionId || (s._oc && s._oc.ts.sesId);
  if (!sid || !serve.port) return false;
  req(serve.port, 'POST', '/session/' + encodeURIComponent(sid) + '/permissions/' + encodeURIComponent(requestId) + dirQ(s),
    { response: PERM_REPLIES[decision] || 'reject' })
    .then(() => {
      const h = serve.handlers.get(sid);
      if (h && h.pending) h.pending.delete(requestId);
      io.push({ type: '_permission_resolved', id: requestId, decision });
    })
    .catch(e => io.push({ type: '_stderr', text: 'opencode permission reply failed: ' + e.message + '\n' }));
  return true;
}

// --- tiny HTTP client against the loopback serve ---
function req(port, method, p, body, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : JSON.stringify(body);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, timeout,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error('opencode ' + method + ' ' + p.split('?')[0] + ' -> ' + res.statusCode + (out ? ': ' + out.slice(0, 200) : '')));
        let json = null; try { json = out ? JSON.parse(out) : null; } catch { }
        resolve(json);
      });
    });
    r.on('error', reject);
    r.on('timeout', () => r.destroy(new Error('opencode request timeout')));
    r.end(data || undefined);
  });
}
const dirQ = s => '?directory=' + encodeURIComponent(s.cwd || '');

// --- the shared serve process + SSE subscriptions routed by sessionID ---
// The event stream is instance-scoped: GET /event?directory=X only carries sessions created in
// that directory (verified live; the bare /event never sees them). So we keep one SSE per
// distinct session directory and still route frames to sessions by properties.sessionID.
const serve = { proc: null, port: 0, starting: null, buses: new Map(), handlers: new Map() };  // dir -> sse req; ses_* -> { s, io, ts }

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  srv.on('error', reject);
});

function ensureServe() {
  // `starting` doubles as the ready promise; it's cleared on startup failure and on serve exit,
  // so concurrent launches share one spawn and a dead server respawns on the next launch.
  if (serve.starting) return serve.starting;
  serve.starting = (async () => {
    const port = await freePort();
    const proc = spawn(OPENCODE, ['serve', '--port', String(port), '--hostname', '127.0.0.1'],
      { env: { ...process.env }, shell: process.platform === 'win32' && /\.(cmd|bat)$/i.test(OPENCODE) });
    serve.proc = proc; serve.port = port;
    proc.on('close', code => onServeExit(code));
    proc.on('error', () => onServeExit(-1));
    if (proc.stdin) proc.stdin.on('error', () => {});
    proc.stdout.on('data', () => {});           // shared across sessions — nothing to attribute it to
    proc.stderr.on('data', () => {});
    const deadline = Date.now() + 20000;        // poll readiness; the binary takes a beat to bind
    for (;;) {
      try { await req(port, 'GET', '/global/health', null, 2000); break; }
      catch { if (Date.now() > deadline || proc.exitCode !== null) throw new Error('opencode serve did not become ready'); await new Promise(r => setTimeout(r, 250)); }
    }
    return port;
  })();
  serve.starting.catch(() => { serve.starting = null; });
  return serve.starting;
}

// The serve process going down takes every opencode session with it.
function onServeExit(code) {
  const dead = [...serve.handlers.values()];
  serve.handlers.clear();
  serve.proc = null; serve.starting = null;
  for (const r of serve.buses.values()) try { r.destroy(); } catch { }
  serve.buses.clear();
  for (const h of dead) h.io.exit(code);
}

// Open (once per directory) the instance-scoped SSE stream and route its frames. Reconnects
// while the serve process is alive — on reconnect the ring buffer already holds completed
// events, and the next snapshot/idle reconciles anything missed.
function ensureBus(dir) {
  if (serve.buses.has(dir)) return;
  const open = () => {
    const r = http.request({ host: '127.0.0.1', port: serve.port, path: '/event?directory=' + encodeURIComponent(dir), method: 'GET', headers: { accept: 'text/event-stream' } }, res => {
      let buf = '';
      res.on('data', d => {
        buf += String(d).replace(/\r\n/g, '\n');
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {  // SSE frames are blank-line separated
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            routeEvent(ev);
          }
        }
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    r.on('error', retry);
    r.end();
    serve.buses.set(dir, r);
  };
  const retry = () => {
    if (!serve.proc || serve.proc.exitCode !== null || !serve.buses.has(dir)) return;
    const t = setTimeout(open, 1000);
    t.unref?.();
  };
  open();
}

function eventSessionId(ev) {
  const p = (ev && ev.properties) || {};
  return p.sessionID || (p.part && p.part.sessionID) || (p.info && p.info.sessionID) || null;
}
function routeEvent(ev) {
  const h = serve.handlers.get(eventSessionId(ev));
  if (!h) return;                               // bus noise / some other client's session
  if (ev.type === 'permission.asked') {
    const ask = ev.properties || {};
    if (h.s.permissionMode === 'default') {     // Ask mode: hold it for the in-chat UI
      (h.pending || (h.pending = new Map())).set(String(ask.id), ask);
      return void h.io.push({ type: '_permission_request', id: String(ask.id), tool: ask.permission || 'tool', input: ask.metadata || {}, patterns: ask.patterns || [] });
    }
    return void req(serve.port, 'POST', '/session/' + encodeURIComponent(ask.sessionID) + '/permissions/' + encodeURIComponent(ask.id) + dirQ(h.s), onApprovalRequest(h.s, ask))
      .catch(e => h.io.push({ type: '_stderr', text: 'opencode permission reply failed: ' + e.message + '\n' }));
  }
  if (ev.type === 'permission.replied') {       // answered here or by another client — settle the card
    const p = ev.properties || {};
    const key = String(p.requestID || p.id || '');
    if (h.pending && h.pending.delete(key)) {
      h.io.push({ type: '_permission_resolved', id: key, decision: p.reply === 'reject' ? 'deny' : p.reply === 'always' ? 'allow-always' : 'allow' });
    }
    return;
  }
  for (const out of translateEvent(h.ts, ev)) h.io.push(out);
}

// --- native SSE -> Claude-style translation (pure over explicit state; selftested) ---
// Each assistant message maps to one Claude message; each part (text/reasoning/tool) is a content
// block. Text streams via message.part.delta AND full-part message.part.updated snapshots — block
// state tracks how much was already emitted (b.sent) so the two paths never double-render.
// Message roles come from message.updated (part events don't carry role); parts of user messages
// are dropped — chat.js already echoes _user on send.
function newTranslateState({ model = null } = {}) {
  return { sesId: null, model, roles: new Map(), msgId: null, msgOpen: false, nextIndex: 0,
    blocks: new Map(), usage: null, costByMsg: new Map(), active: false };
}

// system/init — emitted by the adapter when the session is created/resumed (not from SSE).
// The ses_* id becomes the session's sessionId.
function initEvent(st, info) {
  st.sesId = info.id;
  const model = (info.model && (info.model.modelID || info.model.id)) || st.model;
  if (model) st.model = model;
  return { type: 'system', subtype: 'init', session_id: info.id, model: st.model || null,
    cwd: info.directory || null, apiKeySource: 'none', agent: 'opencode', tools: [] };
}

const sev = (st, event) => ({ type: 'stream_event', session_id: st.sesId, event });
const asstEvent = (st, content) => ({ type: 'assistant', session_id: st.sesId,
  message: { role: 'assistant', model: st.model, content, usage: st.usage || undefined } });
const totalCost = st => { let c = 0, seen = false; for (const v of st.costByMsg.values()) { c += v; seen = true; } return seen ? c : undefined; };

function openBlock(st, partId, contentBlock) {
  const evs = [];
  if (!st.msgOpen) { st.msgOpen = true; evs.push(sev(st, { type: 'message_start', message: { role: 'assistant', content: [] } })); }
  let b = st.blocks.get(partId);
  if (!b) {
    b = { index: st.nextIndex++, open: true, kind: contentBlock.type, sent: 0, toolOpened: false, toolDone: false };
    st.blocks.set(partId, b);
    evs.push(sev(st, { type: 'content_block_start', index: b.index, content_block: contentBlock }));
  }
  return [evs, b];
}
function closeBlock(st, partId) {
  const b = st.blocks.get(partId);
  if (!b || !b.open) return [];
  b.open = false;
  return [sev(st, { type: 'content_block_stop', index: b.index })];
}
const textDelta = (b, text) => b.kind === 'thinking'
  ? { type: 'thinking_delta', thinking: text }
  : { type: 'text_delta', text };

// tool part -> tool_use open + buffered assistant pair (once per part)
function openTool(st, part) {
  const id = part.callID || part.id;
  const input = (part.state && part.state.input) || {};
  const [evs, b] = openBlock(st, part.id, { type: 'tool_use', id, name: part.tool || 'tool' });
  if (b.toolOpened) return [[], b];
  b.toolOpened = true; b.toolId = id;
  evs.push(sev(st, { type: 'content_block_delta', index: b.index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    ...closeBlock(st, part.id),
    asstEvent(st, [{ type: 'tool_use', id, name: part.tool || 'tool', input }]));
  return [evs, b];
}

function translateEvent(st, ev) {
  const p = (ev && ev.properties) || {};
  const out = [];
  switch (ev && ev.type) {
    case 'message.updated': {
      const info = p.info || {};
      if (info.id) st.roles.set(info.id, info.role);
      if (info.role !== 'assistant') break;
      st.active = true;                         // a turn is producing output
      if (info.modelID) st.model = info.modelID;
      if (st.msgId !== info.id) {               // new assistant message => new claude message
        st.msgId = info.id; st.msgOpen = false; st.nextIndex = 0;
      }
      if (info.tokens) st.usage = { input_tokens: info.tokens.input || 0, output_tokens: info.tokens.output || 0,
        cache_read_input_tokens: (info.tokens.cache && info.tokens.cache.read) || 0 };
      if (info.cost != null) st.costByMsg.set(info.id, info.cost);
      break;
    }
    case 'message.part.delta': {                // streaming text/reasoning chunks
      if (p.field !== 'text' || st.roles.get(p.messageID) !== 'assistant') break;
      st.active = true;
      const known = st.blocks.get(p.partID);
      const [evs, b] = known ? [[], known] : openBlock(st, p.partID, { type: 'text' });  // type refined by part.updated if reasoning
      out.push(...evs, sev(st, { type: 'content_block_delta', index: b.index, delta: textDelta(b, p.delta || '') }));
      b.sent += (p.delta || '').length;
      break;
    }
    case 'message.part.updated': {              // full-part snapshot / state transition
      const part = p.part || {};
      if (st.roles.get(part.messageID) !== 'assistant') break;
      st.active = true;
      if (part.type === 'text' || part.type === 'reasoning') {
        const kind = part.type === 'reasoning' ? 'thinking' : 'text';
        const [evs, b] = openBlock(st, part.id, { type: kind });
        out.push(...evs);
        const text = part.text || '';
        if (text.length > b.sent) {             // emit only the unseen suffix (delta/snapshot dedupe)
          out.push(sev(st, { type: 'content_block_delta', index: b.index, delta: textDelta(b, text.slice(b.sent)) }));
          b.sent = text.length;
        }
        if (part.time && part.time.end) {       // completed part -> close + buffered assistant block
          out.push(...closeBlock(st, part.id));
          if (text.trim()) out.push(asstEvent(st, [kind === 'thinking' ? { type: 'thinking', thinking: text } : { type: 'text', text }]));
        }
      } else if (part.type === 'tool') {
        const status = (part.state && part.state.status) || '';
        if (status === 'running') out.push(...openTool(st, part)[0]);
        else if (status === 'completed' || status === 'error') {
          const [evs, b] = openTool(st, part);  // completed without a running snapshot still pairs up
          out.push(...evs);
          if (!b.toolDone) {
            b.toolDone = true;
            out.push({ type: 'user', session_id: st.sesId, message: { role: 'user', content: [{
              type: 'tool_result', tool_use_id: b.toolId,
              content: status === 'error' ? String((part.state && part.state.error) || 'tool error') : String((part.state && part.state.output) ?? ''),
              is_error: status === 'error' }] } });
          }
        }
      }
      break;
    }
    case 'session.status': {                    // {status:{type:idle|busy|retry}}
      const t = p.status && p.status.type;
      if (t === 'busy') st.active = true;
      else if (t === 'idle') { if (st.active) out.push(...endTurn(st, {})); }   // dedupe: session.idle follows
      else if (t === 'retry') out.push({ type: 'system', subtype: 'api_retry', session_id: st.sesId, error_status: p.status.message || undefined });
      break;
    }
    case 'session.idle':                        // legacy alias of session.status idle
      if (st.active) out.push(...endTurn(st, {}));
      break;
    case 'session.error': {                     // always ends the turn, active or not, to unstick 'busy'
      const e = p.error || {};
      const message = (e.data && e.data.message) || e.name || 'opencode error';
      if (e.name !== 'MessageAbortedError') out.push({ type: '_error', message: String(message) });
      out.push(...endTurn(st, { subtype: 'error_during_execution', is_error: e.name !== 'MessageAbortedError' }));
      break;
    }
    default: break;                             // ignore the rest of the bus traffic
  }
  return out;
}

// turn end: close dangling blocks + emit the claude result event (status idle in chat.js).
function endTurn(st, { subtype = 'success', is_error = false } = {}) {
  const out = [];
  for (const key of [...st.blocks.keys()]) out.push(...closeBlock(st, key));
  st.msgOpen = false; st.active = false;
  out.push({ type: 'result', session_id: st.sesId, subtype, is_error,
    usage: st.usage || undefined, total_cost_usd: totalCost(st) });
  return out;
}

// GET /session/:id/message -> buffered Claude-style events (pure; resume scrollback replay).
function translateMessages(list, sesId) {
  const out = [];
  for (const m of list || []) {
    const info = (m && m.info) || {}, parts = (m && m.parts) || [];
    if (info.role === 'user') {
      const text = parts.filter(pt => pt.type === 'text' && !pt.synthetic).map(pt => pt.text || '').join('\n');
      if (text.trim()) out.push({ type: '_user', text });
      continue;
    }
    const content = [], results = [];
    for (const pt of parts) {
      if (pt.type === 'text') { if ((pt.text || '').trim()) content.push({ type: 'text', text: pt.text }); }
      else if (pt.type === 'reasoning') { if ((pt.text || '').trim()) content.push({ type: 'thinking', thinking: pt.text }); }
      else if (pt.type === 'tool') {
        const id = pt.callID || pt.id, stt = pt.state || {};
        content.push({ type: 'tool_use', id, name: pt.tool || 'tool', input: stt.input || {} });
        if (stt.status === 'completed') results.push({ type: 'tool_result', tool_use_id: id, content: String(stt.output ?? ''), is_error: false });
        else if (stt.status === 'error') results.push({ type: 'tool_result', tool_use_id: id, content: String(stt.error || ''), is_error: true });
      }
    }
    if (content.length) out.push({ type: 'assistant', session_id: sesId, message: { role: 'assistant', model: info.modelID || null, content } });
    if (results.length) out.push({ type: 'user', session_id: sesId, message: { role: 'user', content: results } });
  }
  return out;
}

// Create (or re-attach: resumeId = existing ses_*) a session on the shared serve process.
// opts: { resumeId, replay }. NOTE model selection isn't wired for opencode — the server default
// applies (opencode wants a {providerID, modelID} pair; our model field is a bare token).
function start(s, io, { resumeId, replay } = {}) {
  return (async () => {
    const port = await ensureServe();
    ensureBus(s.cwd);                           // instance-scoped events for this directory
    s.proc = serve.proc;                        // shared child: watchdog/liveness track the serve pid
    s.pid = serve.proc ? serve.proc.pid || null : null;
    const st = s._oc = { ts: newTranslateState({ model: s.model }), queue: [], ready: false };
    let info;
    if (resumeId) {
      info = { id: resumeId, directory: s.cwd };
      if (replay) {                             // plain-JSON storage survives restarts; replay it
        const msgs = await req(port, 'GET', '/session/' + encodeURIComponent(resumeId) + '/message' + dirQ(s));
        serve.handlers.set(resumeId, { s, io, ts: st.ts });
        io.push(initEvent(st.ts, info));
        for (const ev of translateMessages(msgs, resumeId)) io.push(ev);
      } else {
        serve.handlers.set(resumeId, { s, io, ts: st.ts });
        io.push(initEvent(st.ts, info));
      }
    } else {
      info = await req(port, 'POST', '/session' + dirQ(s),
        { title: 'corral', permission: permissionRuleset(s.permissionMode) });
      serve.handlers.set(info.id, { s, io, ts: st.ts });
      io.push(initEvent(st.ts, info));
    }
    st.ready = true;
    for (const text of st.queue.splice(0)) prompt(s, io, st, text);
  })();
}

function prompt(s, io, st, text) {
  req(serve.port, 'POST', '/session/' + encodeURIComponent(st.ts.sesId) + '/prompt_async' + dirQ(s),
    { parts: [{ type: 'text', text }] })
    .catch(e => {                               // failed prompt: surface + unstick the busy status
      io.push({ type: '_error', message: 'opencode prompt: ' + String(e && e.message || e) });
      io.push({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: st.ts.sesId });
    });
}

function write(s, io, text) {
  const st = s._oc;
  if (!st) return;
  if (!st.ready) { st.queue.push(text); return; }
  prompt(s, io, st, text);
}

function interrupt(s) {
  const st = s._oc;
  if (!st || !st.ts.sesId || !serve.port) return false;
  req(serve.port, 'POST', '/session/' + encodeURIComponent(st.ts.sesId) + '/abort' + dirQ(s), {}).catch(() => {});
  return true;
}

// "End session": abort the turn and detach — the shared serve process stays up for other
// sessions (chat.js must NOT s.proc.kill() here; sharedProc below routes it to us instead).
function kill(s, io) {
  const sid = s.sessionId || (s._oc && s._oc.ts.sesId);
  if (sid && serve.handlers.has(sid)) {
    serve.handlers.delete(sid);
    if (serve.port) req(serve.port, 'POST', '/session/' + encodeURIComponent(sid) + '/abort' + dirQ(s), {}).catch(() => {});
  }
  if (s.proc) io.exit(0);                       // only live sessions transition; dormant ones stay put
}

// Shutdown: take down the shared serve process (taskkill /T catches the shim's child tree).
function killAll() {
  if (!serve.proc || !serve.proc.pid) return;
  if (process.platform === 'win32') spawn('taskkill', ['/PID', String(serve.proc.pid), '/T', '/F'], { windowsHide: true });
  else { try { serve.proc.kill('SIGTERM'); } catch { } }
}

module.exports = { kind: 'opencode', OPENCODE, sharedProc: true, available, permissionRuleset,
  onApprovalRequest, PERM_REPLIES, respondPermission, newTranslateState, translateEvent, translateMessages, initEvent,
  start, write, interrupt, kill, killAll };
