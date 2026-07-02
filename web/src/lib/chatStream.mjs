// Chat transcript state machine: reduce a session's event stream (the Claude-style wire every
// adapter emits) into renderable transcript items. Shared by the desktop Chat view and the
// mobile chat screen, so both speak the identical protocol. Pure module — pass a markdown
// renderer in; sockets and scrolling stay in the components.
//
// Item shapes:
//   { kind:'op',   text }                                     — operator message
//   { kind:'asst', blocks:[ text|thinking|tool ] }            — one assistant turn
//   { kind:'perm', id, tool, summary, input, resolved }       — permission prompt
//   { kind:'pill', text, err? }                               — status pill
// Assistant blocks:
//   { type:'text', html, _raw }
//   { type:'thinking', text, open }
//   { type:'tool', id, name, input, summary, result, isError, open, _json }

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

export function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt']) if (input[k]) return String(input[k]);
  try { return JSON.stringify(input).slice(0, 140); } catch (e) { return ''; }
}

export function toText(content) {
  if (Array.isArray(content)) return content.map(c => (c && c.type === 'text') ? c.text : (typeof c === 'string' ? c : JSON.stringify(c))).join('\n');
  return typeof content === 'string' ? content : JSON.stringify(content);
}

const safeJson = (s) => { try { return JSON.parse(s || '{}'); } catch (e) { return {}; } };

export function createChatState() {
  return {
    items: [],          // the transcript
    status: '',         // '', starting, busy, idle, exited, error
    model: null,        // refined by system/init
    usage: null,        // { cost, in, out } from the last result event
    stopped: false,     // a Stop was requested; label the ending result
    _curAsst: null,     // current assistant turn (groups streamed messages)
    _live: [],          // current message's live blocks, by content-block index
    _toolById: {},
    _permById: {},      // pending permission items by request id
  };
}

const pushItem = (st, it) => { st.items.push(it); return st.items[st.items.length - 1]; };
const ensureAsst = (st) => { if (!st._curAsst) st._curAsst = pushItem(st, { kind: 'asst', blocks: [] }); return st._curAsst; };

// Fallback path (non-streaming / reattach mid-turn): append a complete block from an assistant event.
function appendBlock(st, turn, b, md) {
  if (b.type === 'text' && b.text) turn.blocks.push({ type: 'text', html: md(b.text) });
  else if (b.type === 'thinking' && (b.thinking || b.text || '').trim()) turn.blocks.push({ type: 'thinking', text: b.thinking || b.text || '', open: false });
  else if (b.type === 'tool_use') {
    turn.blocks.push({ type: 'tool', id: b.id, name: b.name || 'tool', input: b.input, summary: summarize(b.input), result: null, isError: false, open: false });
    if (b.id) st._toolById[b.id] = turn.blocks[turn.blocks.length - 1];
  }
}

// Live token streaming: render deltas as plain text, then snap each block to full markdown on stop.
function onStream(st, ev, md) {
  const e = ev.event; if (!e) return false;
  if (e.type === 'message_start') { ensureAsst(st); st._live = []; return false; }
  if (e.type === 'content_block_start') {
    const turn = ensureAsst(st); const cb = e.content_block || {}; let blk;
    if (cb.type === 'thinking') blk = { type: 'thinking', text: '', open: false };
    else if (cb.type === 'tool_use') blk = { type: 'tool', id: cb.id, name: cb.name || 'tool', input: {}, summary: '', result: null, isError: false, open: false, _json: '' };
    else blk = { type: 'text', html: '', _raw: '' };
    turn.blocks.push(blk);
    const ref = turn.blocks[turn.blocks.length - 1];
    st._live[e.index] = ref;
    if (cb.type === 'tool_use' && cb.id) st._toolById[cb.id] = ref;
    return true;
  }
  if (e.type === 'content_block_delta') {
    const blk = st._live[e.index]; if (!blk) return false; const d = e.delta || {};
    if (d.type === 'text_delta') { blk._raw += d.text || ''; blk.html = '<p style="white-space:pre-wrap;margin:0">' + escHtml(blk._raw) + '</p>'; }
    else if (d.type === 'thinking_delta') { blk.text += d.thinking || ''; }
    else if (d.type === 'input_json_delta') { blk._json += d.partial_json || ''; blk.summary = summarize(safeJson(blk._json)); }
    return true;
  }
  if (e.type === 'content_block_stop') {
    const blk = st._live[e.index]; if (!blk) return false;
    if (blk.type === 'text') blk.html = md(blk._raw);
    else if (blk.type === 'tool') { blk.input = safeJson(blk._json); blk.summary = summarize(blk.input); }
    return false;
  }
  return false;
}

// Apply one wire event. Mutates state (pass a reactive proxy from Svelte and rendering follows);
// returns true when the transcript grew/changed in a way that should scroll the view down.
export function handleChatEvent(st, ev, md = escHtml) {
  switch (ev.type) {
    case '_user':
      st._curAsst = null; st._live = [];
      pushItem(st, { kind: 'op', text: ev.text });
      st.status = 'busy';
      return true;
    case 'stream_event':
      return onStream(st, ev, md);
    case 'assistant':
      if (st._live.length === 0 && ev.message && Array.isArray(ev.message.content)) {
        const turn = ensureAsst(st);
        for (const b of ev.message.content) appendBlock(st, turn, b, md);
        return true;
      }
      return false;
    case 'user': {
      const content = ev.message && ev.message.content;
      if (Array.isArray(content)) for (const b of content) if (b.type === 'tool_result' && st._toolById[b.tool_use_id]) {
        const t = st._toolById[b.tool_use_id]; t.result = toText(b.content); t.isError = !!b.is_error;
      }
      return true;
    }
    case 'result':
      st._curAsst = null; st._live = []; st.status = 'idle';
      // total_cost_usd is cumulative for the session; usage tokens are the turn just finished.
      if (ev.usage || ev.total_cost_usd != null) st.usage = { cost: ev.total_cost_usd, in: ev.usage?.input_tokens, out: ev.usage?.output_tokens };
      if (st.stopped) { st.stopped = false; pushItem(st, { kind: 'pill', text: 'Stopped' }); return true; }
      return false;
    case 'system':
      if (ev.subtype === 'api_retry') { pushItem(st, { kind: 'pill', text: 'Retrying - model busy' + (ev.error_status ? ' (' + ev.error_status + ')' : '') + '...' }); return true; }
      if (ev.subtype === 'init' && ev.model) st.model = ev.model;
      return false;
    case '_permission_request': {
      const p = pushItem(st, { kind: 'perm', id: ev.id, tool: ev.tool || 'tool', summary: summarize(ev.input), input: ev.input || {}, resolved: null });
      st._permById[ev.id] = p;
      return true;
    }
    case '_permission_resolved': {
      const p = st._permById[ev.id]; if (p) p.resolved = ev.decision;
      return false;
    }
    case '_resumed':
      pushItem(st, { kind: 'pill', text: 'Resumed - continuing the conversation' });
      st.status = 'idle';
      return true;
    case '_error':
      pushItem(st, { kind: 'pill', text: 'Error: ' + ev.message, err: true });
      st.status = 'error';
      return true;
    case '_exit':
      pushItem(st, { kind: 'pill', text: 'Session ended' + (ev.code != null ? ' (code ' + ev.code + ')' : ''), err: true });
      st.status = 'exited';
      return true;
    default:
      return false;
  }
}

// Open (unresolved) permission prompts, newest last — the mobile sheet shows the first.
export function openPermissions(st) {
  return st.items.filter((it) => it.kind === 'perm' && !it.resolved);
}
