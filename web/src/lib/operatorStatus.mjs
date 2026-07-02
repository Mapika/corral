import { tunnelStatusView } from './tunnelStatus.mjs';

const weights = { busy: 0, error: 1, exited: 2, dormant: 3, idle: 4 };
const clean = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[0-9;]*m\]?/g, '').trim();
export const STALE_SESSION_MS = 4 * 60 * 60 * 1000;

export function isLiveSession(session = {}) {
  return session.status === 'busy' || session.status === 'starting';
}

export function isResumableSession(session = {}) {
  return !!session.sessionId && session.status === 'dormant';
}

const activityTime = (session = {}) => session.updatedAt || session.createdAt || 0;

export function isStaleResumableSession(session = {}, now = Date.now(), staleMs = STALE_SESSION_MS) {
  const activeAt = activityTime(session);
  return !!activeAt && session.status === 'dormant' && Math.max(0, now - activeAt) >= staleMs;
}

export function lastActiveLabel(value, now = Date.now()) {
  if (value == null) return 'no activity';
  const diff = Math.max(0, now - value);
  if (diff < 5_000) return 'now';
  if (diff < 60_000) return Math.floor(diff / 1000) + 's ago';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
  return Math.floor(diff / 86_400_000) + 'd ago';
}

export function operatorMetrics({ sessions = [], tunnels = [], hosts = [], now = Date.now() } = {}) {
  return {
    running: sessions.filter((s) => isLiveSession(s)).length,
    dormant: sessions.filter((s) => s.status === 'dormant').length,
    stale: sessions.filter((s) => isStaleResumableSession(s, now)).length,
    failed: sessions.filter((s) => s.status === 'error' || s.status === 'exited').length,
    activeTunnels: tunnels.filter((t) => tunnelStatusView(t).tone === 'ok').length,
    hosts: hosts.length + 1,
  };
}

export function operatorStatCards(metrics = {}) {
  return [
    { id: 'running', tone: 'live', value: metrics.running || 0, label: 'running', action: { kind: 'filter', filter: 'running' } },
    { id: 'parked', tone: 'resume', value: metrics.dormant || 0, label: 'parked', action: { kind: 'filter', filter: 'resume' } },
    { id: 'stale', tone: 'alert', value: metrics.stale || 0, label: 'stale', action: { kind: 'filter', filter: 'stale' } },
    { id: 'tunnels', tone: 'quiet', value: metrics.activeTunnels || 0, label: 'tunnels up', action: { kind: 'tunnels' } },
    { id: 'hosts', tone: 'quiet', value: metrics.hosts || 0, label: 'hosts', action: { kind: 'refresh' } },
    { id: 'cleanup', tone: 'alert', value: metrics.failed || 0, label: 'cleanup', action: { kind: 'filter', filter: 'cleanup' } },
  ];
}

const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');
const remoteHosts = (hostCards = []) => hostCards.filter((host) => host.host && host.host !== 'local');

function offlineHostSummary(hostCards = []) {
  const offline = remoteHosts(hostCards)
    .filter((host) => host.tone === 'offline')
    .map((host) => host.label || host.host)
    .filter(Boolean);
  if (!offline.length) return 'all hosts reachable';
  const shown = offline.slice(0, 3).join(', ');
  const extra = offline.length > 3 ? ' +' + (offline.length - 3) + ' more' : '';
  return shown + extra + ' offline';
}

function sessionWorkName(session = {}) {
  if (session.label) return session.label;      // operator-assigned label wins over the folder name
  const path = String(session.cwd || session.dir || '').replace(/\\/g, '/');
  const name = path.split('/').filter(Boolean).pop();
  return name || session.name || session.id || 'session';
}

function sessionHostLabel(session = {}, hostCards = []) {
  const host = session.host || 'local';
  if (host === 'local') return 'this computer';
  return hostCards.find((card) => card.host === host)?.label || host;
}

function workWatchKind(session = {}, now = Date.now()) {
  if (session.status === 'error' || session.status === 'exited') return { rank: 0, label: 'cleanup' };
  if (isStaleResumableSession(session, now)) return { rank: 1, label: 'stale' };
  if (isLiveSession(session)) return { rank: 2, label: 'running' };
  if (session.status === 'dormant') return { rank: 3, label: 'parked' };
  return null;
}

function watchTone(label) {
  if (label === 'running') return 'live';
  if (label === 'parked') return 'resume';
  if (label === 'cleanup' || label === 'stale') return 'alert';
  return 'quiet';
}

function watchActionLabel(label) {
  if (label === 'cleanup') return 'Review';
  if (label === 'running') return 'Open';
  return 'Inspect';
}

