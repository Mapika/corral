#!/usr/bin/env node
// tui.mjs — the terminal console (0.8.1). ssh into any box that runs a corral backend and
// work the herd without a browser: the review gate (keep/bounce/diff), permission asks, the
// queue, and a live session tail. Zero dependencies — Node's own fetch + WebSocket and plain
// ANSI; all decision-shaped logic lives in web/src/lib/tuiView.mjs (selftested there).
//
//   node tui.mjs                          # local backend (http://127.0.0.1:7878)
//   node tui.mjs --server http://box:7879 --token <pairing token>
//   node tui.mjs --once                   # print one frame and exit (scriptable status)
import { buildRows, clip, diffTone, rowActions, rowView, selectable, tailReduce } from './web/src/lib/tuiView.mjs';

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const SERVER = (arg('--server') || process.env.CORRAL_SERVER || 'http://127.0.0.1:' + (process.env.PORT || 7878)).replace(/\/+$/, '');
const TOKEN = arg('--token') || process.env.CORRAL_TOKEN || process.env.CODAPP_TOKEN || '';
const ONCE = process.argv.includes('--once');

const HEADERS = TOKEN ? { authorization: 'Bearer ' + TOKEN } : {};
const api = async (path, opts = {}) => {
  const res = await fetch(SERVER + path, { ...opts, headers: HEADERS });
  if (!res.ok) throw new Error(path + ' -> ' + res.status);
  return res.json();
};

// --- state ---
const st = { hostname: '', sessions: [], jobs: [], sel: 0, mode: 'list', note: '', confirm: null,
  diff: { lines: [], top: 0, job: null }, tail: { id: null, ws: null, state: { lines: [], open: false, ask: null } } };

async function refresh() {
  try {
    const [sessions, queue] = await Promise.all([api('/api/chat/list'), api('/api/queue/list')]);
    st.sessions = Array.isArray(sessions) ? sessions : [];
    st.jobs = queue.jobs || [];
    if (st.noteConn) { st.note = ''; st.noteConn = false; }   // only reclaim the footer from OUR error — action notes stay put
  } catch (e) { st.note = 'cannot reach ' + SERVER + ' — ' + e.message; st.noteConn = true; }
  render();
}

// --- ANSI ---
const ESC = '\x1b[';
const TONES = { head: '2', ask: '33', busy: '36', error: '31', idle: '0', dormant: '2', add: '32', del: '31', hunk: '36', meta: '2', ctx: '0' };
const paint = (text, tone, invert = false) => ESC + (invert ? '7' : TONES[tone] || '0') + 'm' + text + ESC + '0m';
const width = () => process.stdout.columns || 100;
const height = () => process.stdout.rows || 30;
const line = (l, r, tone, invert) => {
  const w = width() - 1;
  const left = clip(l, w - String(r || '').length - 2);
  return paint(left + ' '.repeat(Math.max(1, w - left.length - String(r || '').length)) + (r || ''), tone, invert);
};

function frameList() {
  const rows = buildRows({ sessions: st.sessions, jobs: st.jobs });
  const sels = rows.filter(selectable);
  if (st.sel >= sels.length) st.sel = Math.max(0, sels.length - 1);
  const selRow = sels[st.sel] || null;
  const busy = st.sessions.filter((s) => s.status === 'busy').length;
  const out = [line('CORRAL · ' + (st.hostname || SERVER), busy + ' busy · ' + st.jobs.filter((j) => j.status === 'queued').length + ' queued', 'head')];
  let si = -1;
  for (const r of rows.slice(0, height() - 3)) {
    if (selectable(r)) si += 1;
    const v = rowView(r);
    out.push(r.kind === 'head' ? line('  ' + v.left, '', 'head') : line((si === st.sel ? '> ' : '  ') + v.left, v.right + ' ', v.tone, si === st.sel));
  }
  if (!rows.length) out.push(line('  the ranch is quiet', '', 'dormant'));
  const hints = st.confirm ? [st.confirm.label + '  y/n'] : [...rowActions(selRow), 'r refresh', 'q quit'];
  out.push('', line((st.note ? st.note + '   ' : '') + hints.join(' · '), '', st.note ? 'error' : 'head'));
  return out;
}

