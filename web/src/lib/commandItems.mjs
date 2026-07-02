import { isResumableSession, isStaleResumableSession, lastActiveLabel, operatorNextActions, operatorWatchItems } from './operatorStatus.mjs';
import { dashboardRecentProjects } from './dashboardRecentProjects.mjs';
import { buildHostCards } from './hostHealth.mjs';
import { tunnelStatusView } from './tunnelStatus.mjs';

const labelForHost = (host, label) => host === 'local' ? 'this computer' : (label || host);
const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.:-]+/g, ' ').trim();
const clean = (s) => String(s || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/\[[0-9;]*m\]?/g, '').trim();
const compact = (item) => norm([item.title, item.subtitle, item.kind, item.host, item.keywords].join(' '));
const actionPriority = (id) => id === 'cleanup' ? 9 : id === 'stale' ? 10 : id === 'resume' ? 11 : 13;
const filterLabels = { cleanup: 'Show cleanup', stale: 'Show stale', resume: 'Show parked', running: 'Show running' };
const sessionPrefixes = { cleanup: 'Review cleanup ', stale: 'Inspect stale ', resume: 'Inspect parked ', running: 'Open running ' };

function item(data) {
  return { keywords: '', ...data, search: compact(data) };
}

export function buildCommandItems({ groups = [], sessions = [], tunnels = [], recentRoots = [], hostStatuses = [], now = Date.now() } = {}) {
  const hostCards = buildHostCards({ groups, sessions, statuses: hostStatuses });
  const out = [
    item({
      id: 'view:dashboard',
      kind: 'view',
      title: 'Open dashboard',
      subtitle: 'Return to the operator desk',
      priority: 0,
      keywords: 'home operator overview status',
    }),
    item({
      id: 'operator:brief',
      kind: 'operator-brief',
      title: 'Copy operator brief',
      subtitle: 'Copy today\'s sessions, tunnels, hosts, and next actions',
      priority: 8,
      keywords: 'copy daily operator status brief standup summary clipboard',
    }),
    item({
      id: 'history',
      kind: 'history',
      title: 'Search session history',
      subtitle: 'Full-text search across past transcripts',
      priority: 12,
      keywords: 'history search past transcripts sessions find conversation',
    }),
  ];

  for (const action of operatorNextActions({ sessions, tunnels, hostCards, now })) {
    if (action.action.kind === 'session-inspect') {
      const session = sessions.find((candidate) => candidate.id === action.action.sessionId) || {};
      const name = base(session.cwd);
      out.push(item({
        id: 'operator-session:' + action.id + ':' + action.action.sessionId,
        kind: 'session-inspect',
        host: session.host,
        sessionId: action.action.sessionId,
        title: (sessionPrefixes[action.id] || 'Inspect ') + name,
        subtitle: [action.title, session.host === 'local' ? 'this computer' : session.host, action.detail].filter(Boolean).join(' / '),
        priority: actionPriority(action.id),
        keywords: 'operator next action inspect review open session ' + action.id + ' ' + action.title + ' ' + name + ' ' + session.cwd,
      }));
      if (action.action.filter) {
        out.push(item({
          id: 'operator-filter:' + action.action.filter,
          kind: 'operator-filter',
          filter: action.action.filter,
          title: filterLabels[action.action.filter] || 'Show sessions',
          subtitle: action.title + ' / ' + action.detail,
          priority: actionPriority(action.id) + 20,
          keywords: 'operator next action dashboard queue filter show ' + action.id + ' ' + action.title + ' ' + (filterLabels[action.action.filter] || ''),
        }));
      }
    } else if (action.action.kind === 'filter') {
      out.push(item({
        id: 'operator-filter:' + action.action.filter,
        kind: 'operator-filter',
        filter: action.action.filter,
        title: action.action.label,
        subtitle: action.title + ' / ' + action.detail,
        priority: actionPriority(action.id),
        keywords: 'operator next action dashboard queue filter ' + action.id + ' ' + action.title + ' ' + action.action.label,
      }));
    } else if (action.action.kind === 'tunnels') {
      out.push(item({
        id: 'operator-filter:tunnels',
        kind: 'tunnels',
        host: action.action.host,
        title: action.action.label,
        subtitle: action.title + ' / ' + action.detail,
        priority: 15,
        keywords: 'operator next action tunnel service forward open live',
      }));
    } else if (action.action.kind === 'refresh') {
      out.push(item({
        id: 'operator-refresh:hosts',
        kind: 'operator-refresh',
        title: action.action.label,
        subtitle: action.title + ' / ' + action.detail,
        priority: 16,
        keywords: 'operator next action refresh hosts ssh probes offline',
      }));
    } else if (action.action.kind === 'new-local') {
      out.push(item({
        id: 'operator-new:local',
        kind: 'new-chat',
        host: 'local',
        title: action.action.label,
        subtitle: action.title + ' / ' + action.detail,
        priority: 10,
        keywords: 'operator next action start focused session local new chat',
      }));
    }
  }

  for (const watched of operatorWatchItems({ sessions, hostCards, now })) {
    if (!watched.sessionId) continue;
    const session = sessions.find((candidate) => candidate.id === watched.sessionId) || {};
    out.push(item({
      id: 'operator-watch:' + watched.sessionId,
      kind: 'session-inspect',
      host: session.host,
      sessionId: watched.sessionId,
      title: watched.actionLabel + ' watched ' + watched.title,
      subtitle: watched.label + ' / ' + watched.detail,
      priority: watched.label === 'cleanup' ? 9 : watched.label === 'stale' ? 10 : watched.label === 'running' ? 13 : 17,
      keywords: 'operator work watch daily attention inspect review open session ' + watched.label + ' ' + watched.title + ' ' + watched.detail + ' ' + session.cwd,
    }));
  }

  for (const g of groups) {
    const label = labelForHost(g.host, g.label);
    const card = hostCards.find((host) => host.host === (g.host || 'local'));
    if (card?.canLaunch !== false) {
      out.push(item({
        id: 'new:' + g.host,
        kind: 'new-chat',
        host: g.host,
        title: 'New chat on ' + label,
        subtitle: g.host === 'local' ? 'Start Claude locally' : 'Start Claude over SSH',
        priority: g.host === 'local' ? 10 : 22,
        keywords: 'chat start session create claude ' + label,
      }));
    }
    out.push(item({
      id: 'files:' + g.host,
      kind: 'files',
      host: g.host,
      title: 'Browse files on ' + label,
      subtitle: g.host === 'local' ? 'Open local home directory' : 'Open remote file browser',
      priority: g.host === 'local' ? 30 : 34,
      keywords: 'files folder browse project ' + label,
    }));
    out.push(item({
      id: 'terminal:' + g.host,
      kind: 'terminal',
      host: g.host,
      title: 'Terminal on ' + label,
      subtitle: g.host === 'local' ? 'Open a local shell' : 'Open an ssh shell',
      priority: g.host === 'local' ? 31 : 35,
      keywords: 'terminal shell ssh console pty ' + label,
    }));
    if (g.host !== 'local') {
      out.push(item({
        id: 'tunnels:' + g.host,
        kind: 'tunnels',
        host: g.host,
        title: 'Manage tunnels on ' + label,
        subtitle: 'Forward remote services to 127.0.0.1',
        priority: 42,
        keywords: 'port forward tunnel ssh service http ' + label,
      }));
    }
  }

  for (const project of dashboardRecentProjects({ groups, roots: recentRoots, sessions, hostCards, limit: 8 })) {
    if (project.canLaunch === false) continue;
    out.push(item({
      id: 'recent-project:' + project.host + ':' + project.dir,
      kind: 'recent-project',
      host: project.host,
      path: project.dir,
      title: 'New chat in ' + project.name,
      subtitle: [project.hostLabel, project.dir].filter(Boolean).join(' / '),
      priority: 36,
      keywords: 'recent project root launch start chat folder ' + project.name + ' ' + project.dir,
    }));
  }

  for (const host of hostCards) {
    for (const target of host.tmuxTargets || []) {
      out.push(item({
        id: 'tmux-attach:' + host.host + ':' + target.name,
        kind: 'tmux-attach',
        host: host.host,
        target: target.name,
        title: 'Attach tmux ' + target.name,
        subtitle: [host.label, target.path].filter(Boolean).join(' / '),
        priority: 32,
        keywords: 'tmux attach terminal shell ' + target.name + ' ' + (target.path || ''),
      }));
      if (!target.path) continue;
      out.push(item({
        id: 'tmux-chat:' + host.host + ':' + target.name,
        kind: 'tmux-chat',
        host: host.host,
        path: target.path,
        title: 'New chat in tmux ' + target.name,
        subtitle: [host.label, target.path].filter(Boolean).join(' / '),
        priority: 33,
        keywords: 'tmux terminal session chat start project cwd ' + target.name + ' ' + target.path,
      }));
      out.push(item({
        id: 'tmux-files:' + host.host + ':' + target.name,
        kind: 'tmux-files',
        host: host.host,
        path: target.path,
        title: 'Files for tmux ' + target.name,
        subtitle: [host.label, target.path].filter(Boolean).join(' / '),
        priority: 35,
        keywords: 'tmux terminal session files folder browse cwd ' + target.name + ' ' + target.path,
      }));
    }
  }

  for (const s of sessions) {
    const name = base(s.cwd);
    const hostLabel = s.host === 'local' ? 'this computer' : s.host;
    const resumable = s.status === 'dormant' || isResumableSession(s);
    const cleanup = s.status === 'error' || s.status === 'exited';
    const activeAt = s.updatedAt || s.createdAt;
    const stale = isStaleResumableSession(s, now);
    if (stale) {
      out.push(item({
        id: 'session-inspect:' + s.id,
        kind: 'session-inspect',
        host: s.host,
        sessionId: s.id,
        title: 'Inspect stale ' + name,
        subtitle: [hostLabel, 'parked ' + lastActiveLabel(activeAt, now), 'review before resuming'].filter(Boolean).join(' / '),
        priority: 11,
        keywords: 'inspect review stale parked dormant old context session chat cwd project ' + name + ' ' + s.cwd,
      }));
    }
    out.push(item({
      id: 'session:' + s.id,
      kind: cleanup ? 'session-remove' : 'session',
      host: s.host,
      sessionId: s.id,
      title: (cleanup ? 'Remove ' : resumable ? 'Resume ' : 'Open ') + name,
      subtitle: [hostLabel, s.status, clean(s.model), activeAt ? lastActiveLabel(activeAt, now) : ''].filter(Boolean).join(' / '),
      priority: cleanup ? 26 : resumable ? 12 : s.status === 'busy' ? 14 : 28,
      keywords: 'session chat cwd project ' + (cleanup ? 'remove cleanup ended failed error ' : '') + name + ' ' + s.cwd,
    }));
    out.push(item({
      id: 'session-files:' + s.id,
      kind: 'session-files',
      host: s.host,
      sessionId: s.id,
      path: s.cwd,
      title: 'Files for ' + name,
      subtitle: [hostLabel, s.cwd].filter(Boolean).join(' / '),
      priority: 32,
      keywords: 'files folder browse project cwd session ' + name + ' ' + s.cwd,
    }));
    out.push(item({
      id: 'session-changes:' + s.id,
      kind: 'session-changes',
      host: s.host,
      sessionId: s.id,
      title: 'Changes for ' + name,
      subtitle: [hostLabel, 'review git diff'].filter(Boolean).join(' / '),
      priority: 31,
      keywords: 'changes diff git review modified files session ' + name + ' ' + s.cwd,
    }));
    if (s.host && s.host !== 'local') {
      out.push(item({
        id: 'session-tunnels:' + s.id,
        kind: 'session-tunnels',
        host: s.host,
        sessionId: s.id,
        title: 'Tunnels for ' + name,
        subtitle: 'Forward services for ' + s.host,
        priority: 44,
        keywords: 'tunnels tunnel port forward service ssh session ' + name + ' ' + s.cwd,
      }));
    }
  }

  for (const t of tunnels) {
    const view = tunnelStatusView(t);
    const localUrl = view.canOpen ? 'http://127.0.0.1:' + t.localPort : '';
    out.push(item({
      id: 'tunnel:' + t.id,
      kind: 'tunnel',
      host: t.host,
      tunnelId: t.id,
      title: (view.canOpen ? 'Open ' : 'Inspect ') + '127.0.0.1:' + t.localPort,
      subtitle: [t.host, t.remoteHost + ':' + t.remotePort, view.label].filter(Boolean).join(' / '),
      url: localUrl,
      canOpen: view.canOpen,
      priority: view.tone === 'ok' ? 18 : view.tone === 'warn' ? 24 : 46,
      keywords: 'tunnel port forward http local service ' + t.localPort + ' ' + t.remotePort,
    }));
  }

  return out.sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title));
}

export function filterCommandItems(items, query, limit = 10) {
  const q = norm(query);
  if (!q) return items.slice().sort((a, b) => a.priority - b.priority || a.title.localeCompare(b.title)).slice(0, limit);
  const tokens = q.split(/\s+/).filter(Boolean);
  return items
    .map((entry) => {
      const search = entry.search || compact(entry);
      if (!tokens.every((token) => search.includes(token))) return null;
      const title = norm(entry.title);
      const starts = tokens.filter((token) => title.startsWith(token)).length;
      const titleHits = tokens.filter((token) => title.includes(token)).length;
      return { entry, score: (starts * 20) + (titleHits * 8) - entry.priority };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.entry.priority - b.entry.priority || a.entry.title.localeCompare(b.entry.title))
    .slice(0, limit)
    .map((x) => x.entry);
}
