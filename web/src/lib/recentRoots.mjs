export const RECENT_ROOTS_KEY = 'codapp.recentRoots.v1';

export function normalizeRootDir(dir) {
  const raw = String(dir || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw === '/') return '/';
  return raw.replace(/\/+$/g, '') || '/';
}

const keyFor = (root) => String(root.ranch || '') + '\n' + String(root.host || 'local') + '\n' + normalizeRootDir(root.dir).toLowerCase();
const cleanRoot = (root) => {
  const host = String(root?.host || 'local');
  const dir = normalizeRootDir(root?.dir);
  const ts = Number(root?.ts || root?.updatedAt || root?.createdAt || 0);
  if (!host || !dir || !Number.isFinite(ts)) return null;
  // ranch = which paired server this root lives on; absent (desktop, pre-0.6 entries) means
  // "wherever" — such entries match any ranch when filtering.
  return root?.ranch ? { ranch: String(root.ranch), host, dir, ts } : { host, dir, ts };
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

export function recentRootsForHost({ ranch = '', host = 'local', roots = [], sessions = [], limit = 5 } = {}) {
  const candidates = [];
  for (const s of sessions) {
    if ((s.host || 'local') !== host) continue;
    if (ranch && s.ranch && s.ranch !== ranch) continue;
    candidates.push({ ranch: ranch || undefined, host, dir: s.cwd, ts: s.updatedAt || s.createdAt || 0, source: 'session' });
  }
  for (const r of roots) {
    if ((r.host || 'local') !== host) continue;
    if (ranch && r.ranch && r.ranch !== ranch) continue;   // untagged roots match any ranch
    candidates.push({ ...r, source: 'recent' });
  }

  // Dedup by host+dir alone: an untagged (pre-0.6) root and a ranch-tagged session for the same
  // folder are the same suggestion, not two rows.
  const seen = new Set();
  return candidates
    .map((candidate) => {
      const cleaned = cleanRoot(candidate);
      return cleaned ? { ...cleaned, source: candidate.source || 'recent' } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.ts - a.ts || (a.source === 'recent' ? -1 : 0) - (b.source === 'recent' ? -1 : 0))
    .filter((entry) => {
      const key = String(entry.host) + '\n' + normalizeRootDir(entry.dir).toLowerCase();
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
