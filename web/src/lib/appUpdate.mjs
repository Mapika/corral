// Pure pieces of the APK's "check for updates" flow: dotted-version compare and mapping the
// GitHub releases/latest payload against the running version.

export function compareVersions(a, b) {
  const pa = String(a || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

// releases/latest JSON + the running version -> what the settings sheet shows.
export function releaseUpdate(release, current) {
  const latest = String(release?.tag_name || '').replace(/^v/, '');
  if (!latest) return { error: 'no release found' };
  return {
    latest,
    url: String(release?.html_url || 'https://github.com/Mapika/corral/releases/latest'),
    newer: compareVersions(latest, current) > 0,
  };
}

// A push notification's corral://session/<id> deep link -> the session id, or null for anything
// else (unknown host, malformed, non-corral scheme).
export function sessionFromDeepLink(url) {
  const text = String(url || '').trim();
  const m = text.match(/^corral:\/\/session\/([^/?#]+)/i);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch (e) { return null; }
}
