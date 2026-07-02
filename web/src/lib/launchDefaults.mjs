// Per-project launch memory: the agent/permission/model/worktree combo last used for a
// host+directory, so relaunching a project is two taps. Pure map-in/map-out helpers; the caller
// owns localStorage.

export const LAUNCH_DEFAULTS_KEY = 'corral-launch-defaults';
const CAP = 40;

const keyOf = (host, dir) => (host || 'local') + '\0' + String(dir || '');

export function parseLaunchDefaults(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

export function launchDefaultsFor(map, host, dir) {
  const d = map[keyOf(host, dir)];
  if (!d || typeof d !== 'object') return null;
  return { agent: d.agent || 'claude', perm: d.perm || 'auto', model: d.model || null, worktree: !!d.worktree };
}

// Returns a NEW map with the entry remembered and the oldest entries dropped past the cap.
export function rememberLaunchDefaults(map, { host, dir, agent, perm, model, worktree, now = Date.now() } = {}) {
  const next = { ...map };
  next[keyOf(host, dir)] = { agent: agent || 'claude', perm: perm || 'auto', model: model || null, worktree: !!worktree, ts: now };
  const keys = Object.keys(next);
  if (keys.length > CAP) {
    keys.sort((a, b) => (next[a].ts || 0) - (next[b].ts || 0));
    for (const k of keys.slice(0, keys.length - CAP)) delete next[k];
  }
  return next;
}

export function serializeLaunchDefaults(map) {
  return JSON.stringify(map);
}
