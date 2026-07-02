import { isResumableSession, isStaleResumableSession, sessionStatusLabel, sortSessionsForOperator } from './operatorStatus.mjs';

export const SESSION_QUEUE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'running', label: 'Running' },
  { id: 'resume', label: 'Resume' },
  { id: 'stale', label: 'Stale' },
  { id: 'cleanup', label: 'Cleanup' },
];

const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.:-]+/g, ' ').trim();

function matchesMode(session = {}, mode = 'all', now = Date.now()) {
  if (mode === 'running') return session.status === 'busy' || session.status === 'starting';
  if (mode === 'resume') return session.status === 'dormant' || isResumableSession(session);
  if (mode === 'stale') return isStaleResumableSession(session, now);
  if (mode === 'cleanup') return session.status === 'error' || session.status === 'exited';
  return true;
}

function matchesQuery(session = {}, query = '') {
  const q = norm(query);
  if (!q) return true;
  const haystack = norm([
    base(session.cwd),
    session.cwd,
    session.host === 'local' ? 'this computer local' : session.host,
    session.status,
    sessionStatusLabel(session),
    session.model,
  ].join(' '));
  return q.split(/\s+/).filter(Boolean).every((token) => haystack.includes(token));
}

function matchesHost(session = {}, host = 'all') {
  if (!host || host === 'all') return true;
  return (session.host || 'local') === host;
}

export function filterSessionsForQueue(sessions = [], { mode = 'all', query = '', host = 'all', now = Date.now() } = {}) {
  return sortSessionsForOperator(sessions).filter((session) => matchesMode(session, mode, now) && matchesHost(session, host) && matchesQuery(session, query));
}

export function queueFilterCount(sessions = [], mode = 'all', now = Date.now(), host = 'all') {
  return sessions.filter((session) => matchesMode(session, mode, now) && matchesHost(session, host)).length;
}
