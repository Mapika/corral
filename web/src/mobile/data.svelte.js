// Mobile data layer: one reactive snapshot of the WHOLE herd — every paired ranch (plus the
// on-device pocket backend and, on browser pages, the serving origin itself) gets its own
// connection (events push socket + quiet poll fallback), and their rosters merge into one list,
// each session tagged with the ranch it lives on. Per-ranch state stays visible on d.ranches so
// the shell can say "the office box is offline" instead of pretending the herd is fine.
import { defaultClient } from '../lib/api.js';
import { createApiClient } from '../lib/apiClient.mjs';
import { apiErrorMessage } from '../lib/apiRequest.mjs';
import { getPocketBase, getPocketToken, pocketEnabled } from '../lib/pocket.js';
import { mergeSessions, parseRanches, RANCHES_KEY, renameRanch, serializeRanches, upsertRanch } from '../lib/ranches.mjs';
import { parseRecentRoots, RECENT_ROOTS_KEY, rememberLaunchRoot, serializeRecentRoots } from '../lib/recentRoots.mjs';

export function createMobileData({ standalone = false } = {}) {
  const d = $state({
    // [{ id, name, base, kind: 'origin'|'pocket'|'paired', live, offline, loaded, error, localHome, hosts }]
    ranches: [],
    sessions: [],       // merged + ranch-tagged, roster order
    recentRoots: [],
    loaded: false,      // some ranch has answered — screens can trust "empty"
    live: false,        // every ranch is on its events socket — polls stand down
    offline: false,     // total blackout: no ranch reachable at all
    offlineCount: 0,    // partial trouble: this many ranches unreachable while others are fine
    error: '',
  });

  const conns = new Map();   // ranch id -> { client, ws, retry, retryTimer, sessions }
  let pollTimer = null, stopped = false;

  const runtime = { live: false, offline: false, loaded: false, error: '', localHome: '~', hosts: [] };

  function recompute() {
    d.sessions = mergeSessions(d.ranches, Object.fromEntries([...conns].map(([id, c]) => [id, c.sessions])));
    const rs = d.ranches;
    d.loaded = rs.length === 0 || rs.some((r) => r.loaded);
    d.live = rs.length > 0 && rs.every((r) => r.live);
    d.offline = rs.length > 0 && rs.every((r) => r.offline);
    d.offlineCount = rs.filter((r) => r.offline).length;
    d.error = rs.find((r) => r.offline && r.error)?.error || '';
  }

  function clientFor(ranchId) {
    return conns.get(ranchId)?.client || defaultClient;
  }
  const ranchFor = (ranchId) => d.ranches.find((r) => r.id === ranchId) || null;

  // --- one connection per ranch ---------------------------------------------------------------
  function makeClient(r) {
    if (r.kind === 'origin') return defaultClient;
    if (r.kind === 'pocket') return createApiClient({ getBase: getPocketBase, getToken: getPocketToken });
    // paired: read base/token through the live roster record, so a re-pair token refresh applies
    // to the next request without tearing the connection down.
    return createApiClient({ getBase: () => ranchFor(r.id)?.base || r.base, getToken: () => ranchFor(r.id)?.token || '' });
  }

  async function pollConn(r, c) {
    if (stopped || r.live) return;
    try {
      c.sessions = await c.client.listSessions();
      r.loaded = true; r.offline = false; r.error = '';
    } catch (e) {
      r.offline = true; r.error = apiErrorMessage(e, 'Could not reach ' + (r.kind === 'paired' ? r.name : 'the corral server') + '.');
    }
    recompute();
  }

  async function loadHostsConn(r, c) {
    try {
      const h = await c.client.listHosts();
      r.hosts = h.hosts || [];
      r.localHome = h.local || '~';
      // The serving origin never told us its name at pair time — adopt the server's hostname.
      if (r.kind === 'origin' && h.hostname) r.name = h.hostname;
    } catch (e) {}
  }

  function connectEvents(r, c) {
    if (stopped || c.gone) return;
    const ws = (c.ws = c.client.eventsSocket());
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      r.live = true; r.offline = false; r.error = '';
      c.retry = 0;
      if (msg.type === 'sessions') { c.sessions = msg.sessions; r.loaded = true; }
      recompute();
    };
    ws.onclose = () => {
      r.live = false;
      recompute();
      if (stopped || c.gone) return;
      c.retry += 1;
      c.retryTimer = setTimeout(() => connectEvents(r, c), Math.min(10000, 500 * 2 ** Math.min(c.retry, 5)));
    };
  }

  function startConn(r) {
    const c = { client: makeClient(r), ws: null, retry: 0, retryTimer: null, sessions: [], gone: false };
    conns.set(r.id, c);
    pollConn(r, c); loadHostsConn(r, c);
    connectEvents(r, c);
  }

  function stopConn(id) {
    const c = conns.get(id);
    if (!c) return;
    c.gone = true;
    clearTimeout(c.retryTimer);
    try { c.ws && c.ws.close(); } catch (e) {}
    conns.delete(id);
  }

  // --- roster mutations (persisted for paired ranches only) ------------------------------------
  const persisted = () => d.ranches.filter((r) => r.kind === 'paired').map(({ id, name, base, token, addedAt }) => ({ id, name, base, token, addedAt }));
  const persist = () => { try { localStorage.setItem(RANCHES_KEY, serializeRanches(persisted())); } catch (e) {} };

  // Returns { ranch, refreshed } — refreshed means the base was already paired and only the
  // token changed (the conflict UX: no duplicate rows, the existing ranch keeps its identity).
  function addRanch({ base, token, name }) {
    const { list, ranch, refreshed } = upsertRanch(persisted(), { base, token, name, now: Date.now() });
    if (refreshed) {
      const rec = d.ranches.find((r) => r.id === ranch.id);
      if (rec) rec.token = token;
    } else {
      const rec = { ...ranch, kind: 'paired', ...runtime };
      d.ranches.push(rec);
      startConn(rec);
    }
    persist();
    recompute();
    return { ranch, refreshed };
  }

  // Pocket turned on after boot ("Run on this phone" from settings) — join the herd live.
  function attachPocket() {
    if (d.ranches.some((r) => r.kind === 'pocket')) return;
    const rec = { id: 'pocket', name: 'this phone', base: '', token: '', kind: 'pocket', ...runtime };
    d.ranches.unshift(rec);
    startConn(rec);
    recompute();
  }

  function removeRanchById(id) {
    stopConn(id);
    d.ranches = d.ranches.filter((r) => r.id !== id);
    persist();
    recompute();
  }

  function renameRanchById(id, name) {
    const named = renameRanch(persisted(), id, name);
    const rec = d.ranches.find((r) => r.id === id);
    const next = named.find((r) => r.id === id);
    if (rec && next) rec.name = next.name;
    persist();
    recompute();
  }

  // --- lifecycle --------------------------------------------------------------------------------
  function pollAll() { for (const r of d.ranches) { const c = conns.get(r.id); if (c) pollConn(r, c); } }
  async function poll() { await Promise.allSettled(d.ranches.map((r) => { const c = conns.get(r.id); return c ? pollConn(r, c) : null; })); }
  async function loadHosts() { await Promise.allSettled(d.ranches.map((r) => { const c = conns.get(r.id); return c ? loadHostsConn(r, c) : null; })); }

  // Phones freeze the page (and kill sockets) on lock/background; on wake, refresh NOW instead
  // of leaving the operator staring at stale rows until the next backoff tick.
  function onVisible() {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible' || stopped) return;
    for (const r of d.ranches) {
      const c = conns.get(r.id);
      if (!c) continue;
      pollConn(r, c);
      if (!r.live && (!c.ws || c.ws.readyState > 1)) {
        clearTimeout(c.retryTimer);
        c.retry = 0;
        connectEvents(r, c);
      }
    }
  }

  function start() {
    stopped = false;
    const list = [];
    // Browser pages talk to the server that served them — that origin is a ranch like any other.
    if (!standalone) list.push({ id: 'origin', name: 'this ranch', base: '', token: '', kind: 'origin', ...runtime });
    // The on-device backend, when this phone runs one. Base/token live in pocket.js module state.
    if (standalone && pocketEnabled()) list.push({ id: 'pocket', name: 'this phone', base: '', token: '', kind: 'pocket', ...runtime });
    let saved = [];
    try { saved = parseRanches(localStorage.getItem(RANCHES_KEY)); } catch (e) {}
    for (const r of saved) list.push({ ...r, kind: 'paired', ...runtime });
    d.ranches = list;
    for (const r of d.ranches) startConn(r);
    try { d.recentRoots = parseRecentRoots(localStorage.getItem(RECENT_ROOTS_KEY)); } catch (e) {}
    pollTimer = setInterval(pollAll, 5000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
    recompute();
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    for (const id of [...conns.keys()]) stopConn(id);
  }

  function rememberRoot(ranchId, host, dir) {
    // The origin ranch stays untagged — those entries are shared with (and readable by) the
    // desktop console and pre-0.6 data on the same origin.
    const ranch = ranchId && ranchFor(ranchId)?.kind !== 'origin' ? ranchId : undefined;
    d.recentRoots = rememberLaunchRoot(d.recentRoots, { ranch, host, dir, ts: Date.now() });
    try { localStorage.setItem(RECENT_ROOTS_KEY, serializeRecentRoots(d.recentRoots)); } catch (e) {}
  }

  return { d, start, stop, poll, loadHosts, rememberRoot, clientFor, addRanch, attachPocket, removeRanchById, renameRanchById };
}
