// Fleet-tile tail: reduce a session's event stream (the same frames Chat.svelte renders in full)
// into the last few one-line strings, so a grid of tiles can show every agent working at once.
// Pure module — the socket lives in FleetTile.svelte.

export const TAIL_CAP = 14;

export function createTailState() {
  return { lines: [], live: null, buf: '', streamed: false };
}

const clip = (s, n = 200) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const lastLine = (buf) => {
  const parts = String(buf).split('\n');
  for (let i = parts.length - 1; i >= 0; i -= 1) if (parts[i].trim()) return parts[i];
  return '';
};
const tailOf = (buf, n) => String(buf).split('\n').map((l) => l.trim()).filter(Boolean).slice(-n);

function push(state, kind, text) {
  state.lines.push({ kind, text });
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
      state.live = null;
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
        if (d.type === 'text_delta') { state.buf += d.text || ''; state.live.text = clip(lastLine(state.buf)); return true; }
        if (d.type === 'input_json_delta') {
          state.buf += d.partial_json || '';
          try { state.live.text = toolLabel(state.live._tool, summarize(JSON.parse(state.buf))); return true; } catch (e2) { return false; }
        }
        return false;
      }
      if (e.type === 'content_block_stop') {
        // A finished text block expands to its last few real lines so the tile reads like a tail.
        if (state.live && !state.live._tool && state.buf.includes('\n')) {
          state.lines.splice(state.lines.indexOf(state.live), 1);
          for (const line of tailOf(state.buf, 3)) push(state, 'text', clip(line));
        }
        state.live = null;
        return true;
      }
      return false;
    }
    case 'assistant': {
      // Complete-message fallback (ring replay / attach mid-turn). Skipped when deltas already drew it.
      if (state.streamed) return false;
      const content = ev.message && Array.isArray(ev.message.content) ? ev.message.content : [];
      let changed = false;
      for (const b of content) {
        if (b.type === 'text' && b.text) { for (const line of tailOf(b.text, 3)) push(state, 'text', clip(line)); changed = true; }
        else if (b.type === 'tool_use') { push(state, 'tool', toolLabel(b.name, summarize(b.input))); changed = true; }
      }
      return changed;
    }
    case 'result':
      state.live = null; state.streamed = false; state.buf = '';
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
