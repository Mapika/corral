// agents/common.js — plumbing shared by every agent adapter: binary resolution, shell quoting,
// argv hardening, ssh options, and JSONL stream splitting.
const { execFileSync } = require('child_process');

// Resolve a binary once at startup via where/which; prefer .exe so Node can spawn it without a
// shell (npm .cmd shims need shell:true), then .cmd/.bat over extensionless sh shims. Returns
// `fallback` (default null) when absent, so a missing agent CLI degrades to a clean
// "not installed" error at launch instead of a crash.
function resolveBin(name, fallback = null) {
  try {
    const cands = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name])
      .toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return cands.find(c => /\.exe$/i.test(c)) || cands.find(c => /\.(cmd|bat)$/i.test(c)) || cands[0] || fallback;
  } catch { return fallback; }
}

// ssh drives agents on remote hosts over clean pipes (no PTY). Resolve once.
const SSH = resolveBin('ssh', 'ssh');
// Keepalives: a dropped link (sleep, wifi change, VPN flap) surfaces as process exit within
// ~60s (15s * 4) instead of the session hanging 'busy' forever on a dead TCP connection.
const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4'];

const shq = s => "'" + String(s).replace(/'/g, "'\\''") + "'";

// Argv hardening, shared by every agent: a model or session/thread id must be a bare token with
// no leading '-' so a crafted value can't smuggle an extra CLI flag into a spawn. A host must
// look like an ssh alias or user@host and must NOT start with '-' (ssh would parse a leading-dash
// value as an option, e.g. -oProxyCommand=… => RCE). Only these permission modes may be requested
// via corral (bypassPermissions and dontAsk are never allowed); each adapter maps them onto its
// agent's native policy knobs.
const SAFE_ARG = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SAFE_HOST = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*(@[A-Za-z0-9_.-]+)?$/;
const PERM_MODES = new Set(['auto', 'default', 'plan', 'acceptEdits']);

// Incremental JSONL splitter: returns a feed(chunk) that buffers partial lines and calls onLine
// once per complete non-blank line. One closure per spawned process (state resets naturally).
function lineSplitter(onLine) {
  let buf = '';
  return d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (line.trim()) onLine(line);
    }
  };
}

module.exports = { resolveBin, SSH, SSH_OPTS, shq, SAFE_ARG, SAFE_HOST, PERM_MODES, lineSplitter };