function frameDiff() {
  const rows = height() - 2;
  const out = [line('DIFF · ' + (st.diff.job?.label || ''), (st.diff.top + 1) + '–' + Math.min(st.diff.lines.length, st.diff.top + rows) + '/' + st.diff.lines.length, 'head')];
  for (const l of st.diff.lines.slice(st.diff.top, st.diff.top + rows)) out.push(line(l, '', diffTone(l)));
  out.push(line('↑↓ scroll · k keep · b bounce · q back', '', 'head'));
  return out;
}

function frameTail() {
  const s = st.sessions.find((x) => x.id === st.tail.id);
  const rows = height() - 2;
  const lines = st.tail.state.lines.slice(-rows);
  const out = [line('SESSION · ' + (s?.label || st.tail.id || ''), s ? s.status : '', 'head')];
  for (const l of lines) out.push(line(l.text, '', l.tone));
  out.push(line((st.tail.state.ask ? 'a allow · d deny · ' : '') + 'q back', '', 'head'));
  return out;
}

let raf = null;
function render() {
  if (raf) return;
  raf = setTimeout(() => {
    raf = null;
    const out = st.mode === 'diff' ? frameDiff() : st.mode === 'tail' ? frameTail() : frameList();
    process.stdout.write(ESC + 'H' + ESC + '2J' + out.join('\n'));
  }, 16);
  raf.unref?.();
}

// --- actions ---
const selRow = () => buildRows({ sessions: st.sessions, jobs: st.jobs }).filter(selectable)[st.sel] || null;
async function act(fn, okNote) {
  let note;
  try { const r = await fn(); note = r && r.ok === false ? (r.error || 'refused') : okNote; }
  catch (e) { note = String(e.message || e); }
  await refresh();
  st.note = note; st.noteConn = false;
  render();
}
const keep = (j) => act(() => api('/api/queue/keep?id=' + j.id, { method: 'POST' }), 'kept — merged into ' + (j.dir || 'the repo'));
const bounce = (j) => act(() => api('/api/queue/bounce?id=' + j.id, { method: 'POST' }), 'bounced');
const removeJob = (j) => act(() => api('/api/queue/remove?id=' + j.id, { method: 'POST' }), 'removed');
const decide = (sid, reqId, decision) => act(() => api('/api/chat/permission?id=' + encodeURIComponent(sid) + '&requestId=' + encodeURIComponent(reqId) + '&decision=' + decision, { method: 'POST' }), decision === 'allow' ? 'allowed' : 'denied');

async function openDiff(j) {
  try {
    const d = await api('/api/git/diff?server=local&path=' + encodeURIComponent(j.worktreeDir || j.dir));
    const lines = (d.diff || '').split('\n');
    for (const u of d.untracked || []) lines.push('+ new file: ' + u);
    st.diff = { lines, top: 0, job: j };
    st.mode = 'diff';
  } catch (e) { st.note = 'no diff: ' + (e.message || e); }
  render();
}

function wsUrl(path) {
  return SERVER.replace(/^http/, 'ws') + path + (TOKEN ? (path.includes('?') ? '&' : '?') + 'tk=' + encodeURIComponent(TOKEN) : '');
}
function openTail(id) {
  closeTail();
  st.tail = { id, ws: new WebSocket(wsUrl('/chat?id=' + encodeURIComponent(id))), state: { lines: [], open: false, ask: null } };
  st.tail.ws.onmessage = (m) => { try { st.tail.state = tailReduce(st.tail.state, JSON.parse(m.data)); } catch (e) {} render(); };
  st.tail.ws.onclose = () => { if (st.mode === 'tail') { st.tail.state = tailReduce(st.tail.state, { type: '_exit' }); render(); } };
  st.mode = 'tail';
  render();
}
function closeTail() { try { st.tail.ws?.close(); } catch (e) {} st.tail = { id: null, ws: null, state: { lines: [], open: false, ask: null } }; }

