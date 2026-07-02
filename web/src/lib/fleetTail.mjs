// Fleet-tile tail: reduce a session's event stream (the same frames Chat.svelte renders in full)
// into the last few entries a tile can show — markdown text blocks plus one-line markers for
// prompts, tool calls, and turn results. Pure module — the socket lives in FleetTile.svelte.

export const TAIL_CAP = 10;       // entries kept per tile
export const TEXT_CAP = 900;      // chars of markdown kept per text entry (the tail of it)

export function createTailState() {
  return { lines: [], live: null, buf: '', streamed: false, msgKey: null };
}

const clip = (s, n = 200) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

// Keep the FRESH end of a long markdown block, cutting at a line boundary so the
// remainder still renders sanely.
const capMd = (s) => {
  const t = String(s || '');
  if (t.length <= TEXT_CAP) return t;
  const tail = t.slice(t.length - TEXT_CAP);
  const nl = tail.indexOf('\n');
  return '…' + (nl >= 0 && nl < TEXT_CAP - 40 ? tail.slice(nl) : tail);
};

function push(state, kind, text, msg) {
  state.lines.push(msg ? { kind, text, _msg: msg } : { kind, text });
  if (state.lines.length > TAIL_CAP) state.lines.splice(0, state.lines.length - TAIL_CAP);
  return state.lines[state.lines.length - 1];
}

const toolLabel = (name, summary) => (name || 'tool') + (summary ? '  ' + clip(summary, 160) : '');
function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  for (const k of ['command', 'file_path', 'path', 'pattern', 'url', 'description', 'prompt']) if (input[k]) return String(input[k]);
  return '';
}

// Apply one event. Mutates state; returns true when the visible tail changed.
export function applyTailEvent(state, ev) {
  if (!ev || !ev.type) return false;
  switch (ev.type) {
    case '_user':
      state.live = null; state.msgKey = null;
      push(state, 'user', '> ' + clip(ev.text, 160));
      return true;
    case 'stream_event': {
      const e = ev.event || {};
      state.streamed = true;
      if (e.type === 'content_block_start') {
        const cb = e.content_block || {};
        state.buf = '';
        if (cb.type === 'tool_use') { state.live = push(state, 'tool', toolLabel(cb.name)); state.live._tool = cb.name || 'tool'; }
        else if (cb.type === 'thinking') { state.live = null; push(state, 'think', 'thinking…'); }
        else state.live = push(state, 'text', '');
        return true;
      }
      if (e.type === 'content_block_delta') {
        const d = e.delta || {};
        if (!state.live) return false;
        if (d.type === 'text_delta') { state.buf += d.text || ''; state.live.text = capMd(state.buf); return true; }
        if (d.type === 'input_json_delta') {
          state.buf += d.partial_json || '';
          try { state.live.text = toolLabel(state.live._tool, summarize(JSON.parse(state.buf))); return true; } catch (e2) { return false; }
        }
        return false;
      }
      if (e.type === 'content_block_stop') { state.live = null; return true; }
      return false;
    }
    case 'assistant': {
      // Complete-message path (no deltas flowing): the CLI re-emits the SAME message cumulatively
      // as it grows, so entries rendered for this message key are replaced, never appended twice.
      if (state.streamed) return false;
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      if (!content.length) return false;
      const key = (ev.message && ev.message.id) || '__msg';
      if (state.msgKey === key) state.lines = state.lines.filter((l) => l._msg !== key);
      state.msgKey = key;
      let changed = false;
      for (const b of content) {
        if (b.type === 'text' && b.text) { push(state, 'text', capMd(b.text), key); changed = true; }
        else if (b.type === 'tool_use') { push(state, 'tool', toolLabel(b.name, summarize(b.input)), key); changed = true; }
      }
      return changed;
    }
    case 'result':
      state.live = null; state.streamed = false; state.buf = ''; state.msgKey = null;
      push(state, 'pill', ev.total_cost_usd != null ? 'turn complete · $' + Number(ev.total_cost_usd).toFixed(2) : 'turn complete');
      return true;
    case '_permission_request':
      push(state, 'perm', 'waiting for permission: ' + clip(ev.tool || 'tool', 60));
      return true;
    case '_resumed':
      push(state, 'pill', 'resumed');
      return true;
    case '_error':
      state.live = null;
      push(state, 'err', 'error: ' + clip(ev.message, 120));
      return true;
    case '_exit':
      state.live = null;
      push(state, 'err', 'session ended' + (ev.code != null ? ' (code ' + ev.code + ')' : ''));
      return true;
    default:
      return false;
  }
}
