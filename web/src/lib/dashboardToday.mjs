import { isLiveSession, isStaleResumableSession, lastActiveLabel, sessionStatusLabel, sessionTone, sortSessionsForOperator } from './operatorStatus.mjs';

const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
const plural = (count, word) => count + ' ' + word + (count === 1 ? '' : 's');

function hostLabelForSession(session = {}, hostCards = []) {
  const host = session.host || 'local';
  if (host === 'local') return 'This computer';
  return hostCards.find((card) => card.host === host)?.label || host;
}

function sessionTime(session = {}) {
  return session.updatedAt || session.createdAt || 0;
}

function sessionAttentionRank(session = {}, now = Date.now()) {
  if (session.status === 'error' || session.status === 'exited') return 0;
  if (isStaleResumableSession(session, now)) return 1;
  if (isLiveSession(session)) return 2;
  if (session.status === 'dormant') return 3;
  return null;
}

function sessionItem(session = {}, hostCards = [], now = Date.now(), attention = false) {
  const stale = isStaleResumableSession(session, now);
  const cleanup = session.status === 'error' || session.status === 'exited';
  const live = isLiveSession(session);
  const dormant = session.status === 'dormant';
  const project = base(session.cwd);
  const label = cleanup ? 'Review' : (dormant || stale) ? 'Inspect' : 'Open';
  return {
    type: 'session',
    id: 'session:' + (session.id || project),
    sessionId: session.id,
    title: project,
    eyebrow: stale ? 'stale' : sessionStatusLabel(session),
    detail: hostLabelForSession(session, hostCards) + ' / ' + lastActiveLabel(sessionTime(session), now),
    tone: cleanup || stale ? 'alert' : live ? 'live' : dormant ? 'resume' : sessionTone(session),
    primaryLabel: label,
    attention,
    host: session.host || 'local',
    cwd: session.cwd || '',
  };
}

function projectItem(project = {}) {
  const host = project.host || 'local';
  return {
    type: 'project',
    id: 'project:' + host + ':' + (project.dir || project.name || '~'),
    title: project.name || base(project.dir),
    eyebrow: 'recent',
    detail: (project.hostLabel || (host === 'local' ? 'This computer' : host)) + ' / ' + (project.source || 'project'),
    tone: project.canLaunch === false ? 'quiet' : 'resume',
    primaryLabel: project.canLaunch === false ? 'Unavailable' : 'New chat',
    host,
    dir: project.dir,
    canLaunch: project.canLaunch !== false,
    launchBlockedLabel: project.launchBlockedLabel || '',
  };
}

// Host connectivity is ambient status, not an alarm: an offline box is normal life on a fleet
// (laptops sleep, VMs stop). It gets a one-line footnote pointing at the hosts view instead of
// rows in the attention list; probes still in flight ('unknown') don't surface at all.
function hostNote(hostCards = []) {
  const offline = hostCards.filter((card) => card.host && card.host !== 'local' && card.tone === 'offline');
  if (!offline.length) return null;
  const label = offline.length === 1
    ? (offline[0].label || offline[0].host) + ' is unreachable'
    : offline.length + ' hosts unreachable';
  return { label, hosts: offline.map((card) => card.host) };
}

export function dashboardSummaryStats(metrics = {}) {
  const stale = metrics.stale || 0;
  return [
    {
      id: 'running',
      value: metrics.running || 0,
      label: 'Running',
      detail: 'Active turns',
      tone: metrics.running ? 'live' : 'quiet',
      action: { kind: 'fleet' },
    },
    {
      id: 'parked',
      value: metrics.dormant || 0,
      label: 'Parked',
      detail: stale ? plural(stale, 'stale') : 'Ready to resume',
      tone: stale ? 'alert' : metrics.dormant ? 'resume' : 'quiet',
      action: { kind: 'filter', filter: stale ? 'stale' : 'resume' },
    },
    {
      id: 'hosts',
      value: metrics.hosts || 0,
      label: 'Hosts',
      detail: 'Available',
      tone: 'quiet',
      action: { kind: 'refresh' },
    },
    {
      id: 'tunnels',
      value: metrics.activeTunnels || 0,
      label: 'Tunnels',
      detail: 'Live forwards',
      tone: metrics.activeTunnels ? 'live' : 'quiet',
      action: { kind: 'tunnels' },
    },
  ];
}

export function dashboardToday({ sessions = [], recentProjects = [], hostCards = [], now = Date.now(), limit = 5 } = {}) {
  const note = hostNote(hostCards);
  const attentionItems = sortSessionsForOperator(sessions)
    .map((session) => ({ session, rank: sessionAttentionRank(session, now) }))
    .filter((entry) => entry.rank != null)
    .sort((a, b) => a.rank - b.rank || sessionTime(b.session) - sessionTime(a.session))
    .map(({ session }) => sessionItem(session, hostCards, now, true))
    .slice(0, limit);
  if (attentionItems.length) {
    return {
      title: 'Needs attention',
      detail: attentionItems.length === 1 ? 'One item is waiting for a decision.' : attentionItems.length + ' items are waiting for decisions.',
      emptyActionLabel: 'New local',
      items: attentionItems,
      note,
    };
  }

  const projectItems = recentProjects.map(projectItem).filter((item) => item.canLaunch);
  const idleSessions = sortSessionsForOperator(sessions)
    .filter((session) => session.status === 'idle')
    .map((session) => sessionItem(session, hostCards, now, false));
  const items = [...projectItems, ...idleSessions].slice(0, limit);

  // First run (nothing to resume, nothing recent) gets the onboarding moment instead of a blank.
  const firstRun = !items.length && !sessions.length;
  return {
    title: items.length ? 'Continue work' : 'Ready when you are',
    detail: items.length ? 'Pick up a recent project or reopen a quiet session.' : 'Start a local session when you are ready.',
    emptyActionLabel: 'New local',
    items,
    note,
    empty: items.length ? null : firstRun
      ? { title: 'No agents in the corral yet.', hint: 'Start a session on this computer — every host in your ssh config is already saddled.' }
      : { title: 'Nothing needs your eye.', hint: '' },
  };
}
