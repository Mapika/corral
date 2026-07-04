// The terminal console, pure half (0.8.1): row building, labels, and the tail-event reducer
// for tui.mjs at the repo root. Everything here is data-in data-out — the runtime owns ANSI,
// sockets, and keys — so the selftest can pin the whole screen's logic without a terminal.
import { diffstatLabel, jobStatusView, pendingJobs, reviewJobs } from './reviewQueue.mjs';

export function fmtAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'now';
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  return Math.floor(h / 24) + 'd';
}

export const clip = (s, w) => { s = String(s ?? ''); return s.length <= w ? s : s.slice(0, Math.max(0, w - 1)) + '…'; };
const base = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

// One screen: who needs a human first, then the review pile, then the queue, then the herd.
export function buildRows({ sessions = [], jobs = [] } = {}) {
  const rows = [];
  const head = (label) => rows.push({ kind: 'head', label });
  const perm = sessions.filter((s) => s.pendingPerm);
  const review = reviewJobs(jobs);
  const pending = pendingJobs(jobs);
  const rest = sessions.filter((s) => !s.pendingPerm);
  if (perm.length) { head('NEEDS YOU'); for (const s of perm) rows.push({ kind: 'perm', s }); }
  if (review.length) { head('FRESH DIFFS'); for (const j of review) rows.push({ kind: 'job', j }); }
  if (pending.length) { head('QUEUE'); for (const j of pending) rows.push({ kind: 'job', j }); }
  if (rest.length) { head('HERD'); for (const s of rest) rows.push({ kind: 'session', s }); }
  return rows;
}
export const selectable = (r) => !!r && r.kind !== 'head';

// {left, right, tone} — the runtime pads/colors. Tones follow the web vocabulary.
export function rowView(row, now = Date.now()) {
  if (!row) return { left: '', right: '', tone: 'dormant' };
  if (row.kind === 'head') return { left: row.label, right: '', tone: 'head' };
  if (row.kind === 'perm') {
    const p = row.s.pendingPerm || {};
    return { left: (row.s.label || base(row.s.cwd)) + '  wants ' + (p.tool || '?') + (p.summary ? ' ' + p.summary : ''), right: row.s.agent || 'claude', tone: 'ask' };
  }
  if (row.kind === 'job') {
    const v = jobStatusView(row.j.status);
    const stat = row.j.diffstat && (row.j.status === 'landed' || row.j.status === 'conflict') ? '  ' + diffstatLabel(row.j.diffstat) : '';
    return { left: (row.j.label || base(row.j.dir)) + '  ' + v.label + stat, right: base(row.j.dir), tone: v.tone };
  }
  const s = row.s;
  const age = fmtAge(now - (s.updatedAt || s.createdAt || now));
  return { left: (s.label || base(s.cwd) || s.id) + '  ' + (s.status || '?') + (age ? ' · ' + age : ''), right: (s.agent || 'claude') + (s.host && s.host !== 'local' ? ' · ' + s.host : ''), tone: s.status === 'busy' ? 'busy' : s.status === 'error' ? 'error' : 'idle' };
}

// Key hints for the footer, per selection — only ever offer what the row can actually do.
export function rowActions(row) {
  if (!row) return [];
  if (row.kind === 'perm') return ['a allow', 'd deny', 'enter open'];
  if (row.kind === 'job') {
    const st = row.j.status;
    if (st === 'landed' || st === 'conflict') return ['enter diff', 'k keep', 'b bounce'];
    if (st === 'failed') return ['b bounce'];
    if (st === 'queued') return ['x remove'];
    return [];
  }
  if (row.kind === 'session') return ['enter open'];
  return [];
}

// diff line -> tone for the diff pager
export function diffTone(line) {
  const l = String(line ?? '');
  if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ')) return 'meta';
  if (l.startsWith('@@')) return 'hunk';
  if (l.startsWith('+')) return 'add';
  if (l.startsWith('-')) return 'del';
  return 'ctx';
}

// The session tail, as a reducer over the chat socket's Claude-style stream-json events.
// state: { lines: [{text, tone}], open: bool (a text block is streaming), ask: {id,tool}|null }
export function tailReduce(state, ev) {
  const st = { lines: state?.lines ? [...state.lines] : [], open: !!state?.open, ask: state?.ask || null };
  const push = (text, tone = 'ctx') => { st.lines.push({ text, tone }); st.open = false; };
  const append = (text) => {
    if (!st.open) { st.lines.push({ text: '', tone: 'ctx' }); st.open = true; }
    const parts = String(text).split('\n');
    st.lines[st.lines.length - 1].text += parts[0];
    for (const extra of parts.slice(1)) st.lines.push({ text: extra, tone: 'ctx' });
  };
  if (!ev || typeof ev !== 'object') return st;
  if (ev.type === '_user') push('you: ' + (ev.text || ''), 'meta');
  else if (ev.type === 'assistant') { for (const c of ev.message?.content || []) if (c.type === 'text') push(c.text, 'ctx'); }
  else if (ev.type === 'stream_event') {
    const e = ev.event || {};
    if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') push('▸ ' + (e.content_block.name || 'tool'), 'meta');
    if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta') append(e.delta.text || '');
    if (e.type === 'content_block_stop') st.open = false;
  }
  else if (ev.type === 'result') push('— turn done —', 'hunk');
  else if (ev.type === '_permission_request') { st.ask = { id: ev.id, tool: ev.tool || '?' }; push('? wants ' + (ev.tool || '?') + '  [a]llow [d]eny', 'ask'); }
  else if (ev.type === '_permission_resolved') { st.ask = null; push('permission ' + (ev.decision || 'resolved'), 'meta'); }
  else if (ev.type === '_error') push('error: ' + (ev.message || ''), 'del');
  else if (ev.type === '_exit') push('— session exited' + (ev.code != null ? ' (' + ev.code + ')' : '') + ' —', 'meta');
  if (st.lines.length > 500) st.lines.splice(0, st.lines.length - 500);
  return st;
}
