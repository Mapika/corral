import { recentRootsForHost } from './recentRoots.mjs';

const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
const hostLabel = (host, label) => host === 'local' ? 'this computer' : (label || host);

export function dashboardRecentProjects({ groups = [], roots = [], sessions = [], hostCards = [], limit = 6 } = {}) {
  const known = new Set(groups.map((g) => g.host || 'local'));
  const cards = new Map(hostCards.map((card) => [card.host || 'local', card]));
  const projects = [];

  for (const group of groups) {
    const host = group.host || 'local';
    const card = cards.get(host);
    for (const root of recentRootsForHost({ host, roots, sessions, limit })) {
      if (!known.has(root.host)) continue;
      projects.push({
        ...root,
        name: base(root.dir),
        hostLabel: hostLabel(root.host, group.label),
        canLaunch: card?.canLaunch !== false,
        launchBlockedLabel: card?.launchBlockedLabel || '',
      });
    }
  }

  return projects
    .sort((a, b) => b.ts - a.ts || a.hostLabel.localeCompare(b.hostLabel) || a.name.localeCompare(b.name))
    .slice(0, limit);
}
