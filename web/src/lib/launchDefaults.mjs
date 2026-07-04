// Per-project launch memory: the agent/permission/model/worktree combo last used for a
// host+directory, so relaunching a project is two taps. Pure map-in/map-out helpers; the caller
// owns localStorage.

export const LAUNCH_DEFAULTS_KEY = 'corral-launch-defaults';
const CAP = 40;

// Optional ranch prefix scopes a project to the paired server it lives on; keys without one are
// the pre-0.6 format and still resolve as a fallback, so nobody loses their remembered combos.
const keyOf = (host, dir, ranch) => (ranch ? ranch + '\0' : '') + (host || 'local') + '\0' + String(dir || '');
// 0.8: a git-remote identity key makes the combo follow the project across machines — set the
// perm for corral once, get it on every ranch that has a checkout.
const projectKeyOf = (project) => 'p\0' + project;

export function parseLaunchDefaults(raw) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}

// Lookup order: dir-scoped keys beat the project key (the specific place wins over the
// project-wide default), then the identity key catches checkouts never launched from here.
export function launchDefaultsFor(map, host, dir, ranch, project) {
  const d = map[keyOf(host, dir, ranch)] || (ranch ? map[keyOf(host, dir)] : null) || (project ? map[projectKeyOf(project)] : null);
  if (!d || typeof d !== 'object') return null;
  return { agent: d.agent || 'claude', perm: d.perm || 'auto', model: d.model || null, worktree: !!d.worktree };
}

// Returns a NEW map with the entry remembered and the oldest entries dropped past the cap.
// A known identity is written alongside the dir key so the combo travels with the project.
export function rememberLaunchDefaults(map, { ranch, host, dir, project, agent, perm, model, worktree, now = Date.now() } = {}) {
  const next = { ...map };
  const entry = { agent: agent || 'claude', perm: perm || 'auto', model: model || null, worktree: !!worktree, ts: now };
  if (project) next[projectKeyOf(project)] = entry;
  next[keyOf(host, dir, ranch)] = entry;
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
