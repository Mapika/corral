// Remote access (phone pairing): an opt-in second listener on the LAN so the mobile app / a phone
// browser can reach this backend. Disabled by default — loopback-only stays the baseline. Pairing
// uses a DURABLE token (separate from the per-run desktop token, which rotates every launch and
// would strand a paired phone). Config lives in <data-dir>/remote.json. Assumes a trusted network
// (home LAN / tailnet): the transport is plain http, see SECURITY.md.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Same fallback rule as push.js/chat.js: an existing pre-rename ~/.codapp keeps being used.
const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const CONF = path.join(DATA_DIR, 'remote.json');

// certPath/keyPath (PEM) switch the listener to TLS — point them at a cert the phone will trust:
// `tailscale cert` output, mkcert with the CA installed on the phone, or a real one. Self-signed
// certs work for transport privacy but browsers will interstitial; see SECURITY.md.
const DEFAULTS = Object.freeze({ enabled: false, token: '', port: 7879, certPath: '', keyPath: '' });

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONF, 'utf8'));
    return { ...DEFAULTS, ...parsed };
  } catch (e) {
    return { ...DEFAULTS };
  }
}
let conf = load();

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = CONF + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(conf, null, 2));
    fs.renameSync(tmp, CONF);
  } catch (e) {}
}

function get() {
  return { ...conf, tls: !!(conf.certPath && conf.keyPath) };
}

// Read the PEM pair for the TLS listener. Returns { cert, key } or throws with a path-naming
// message the settings UI can show verbatim.
function loadTls(cfg = conf) {
  const read = (p, what) => {
    try { return fs.readFileSync(p); }
    catch (e) { throw new Error('could not read ' + what + ' at ' + p + ': ' + (e.code || e.message)); }
  };
  return { cert: read(cfg.certPath, 'certificate'), key: read(cfg.keyPath, 'private key') };
}

function set(next = {}) {
  if (next.enabled != null) conf.enabled = !!next.enabled;
  if (next.port != null) {
    const p = Math.floor(+next.port);
    if (!(p >= 1024 && p <= 65535)) throw new Error('port must be 1024-65535');
    conf.port = p;
  }
  // Both or neither: a half-configured TLS pair must not silently fall back to plaintext.
  if (next.certPath != null || next.keyPath != null) {
    const cert = next.certPath != null ? String(next.certPath).trim() : conf.certPath;
    const key = next.keyPath != null ? String(next.keyPath).trim() : conf.keyPath;
    if (!!cert !== !!key) throw new Error('set both certificate and key paths (or clear both)');
    conf.certPath = cert;
    conf.keyPath = key;
  }
  // The pairing token is minted once, on first enable, and survives restarts so a paired phone
  // stays paired. "Rotate" mints a fresh one (un-pairs every phone).
  if ((conf.enabled && !conf.token) || next.rotate) conf.token = crypto.randomBytes(32).toString('hex');
  persist();
  return get();
}

// --- pure helpers (selftested from server.js) ---

// Private/tailnet IPv4: RFC1918 plus the CGNAT range Tailscale uses (100.64/10).
function isPrivateIp(host) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || ''));
  if (!m) return false;
  const [a, b] = [+m[1], +m[2]];
  if (m.slice(1).some(o => +o > 255)) return false;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 100 && b >= 64 && b <= 127);
}

// A browser Origin like http://192.168.1.20:7879 — allowed only for private/tailnet hosts, and
// only consulted when remote mode is on. https passes too (a reverse proxy in front is fine).
function isPrivateOrigin(origin) {
  try {
    const u = new URL(String(origin || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    return isPrivateIp(u.hostname);
  } catch (e) {
    return false;
  }
}

function isLoopbackAddr(addr) {
  const a = String(addr || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

// LAN addresses to show in the pairing QR — private/tailnet IPv4s, most common ranges first.
function lanAddresses(interfaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(interfaces)) {
    for (const it of list || []) {
      const family = it.family === 4 ? 'IPv4' : it.family;   // node >=18 uses the string form
      if (family !== 'IPv4' || it.internal) continue;
      if (isPrivateIp(it.address)) out.push(it.address);
    }
  }
  return [...new Set(out)].sort((x, y) => {
    const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : ip.startsWith('172.') ? 2 : 3);
    return rank(x) - rank(y);
  });
}

module.exports = { get, set, loadTls, isPrivateIp, isPrivateOrigin, isLoopbackAddr, lanAddresses, DEFAULTS };
