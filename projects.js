// projects.js — a git remote is a global project identity (0.8). Two checkouts of the same
// origin on different ranches are two places the same project can run; the console groups
// them by the identity this module computes and picks the machine. Checkouts are recorded as
// a side effect of launching/queueing in a dir — never scanned for — and persist in
// <data-dir>/projects.json (same atomic tmp+rename + legacy ~/.codapp fallback as queue.js).
// A repo with no remote has no identity (remote:null) and stays a per-ranch local, like today.
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const STORE = path.join(DATA_DIR, 'projects.json');
const CAP = 100;

// Normalize a git remote URL to a stable identity: strip protocol/credentials/port/.git,
// lowercase (GitHub-style hosts and paths are case-insensitive; matching beats fidelity).
// ssh scp-form and https converge: git@github.com:Mapika/Corral.git and
// https://user:tok@github.com/mapika/corral.git are both github.com/mapika/corral.
// Anything unshareable (filesystem path, Windows drive, garbage) → null.
function normalizeRemote(url) {
  const s = String(url || '').trim();
  if (!s) return null;
  let host, p;
  if (s.includes('://')) {
    let u;
    try { u = new URL(s); } catch (e) { return null; }
    if (!/^(https?|ssh|git|ftps?):$/.test(u.protocol)) return null;
    host = u.hostname; p = u.pathname;
  } else {
    const m = /^(?:[\w.-]+@)?([\w][\w.-]*):([^/].*)$/.exec(s);   // scp-form: [user@]host:path
    if (!m || /^[a-zA-Z]$/.test(m[1])) return null;              // single letter host = a Windows drive, not a remote
    host = m[1]; p = m[2];
  }
  p = p.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!host || !p) return null;
  return (host + '/' + p).toLowerCase();
}

const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

// --- store: {checkouts:[{root, remote|null, name, lastSeen}]}, keyed by root ---
let checkouts = [];
let loaded = false;
function loadStore() {
  loaded = true;
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    checkouts = Array.isArray(parsed.checkouts) ? parsed.checkouts.filter(c => c && typeof c.root === 'string') : [];
  } catch (e) { checkouts = []; }
}
function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE + '.tmp', JSON.stringify({ checkouts: checkouts.slice(0, CAP) }));
    fs.renameSync(STORE + '.tmp', STORE);
  } catch (e) {}
}

// Best-effort, called from the launch route and queue.add AFTER dir validation and BEFORE any
// worktree is made (so the recorded root is the operator's checkout, not a corral/ worktree).
// Never throws — identity is a convenience, not a launch precondition.
function record(dir) {
  if (!loaded) loadStore();
  let root;
  try { root = git(['-C', dir, 'rev-parse', '--show-toplevel']).trim(); } catch (e) { return null; }
  if (!root) return null;
  let remote = null;
  try { remote = normalizeRemote(git(['-C', root, 'remote', 'get-url', 'origin']).trim()); } catch (e) {}
  const name = remote ? remote.split('/').pop() : path.basename(root);
  checkouts = checkouts.filter(c => c.root !== root);
  checkouts.unshift({ root, remote, name, lastSeen: Date.now() });
  if (checkouts.length > CAP) checkouts.length = CAP;
  persist();
  return checkouts[0];
}

// Prune checkouts whose dir vanished (repo moved/deleted), then hand the rest to the console.
function list() {
  if (!loaded) loadStore();
  const kept = checkouts.filter(c => { try { return fs.existsSync(c.root); } catch (e) { return false; } });
  if (kept.length !== checkouts.length) { checkouts = kept; persist(); }
  return checkouts.map(c => ({ dir: c.root, root: c.root, remote: c.remote || null, name: c.name, lastSeen: c.lastSeen || null }));
}

module.exports = { record, list, normalizeRemote };
