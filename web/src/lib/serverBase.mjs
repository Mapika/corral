// Where is the backend? '' = same origin (desktop webview, vite dev, a phone browser opened on
// the pair URL). A standalone client — the mobile app, whose pages ship inside the app bundle —
// stores an absolute base like 'http://192.168.0.24:7879' plus the durable pairing token.
// Pure helpers; storage/wiring live in api.js / main.js.

export const SERVER_KEY = 'corral-server';
export const TOKEN_KEY = 'corral-remote-token';

// Canonicalize whatever the operator typed/pasted into an origin: scheme + host [+ port].
// 'http://' is assumed when missing (LAN pairing is plain http). Returns '' when hopeless.
export function normalizeBase(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) return '';   // non-http scheme
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    if (!u.hostname || (u.protocol !== 'http:' && u.protocol !== 'https:')) return '';
    return u.protocol + '//' + u.host;   // host keeps a non-default port, drops path/hash/creds
  } catch (e) {
    return '';
  }
}

// A pair link is the QR payload: http://<addr>:<port>/#tk=<hex>. Accept that, a bare origin, or
// anything URL-ish the operator pastes; pull the token out of the fragment (or ?tk=).
export function parsePairInput(text) {
  const s = String(text || '').trim();
  const base = normalizeBase(s);
  const m = s.match(/[#?&]tk=([a-f0-9]{16,})/i);
  return { base, token: m ? m[1] : '' };
}

export function buildPairUrl(address, port, token) {
  if (!address || !token) return '';
  return 'http://' + address + ':' + port + '/#tk=' + token;
}

// ws(s):// URL for a socket path — derived from the configured base, else the current page.
export function wsUrl(base, path, loc = globalThis.location) {
  const origin = base || (loc ? loc.protocol + '//' + loc.host : '');
  return origin.replace(/^http/i, 'ws') + path;
}

// Is this page a standalone client (no same-origin backend)? True inside the mobile app's
// webview, whose pages are served from the app bundle rather than the corral server.
export function isStandaloneShell(loc = globalThis.location) {
  if (!loc) return false;
  const proto = String(loc.protocol || '');
  const host = String(loc.hostname || '');
  return proto === 'tauri:' || host === 'tauri.localhost' || host.endsWith('.tauri.localhost');
}

export function isLoopbackPage(loc = globalThis.location) {
  if (!loc) return false;
  const host = String(loc.hostname || '');
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
}
