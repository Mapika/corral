// Mobile data layer: one reactive snapshot of the herd (sessions + hosts + recent roots) fed by
// the /events push socket, with a quiet poll fallback while the socket is down. Deliberately a
// phone-sized subset of what App.svelte tracks — no tunnels, no host probes, no desktop toasts.
import { eventsSocket, listHosts, listSessions } from '../lib/api.js';
import { apiErrorMessage } from '../lib/apiRequest.mjs';
import { parseRecentRoots, RECENT_ROOTS_KEY, rememberLaunchRoot, serializeRecentRoots } from '../lib/recentRoots.mjs';

export function createMobileData() {
  const d = $state({
    sessions: [],
    hosts: [],
    localHome: '~',
    recentRoots: [],
    loaded: false,      // first roster snapshot has landed — screens can trust "empty"
    live: false,        // events socket delivering — polls stand down
    offline: false,     // neither socket nor poll can reach the server
    error: '',
  });

  let ws = null, retry = 0, retryTimer = null, pollTimer = null, stopped = false;

  async function poll() {
    if (d.live) return;
    try {
      d.sessions = await listSessions();
      d.loaded = true; d.offline = false; d.error = '';
    } catch (e) {
      d.offline = true; d.error = apiErrorMessage(e, 'Could not reach the corral server.');
    }
  }

  async function loadHosts() {
    try {
      const h = await listHosts();
      d.hosts = h.hosts || [];
      d.localHome = h.local || '~';
    } catch (e) {}
  }

  function connectEvents() {
    if (stopped) return;
    ws = eventsSocket();
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(m.data); } catch (e) { return; }
      d.live = true; d.offline = false; d.error = '';
      retry = 0;
      if (msg.type === 'sessions') { d.sessions = msg.sessions; d.loaded = true; }
    };
    ws.onclose = () => {
      d.live = false;
      if (stopped) return;
      retry += 1;
      retryTimer = setTimeout(connectEvents, Math.min(10000, 500 * 2 ** Math.min(retry, 5)));
    };
  }

  // Phones freeze the page (and kill sockets) on lock/background; on wake, refresh NOW instead
  // of leaving the operator staring at stale rows until the next backoff tick.
  function onVisible() {
    if (typeof document === 'undefined' || document.visibilityState !== 'visible' || stopped) return;
    poll();
    if (!d.live && (!ws || ws.readyState > 1)) {
      clearTimeout(retryTimer);
      retry = 0;
      connectEvents();
    }
  }

  function start() {
    stopped = false;
    poll(); loadHosts();
    try { d.recentRoots = parseRecentRoots(localStorage.getItem(RECENT_ROOTS_KEY)); } catch (e) {}
    connectEvents();
    pollTimer = setInterval(poll, 5000);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible);
  }

  function stop() {
    stopped = true;
    clearInterval(pollTimer); clearTimeout(retryTimer);
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible);
    try { ws && ws.close(); } catch (e) {}
  }

  function rememberRoot(host, dir) {
    d.recentRoots = rememberLaunchRoot(d.recentRoots, { host, dir, ts: Date.now() });
    try { localStorage.setItem(RECENT_ROOTS_KEY, serializeRecentRoots(d.recentRoots)); } catch (e) {}
  }

  return { d, start, stop, poll, loadHosts, rememberRoot };
}
