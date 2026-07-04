// One computer, first steps (0.8): pure placement helpers. The backend reports checkouts
// (projects.js) and telemetry (/api/hosts); this module groups checkouts by git-remote
// identity across ranches and ranks the places a project can run. The console is the
// coordinator — no ranch talks to another; suggestion first, manual pick one tap away.

// ranches: [{ id, name, live, telemetry|null, checkouts: [{dir, remote|null, name, lastSeen}] }]
// → projects: [{ key, name, remote|null, places: [{ranch, ranchName, dir, live, telemetry}] }]
// Identity-less checkouts (no remote) stay per-ranch singletons keyed by ranch+dir.
export function groupProjects(ranches) {
  const byKey = new Map();
  for (const r of ranches || []) {
    for (const c of r.checkouts || []) {
      if (!c || !c.dir) continue;
      const key = c.remote || r.id + '\0' + c.dir;
      let p = byKey.get(key);
      if (!p) byKey.set(key, (p = { key, name: c.name || basename(c.dir), remote: c.remote || null, places: [] }));
      p.places.push({ ranch: r.id, ranchName: r.name || r.id, dir: c.dir, live: !!r.live, telemetry: r.telemetry || null, lastSeen: c.lastSeen || 0 });
    }
  }
  // Freshest project first — matches the recents feel of the launch sheet.
  return [...byKey.values()].sort((a, b) => latest(b) - latest(a));
}
const basename = (dir) => String(dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(dir);
const latest = (p) => Math.max(0, ...p.places.map((x) => x.lastSeen || 0));

// Rank candidate places: live first, then plugged-in before on-battery (unknown counts as
// plugged-in — don't punish a ranch for not knowing), then fewest busy sessions, then most
// free memory. [0] is the suggestion; the rest are the one-tap overrides.
export function rankPlaces(places) {
  return [...(places || [])].sort((a, b) =>
    (b.live ? 1 : 0) - (a.live ? 1 : 0)
    || battery(a) - battery(b)
    || busy(a) - busy(b)
    || memFree(b) - memFree(a));
}
const battery = (p) => (p.telemetry && p.telemetry.onBattery === true ? 1 : 0);
const busy = (p) => (p.telemetry && Number.isFinite(p.telemetry.busy) ? p.telemetry.busy : 0);
const memFree = (p) => (p.telemetry && Number.isFinite(p.telemetry.memFree) ? p.telemetry.memFree : 0);

// Roster-sized: `MarkPC · idle` / `homelab · 2 busy` / `laptop · on battery` / `office · offline`
export function placeLabel(place) {
  if (!place) return '';
  const why = !place.live ? 'offline'
    : battery(place) ? 'on battery'
    : busy(place) > 0 ? busy(place) + ' busy'
    : 'idle';
  return place.ranchName + ' · ' + why;
}

// The chip only earns its pixels when there's a real choice: an identified project with 2+
// distinct places. (A lone checkout or a local-only repo launches like it always did.)
export function placeChoices(project) {
  if (!project || !project.remote || (project.places || []).length < 2) return null;
  const ranked = rankPlaces(project.places);
  return ranked.length >= 2 ? ranked : null;
}