export function operatorWatchItems({ sessions = [], hostCards = [], now = Date.now(), limit = 4 } = {}) {
  return sessions
    .map((session) => ({ session, kind: workWatchKind(session, now) }))
    .filter((item) => item.kind)
    .sort((a, b) => a.kind.rank - b.kind.rank || activityTime(b.session) - activityTime(a.session))
    .slice(0, limit)
    .map(({ session, kind }) => {
      const title = sessionWorkName(session);
      return {
        id: session.id || kind.label + ':' + title,
        sessionId: session.id,
        tone: watchTone(kind.label),
        label: kind.label,
        title,
        detail: sessionHostLabel(session, hostCards) + ' / ' + lastActiveLabel(activityTime(session), now),
        actionLabel: watchActionLabel(kind.label),
      };
    });
}

export function operatorWorkWatch({ sessions = [], hostCards = [], now = Date.now(), limit = 3 } = {}) {
  const watched = operatorWatchItems({ sessions, hostCards, now, limit })
    .map((item) => item.label + ' ' + item.title + ' / ' + item.detail);

  return watched.length ? watched.join('; ') : 'no watched sessions';
}

function matchesActionMode(session = {}, mode = 'all', now = Date.now()) {
  if (mode === 'cleanup') return session.status === 'error' || session.status === 'exited';
  if (mode === 'stale') return isStaleResumableSession(session, now);
  if (mode === 'resume') return session.status === 'dormant' && !isStaleResumableSession(session, now);
  if (mode === 'running') return isLiveSession(session);
  return true;
}

function firstSessionAction(sessions = [], mode, now, sessionLabel, filterLabel) {
  const session = sortSessionsForOperator(sessions.filter((candidate) => matchesActionMode(candidate, mode, now)))[0];
  if (session?.id) return { kind: 'session-inspect', label: sessionLabel, sessionId: session.id, filter: mode };
  return { kind: 'filter', label: filterLabel, filter: mode };
}

export function operatorNextActions({ sessions = [], tunnels = [], hostCards = [], limit = 4, now = Date.now() } = {}) {
  const metrics = operatorMetrics({ sessions, tunnels, hosts: hostCards.filter((host) => host.host && host.host !== 'local').map((host) => host.host), now });
  const offlineHosts = hostCards.filter((host) => host.host && host.host !== 'local' && host.tone === 'offline').length;
  const firstTunnel = tunnels.find((tunnel) => tunnelStatusView(tunnel).tone === 'ok') || tunnels[0];
  const freshDormant = Math.max(0, metrics.dormant - metrics.stale);
  const actions = [];

  if (metrics.failed) actions.push({
    id: 'cleanup',
    tone: 'alert',
    title: 'Clean up ' + plural(metrics.failed, 'session'),
    detail: 'Review ended or failed work before starting more.',
    action: firstSessionAction(sessions, 'cleanup', now, 'Review first', 'Show cleanup'),
  });
  if (metrics.stale) actions.push({
    id: 'stale',
    tone: 'alert',
    title: 'Review ' + plural(metrics.stale, 'stale parked session'),
    detail: 'Parked for 4h+; inspect context before resuming.',
    action: firstSessionAction(sessions, 'stale', now, 'Inspect first', 'Show stale'),
  });
  if (freshDormant) actions.push({
    id: 'resume',
    tone: 'resume',
    title: 'Resume ' + plural(freshDormant, 'parked session'),
    detail: 'Inspect parked work, then resume only when you mean to.',
    action: firstSessionAction(sessions, 'resume', now, 'Inspect first', 'Show parked'),
  });
  if (metrics.running) actions.push({
    id: 'running',
    tone: 'live',
    title: 'Watch ' + plural(metrics.running, 'running turn'),
    detail: 'Keep an eye on active agents before context drifts.',
    action: firstSessionAction(sessions, 'running', now, 'Open first', 'Show running'),
  });
  if (metrics.activeTunnels) actions.push({
    id: 'tunnels',
    tone: 'live',
    title: 'Check ' + plural(metrics.activeTunnels, 'live tunnel'),
    detail: 'Open forwarded services and confirm they are reachable.',
    action: { kind: 'tunnels', label: 'Open tunnels', host: firstTunnel?.host || 'local' },
  });
  if (offlineHosts) actions.push({
    id: 'hosts',
    tone: 'alert',
    title: 'Recheck ' + plural(offlineHosts, 'offline host'),
    detail: 'Refresh SSH probes before assigning new work there.',
    action: { kind: 'refresh', label: 'Refresh hosts' },
  });
  if (!actions.length) actions.push({
    id: 'start',
    tone: 'quiet',
    title: 'Start a focused session',
    detail: 'Launch locally, or pick a recent project when you are ready.',
    action: { kind: 'new-local', label: 'New local' },
  });

  return actions.slice(0, limit);
}

export function operatorBriefText({ sessions = [], tunnels = [], hostCards = [], now = Date.now() } = {}) {
  return [
    'corral operator brief',
    ...operatorBriefLines({ sessions, tunnels, hostCards, now }).map((line) => line.label + ': ' + line.value),
  ].join('\n');
}

