// The ranch roster: every corral server this phone is paired with, as one localStorage record.
// Pure logic only — storage/wiring live in main.js and the mobile data layer. A ranch is
// { id, name, base, token, addedAt }; the id is what sessions get tagged with, so it must stay
// stable across renames and token refreshes.
export const RANCHES_KEY = 'corral-ranches';

const genId = () => {
  try { return crypto.randomUUID().slice(0, 8); } catch (e) { return Math.random().toString(36).slice(2, 10); }
};

export function parseRanches(raw) {
  try {
    const v = JSON.parse(raw || 'null');
    const list = Array.isArray(v) ? v : Array.isArray(v?.ranches) ? v.ranches : [];
    return list
      .filter((r) => r && typeof r === 'object' && r.base && r.token && r.id)
      .map((r) => ({ id: String(r.id), name: String(r.name || r.base), base: String(r.base), token: String(r.token), addedAt: Number(r.addedAt) || 0 }));
  } catch (e) {
    return [];
  }
}

export function serializeRanches(list) {
  return JSON.stringify({ v: 1, ranches: list });
}

// Default display name for a new ranch: the server's hostname when it told us one, else the
// host part of the base URL. Short, human, always non-empty for a valid base.
export function defaultRanchName(base, hostname) {
  const h = String(hostname || '').trim();
  if (h) return h;
  try { return new URL(base).hostname; } catch (e) { return String(base || ''); }
}

// Two ranches may legitimately end up with the same default name (two boxes both called
// "desktop") — suffix the newcomer so the roster never shows two identical labels.
function uniqueName(list, name, skipId) {
  const taken = new Set(list.filter((r) => r.id !== skipId).map((r) => r.name.toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const cand = name + ' ' + n;
    if (!taken.has(cand.toLowerCase())) return cand;
  }
}

// Add a pairing to the roster. Re-pairing a base we already know is a token refresh, not a
// duplicate: same id, same name, new token — the conflict UX is "already paired, key refreshed".
export function upsertRanch(list, { base, token, name, now = 0, id }) {
  const existing = list.find((r) => r.base === base);
  if (existing) {
    const ranch = { ...existing, token };
    return { list: list.map((r) => (r === existing ? ranch : r)), ranch, refreshed: true };
  }
  const ranch = { id: id || genId(), name: uniqueName(list, name || defaultRanchName(base)), base, token, addedAt: now };
  return { list: [...list, ranch], ranch, refreshed: false };
}

export function renameRanch(list, id, name) {
  const next = String(name || '').trim().slice(0, 40);
  if (!next) return list;
  return list.map((r) => (r.id === id ? { ...r, name: uniqueName(list, next, id) } : r));
}

export function removeRanch(list, id) {
  return list.filter((r) => r.id !== id);
}

// One merged herd out of per-ranch rosters, each session tagged with its ranch id + name so
// every screen can route actions back to the right server. Ranch order is roster order — stable
// under reconnects, no reshuffling while the operator is looking at the list.
export function mergeSessions(ranches, sessionsByRanch) {
  const out = [];
  for (const r of ranches) {
    for (const s of sessionsByRanch[r.id] || []) out.push({ ...s, ranch: r.id, ranchName: r.name });
  }
  return out;
}

// Keyed-each key for a merged session: ids are unique per server, not across servers.
export const sessionKey = (s) => (s.ranch || '') + ':' + s.id;
