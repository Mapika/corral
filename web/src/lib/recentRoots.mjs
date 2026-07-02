export const RECENT_ROOTS_KEY = 'codapp.recentRoots.v1';

export function normalizeRootDir(dir) {
  const raw = String(dir || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw === '/') return '/';
  return raw.replace(/\/+$/g, '') || '/';
}

const keyFor = (root) => String(root.host || 'local') + '\n' + normalizeRootDir(root.dir).toLowerCase();
const cleanRoot = (root) => {
  const host = String(root?.host || 'local');
  const dir = normalizeRootDir(root?.dir);
  const ts = Number(root?.ts || root?.updatedAt || root?.createdAt || 0);
  if (!host || !dir || !Number.isFinite(ts)) return null;
  return { host, dir, ts };
};

export function rememberLaunchRoot(roots = [], root = {}, limit = 24) {
  const next = cleanRoot(root);
  const merged = next
    ? [next, ...roots.map(cleanRoot).filter(Boolean)]
    : roots.map(cleanRoot).filter(Boolean);
  const seen = new Set();
  return merged
    .sort((a, b) => b.ts - a.ts)
    .filter((entry) => {
      const key = keyFor(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function recentRootsForHost({ host = 'local', roots = [], sessions = [], limit = 5 } = {}) {
  const candidates = [];
  for (const s of sessions) {
    if ((s.host || 'local') !== host) continue;
    candidates.push({ host, dir: s.cwd, ts: s.updatedAt || s.createdAt || 0, source: 'session' });
  }
  for (const r of roots) {
    if ((r.host || 'local') !== host) continue;
    candidates.push({ ...r, source: 'recent' });
  }

  const seen = new Set();
  return candidates
    .map((candidate) => {
      const cleaned = cleanRoot(candidate);
      return cleaned ? { ...cleaned, source: candidate.source || 'recent' } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts || (a.source === 'recent' ? -1 : 0) - (b.source === 'recent' ? -1 : 0))
    .filter((entry) => {
      const key = keyFor(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

export function parseRecentRoots(raw) {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.map(cleanRoot).filter(Boolean);
  } catch (e) {
    return [];
  }
}

export function serializeRecentRoots(roots = []) {
  return JSON.stringify(roots.map(cleanRoot).filter(Boolean));
}