export function operatorBriefLines({ sessions = [], tunnels = [], hostCards = [], now = Date.now() } = {}) {
  const metrics = operatorMetrics({ sessions, tunnels, hosts: hostCards.filter((host) => host.host && host.host !== 'local').map((host) => host.host), now });
  const offlineHosts = hostCards.filter((host) => host.host && host.host !== 'local' && host.tone === 'offline').length;
  const actions = operatorNextActions({ sessions, tunnels, hostCards, now });
  return [
    { id: 'sessions', label: 'sessions', value: `${metrics.running} running / ${metrics.dormant} parked / ${metrics.stale} stale / ${metrics.failed} cleanup` },
    { id: 'work-watch', label: 'work watch', value: operatorWorkWatch({ sessions, hostCards, now }) },
    { id: 'network', label: 'network', value: `${metrics.activeTunnels} tunnels up / ${plural(offlineHosts, 'offline host')}` },
    { id: 'host-watch', label: 'host watch', value: offlineHostSummary(hostCards) },
    { id: 'next', label: 'next', value: actions.map((action) => action.title).join('; ') },
  ];
}

export function operatorAttention(metrics = {}) {
  if (metrics.failed) return { tone: 'alert', title: metrics.failed + ' session' + (metrics.failed === 1 ? '' : 's') + ' needs cleanup', detail: 'Remove ended or failed sessions when you are done inspecting them.' };
  if (metrics.stale) return { tone: 'alert', title: metrics.stale + ' stale parked session' + (metrics.stale === 1 ? '' : 's'), detail: 'Inspect context before resuming older work.' };
  if (metrics.dormant) return { tone: 'resume', title: metrics.dormant + ' session' + (metrics.dormant === 1 ? '' : 's') + ' ready to resume', detail: 'Pick up work exactly where the previous run stopped.' };
  if (metrics.running) return { tone: 'live', title: metrics.running + ' session' + (metrics.running === 1 ? '' : 's') + ' running', detail: 'Keep this desk open and let background turns finish.' };
  return { tone: 'quiet', title: 'Desk is clear', detail: 'Start a local session, jump to a host, or open files with Ctrl K.' };
}

export function sortSessionsForOperator(sessions = []) {
  return [...sessions].sort((a, b) => {
    const aw = isLiveSession(a) ? weights.busy : (weights[a.status] ?? 5);
    const bw = isLiveSession(b) ? weights.busy : (weights[b.status] ?? 5);
    return aw - bw || activityTime(b) - activityTime(a);
  });
}

export function sessionAction(session = {}) {
  if (isLiveSession(session)) return { kind: 'kill', label: 'Stop' };
  if (session.status === 'error' || session.status === 'exited') return { kind: 'remove', label: 'Remove' };
  if (session.status === 'dormant') return { kind: 'open', label: 'Resume' };
  return { kind: 'open', label: 'Open' };
}

export function sessionInspectAction(session = {}) {
  const resumable = session.status === 'dormant';
  return {
    kind: 'inspect',
    label: 'Inspect',
    title: resumable ? 'Inspect session without resuming it' : isLiveSession(session) ? 'Inspect running session' : 'Inspect session',
  };
}

export function sessionSidebarView(session = {}, formatModel = (model) => model) {
  const action = sessionAction(session);
  const resumable = session.status === 'dormant';
  return {
    inspect: sessionInspectAction(session),
    action: resumable ? action : null,
    meta: resumable ? 'parked' : session.model ? formatModel(session.model) : (session.status || ''),
  };
}

export function sessionStatusLabel(session = {}) {
  if (session.status === 'busy') return 'running';
  if (session.status === 'starting') return 'starting';
  if (session.status === 'dormant') return 'to resume';
  if (session.status === 'exited') return 'ended';
  if (session.status === 'error') return 'error';
  if (session.status === 'idle' && session.model) return clean(session.model);
  return session.status || 'unknown';
}

export function sessionTone(sessionOrStatus) {
  const status = typeof sessionOrStatus === 'string' ? sessionOrStatus : sessionOrStatus?.status;
  if (status === 'busy' || status === 'starting') return 'busy';
  if (status === 'dormant') return 'dormant';
  if (status === 'error' || status === 'exited') return 'off';
  return 'idle';
}

// Cumulative usage across the roster: tokens accumulate for every agent; costUsd sums only where
// an agent reports dollars (claude reports API-equivalent cost even on subscription; codex is
// tokens-only). Null cost means "nothing priced", not zero.
export function sessionUsageTotals(sessions = []) {
  let tokens = 0, cost = null;
  for (const s of sessions) {
    tokens += (s.tokIn || 0) + (s.tokOut || 0);
    if (s.costUsd != null) cost = (cost || 0) + s.costUsd;
  }
  return { tokens, costUsd: cost };
}
