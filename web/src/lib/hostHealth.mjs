function shortError(error) {
  const text = String(error || '').trim();
  if (!text) return 'unreachable';
  if (/timed out/i.test(text)) return 'Connection timed out';
  if (/permission denied/i.test(text)) return 'Permission denied';
  if (/could not resolve|name or service not known|nodename nor servname/i.test(text)) return 'Name not resolved';
  // A non-POSIX remote shell (Windows cmd.exe / PowerShell) choking on the probe — show why, not the raw noise.
  if (/is not recognized as an internal or external command|was unexpected at this time|is not recognized as the name of a cmdlet|running scripts is disabled on this system/i.test(text)) return 'Incompatible shell — needs a POSIX/bash host';
  if (/^command failed:/i.test(text)) return 'SSH probe failed';
  return text.split(/\r?\n/)[0].slice(0, 80);
}

export function hostTone(status = {}) {
  if (!status.host || status.host === 'local') return 'local';
  if (status.ok === true) return 'online';
  if (status.ok === false) return 'offline';
  return 'unknown';
}

function statusDetail(status = {}) {
  const tone = hostTone(status);
  if (tone === 'local') return 'this computer';
  if (tone === 'offline') return shortError(status.error);
  if (tone === 'unknown') return status.stale ? 'probe in progress' : 'refresh to inspect';

  const tmux = tmuxTargets(status).length;   // grouped views collapse to one, so counts match rows
  const agents = Array.isArray(status.cc) ? status.cc.length : 0;
  if (tmux || agents) return tmux + ' tmux / ' + agents + ' agent' + (agents === 1 ? '' : 's');
  return 'reachable';
}

function tmuxTargets(status = {}) {
  if (!Array.isArray(status.tmux)) return [];
  const raw = status.tmux
    .map((session) => ({
      name: String(session?.name || '').trim(),
      group: String(session?.group || '').trim(),
      path: String(session?.path || '').trim(),
      attached: !!session?.attached,
      windows: Number(session?.windows || 0),
    }))
    .filter((session) => session.name);
  // Grouped sessions (`tmux new-session -t <group>` siblings like "1-48") are independent VIEWS of
  // one shared window set, not separate sessions — collapse each group into a single target with a
  // views count. The attached sibling's active window wins the displayed path (that's where the
  // operator actually is), falling back to the primary, then the first seen.
  const out = [];
  const grouped = new Map();
  for (const s of raw) {
    if (!s.group) { out.push({ name: s.name, path: s.path, attached: s.attached, windows: s.windows, views: 1 }); continue; }
    let members = grouped.get(s.group);
    if (!members) { members = []; grouped.set(s.group, members); out.push(members); }
    members.push(s);
  }
  return out.map((t) => {
    if (!Array.isArray(t)) return t;
    const group = t[0].group;
    const live = t.find((s) => s.attached) || t.find((s) => s.name === group) || t[0];
    return { name: group, path: live.path, attached: t.some((s) => s.attached), windows: live.windows, views: t.length };
  });
}

function launchState({ host, label, tone, status = {}, detail = '' } = {}) {
  if (tone === 'local' || tone === 'online') return { canLaunch: true, launchBlockedLabel: '' };
  if (tone === 'offline') return { canLaunch: false, launchBlockedLabel: (label || host) + ' is offline: ' + (detail || 'unreachable') };
  if (status.ok === null) return { canLaunch: false, launchBlockedLabel: (label || host) + ' is still checking' };
  return { canLaunch: true, launchBlockedLabel: '' };
}

export function needsHostStatusFollowUp(statuses = []) {
  return statuses.some((status) => status && status.ok == null);
}

export function buildHostCards({ groups = [], sessions = [], statuses = [] } = {}) {
  const byHost = new Map(statuses.map((status) => [status.name || status.host, status]));
  return groups.map((group) => {
    const host = group.host || 'local';
    const status = host === 'local' ? { host: 'local', ok: true } : { host, ...(byHost.get(host) || {}) };
    const tone = hostTone(status);
    const label = group.label || host;
    const detail = statusDetail(status);
    const launch = launchState({ host, label, tone, status, detail });
    return {
      host,
      label,
      tone,
      statusLabel: tone === 'local' ? 'local' : tone === 'online' ? 'online' : tone === 'offline' ? 'offline' : (status.stale ? 'checking' : 'not checked'),
      detail,
      tmuxTargets: tone === 'online' ? tmuxTargets(status) : [],
      sessions: sessions.filter((session) => (session.host || 'local') === host).length,
      canLaunch: launch.canLaunch,
      launchBlockedLabel: launch.launchBlockedLabel,
      raw: status,
    };
  });
}