// --- keys ---
function onKey(key) {
  if (key === '\x03') return quit();                                  // ctrl-c anywhere
  if (st.confirm) { const c = st.confirm; st.confirm = null; if (key === 'y') c.run(); else render(); return; }
  if (st.mode === 'diff') {
    if (key === 'q' || key === '\x1b') { st.mode = 'list'; return render(); }
    if (key === '\x1b[A') st.diff.top = Math.max(0, st.diff.top - 1);
    if (key === '\x1b[B') st.diff.top = Math.min(Math.max(0, st.diff.lines.length - (height() - 2)), st.diff.top + 1);
    if (key === 'k' && st.diff.job) { st.mode = 'list'; return keep(st.diff.job); }
    if (key === 'b' && st.diff.job) { st.mode = 'list'; return bounce(st.diff.job); }
    return render();
  }
  if (st.mode === 'tail') {
    const s = st.sessions.find((x) => x.id === st.tail.id);
    if (key === 'q' || key === '\x1b') { closeTail(); st.mode = 'list'; return render(); }
    if (key === 'a' && st.tail.state.ask && s) return decide(s.id, st.tail.state.ask.id, 'allow');
    if (key === 'd' && st.tail.state.ask && s) return decide(s.id, st.tail.state.ask.id, 'deny');
    return;
  }
  const row = selRow();
  if (key === '\x1b[A') { st.sel = Math.max(0, st.sel - 1); return render(); }
  if (key === '\x1b[B') { st.sel += 1; return render(); }
  if (key === 'q') return quit();
  if (key === 'r') return refresh();
  if (!row) return;
  if (key === '\r') {
    if (row.kind === 'job' && (row.j.status === 'landed' || row.j.status === 'conflict')) return openDiff(row.j);
    if (row.kind === 'perm' || row.kind === 'session') return openTail(row.s.id);
  }
  if (row.kind === 'perm') {
    if (key === 'a') return decide(row.s.id, row.s.pendingPerm?.id, 'allow');
    if (key === 'd') return decide(row.s.id, row.s.pendingPerm?.id, 'deny');
  }
  if (row.kind === 'job') {
    if (key === 'k' && (row.j.status === 'landed' || row.j.status === 'conflict')) return keep(row.j);
    if (key === 'b' && ['landed', 'conflict', 'failed'].includes(row.j.status)) { st.confirm = { label: 'bounce "' + clip(row.j.label, 30) + '" — delete its worktree + branch?', run: () => bounce(row.j) }; return render(); }
    if (key === 'x' && row.j.status === 'queued') return removeJob(row.j);
  }
}

// --- lifecycle ---
let events = null, retry = 0;
function connectEvents() {
  events = new WebSocket(wsUrl('/events'));
  events.onmessage = (m) => {
    let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
    retry = 0;
    if (msg.type === 'sessions') st.sessions = msg.sessions || [];
    if (msg.type === 'queue') st.jobs = msg.queue?.jobs || [];
    render();
  };
  events.onclose = () => { retry += 1; setTimeout(connectEvents, Math.min(10_000, 500 * 2 ** Math.min(retry, 5))).unref?.(); };
  events.onerror = () => {};
}

function quit() {
  closeTail();
  try { events?.close(); } catch (e) {}
  process.stdout.write(ESC + '?1049l' + ESC + '?25h');   // main buffer, cursor back
  process.exit(0);
}

const main = async () => {
  try { st.hostname = (await api('/api/hosts')).hostname || ''; } catch (e) {}
  await refresh();
  if (ONCE) {
    // exitCode + natural drain, not process.exit(): a hard exit while undici's keep-alive
    // sockets tear down trips a libuv assertion on Windows (uv_async close race).
    if (raf) { clearTimeout(raf); raf = null; }
    process.stdout.write(frameList().join('\n') + '\n');
    process.exitCode = st.note ? 1 : 0;
    return;
  }
  process.stdout.write(ESC + '?1049h' + ESC + '?25l');   // alt buffer, hide cursor
  render();
  connectEvents();
  setInterval(refresh, 10_000).unref?.();                // quiet poll behind the push socket
  process.stdout.on('resize', render);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', onKey);
  }
};
main();
