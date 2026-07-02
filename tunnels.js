// tunnels.js — manage `ssh -L` port forwards: localhost:localPort -> host:(remoteHost:remotePort).
// Forwards bind 127.0.0.1 only (never expose to the LAN). Orphaned ssh children from a previous
// run are reaped on boot from a tunnels.json PID-file (image-checked to dodge PID reuse).
const { spawn, execFileSync } = require('child_process');
const net = require('net');
const nodeHttp = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SSH = (() => {
  try { return execFileSync(process.platform === 'win32' ? 'where' : 'which', ['ssh']).toString().split(/\r?\n/).map(s => s.trim()).filter(Boolean)[0] || 'ssh'; }
  catch { return 'ssh'; }
})();
const PIDFILE = path.join(__dirname, 'tunnels.json');
const tunnels = new Map();

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

// Pure (testable): the ssh argv for a loopback-bound forward.
function buildForwardArgs({ host, remoteHost = '127.0.0.1', remotePort, localPort }) {
  return ['-N', '-o', 'BatchMode=yes', '-o', 'ExitOnForwardFailure=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-L', '127.0.0.1:' + localPort + ':' + remoteHost + ':' + remotePort, host];
}

// Tunnel-change hook: the /events push channel subscribes here.
let onChangeCb = null;
function onChange(cb) { onChangeCb = cb; }
const changed = () => { if (onChangeCb) try { onChangeCb(); } catch (e) {} };

// tunnels.json is the desired state: the full forward config (so the next run can re-establish
// each tunnel) plus the live ssh pid (so a crashed run's orphans can be reaped on boot).
function persist() {
  try { fs.writeFileSync(PIDFILE, JSON.stringify([...tunnels.values()].map(t => ({ pid: t.pid, host: t.host, localPort: t.localPort, remoteHost: t.remoteHost, remotePort: t.remotePort, http: !!t.http })))); } catch (e) {}
  changed();
}

function initialServiceStatus(t = {}) {
  if (!t.http) return 'not-checked';
  if (t.status !== 'up') return 'not-checked';
  return t.serviceStatus || 'probing';
}

function list() {
  return [...tunnels.values()].map(t => ({
    id: t.id,
    host: t.host,
    localPort: t.localPort,
    remoteHost: t.remoteHost,
    remotePort: t.remotePort,
    status: t.status,
    error: t.error,
    http: t.http,
    serviceStatus: initialServiceStatus(t),
    serviceError: t.serviceError || null,
    serviceStatusCode: t.serviceStatusCode || null,
    lastProbeAt: t.lastProbeAt || null,
  }));
}

function probeHttpService(localPort, { timeoutMs = 1200 } = {}) {
  return new Promise((resolve) => {
    const req = nodeHttp.request({
      host: '127.0.0.1',
      port: localPort,
      path: '/',
      method: 'GET',
      timeout: timeoutMs,
    }, (res) => {
      res.resume();
      resolve({ ok: true, statusCode: res.statusCode || 0 });
    });
    req.on('timeout', () => req.destroy(new Error('service probe timed out')));
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
    req.end();
  });
}

function clearProbe(t) {
  if (t && t.probeTimer) {
    clearTimeout(t.probeTimer);
    t.probeTimer = null;
  }
}

async function refreshServiceProbe(t) {
  if (!t || !t.http || t.status !== 'up' || !tunnels.has(t.id)) return;
  t.serviceStatus = 'probing';
  t.serviceError = null;
  t.serviceStatusCode = null;
  const result = await probeHttpService(t.localPort);
  if (!tunnels.has(t.id) || t.status !== 'up') return;
  t.lastProbeAt = Date.now();
  if (result.ok) {
    t.serviceStatus = 'reachable';
    t.serviceStatusCode = result.statusCode;
    t.serviceError = null;
  } else {
    t.serviceStatus = 'service-down';
    t.serviceStatusCode = null;
    t.serviceError = result.error || 'HTTP service did not answer';
  }
  persist();
}

function scheduleServiceProbe(t, delay = 0) {
  if (!t || !t.http) return;
  clearProbe(t);
  const tick = async () => {
    await refreshServiceProbe(t);
    if (tunnels.has(t.id) && t.status === 'up') {
      t.probeTimer = setTimeout(tick, 5000);
      t.probeTimer.unref?.();
    }
  };
  t.probeTimer = setTimeout(tick, delay);
  t.probeTimer.unref?.();
}

async function add({ host, remoteHost = '127.0.0.1', remotePort, localPort, http = false }) {
  const rp = parseInt(remotePort, 10);
  if (!Number.isInteger(rp) || rp < 1 || rp > 65535) throw new Error('bad remote port');
  if (!/^[A-Za-z0-9._-]+$/.test(String(remoteHost))) throw new Error('bad remote host');
  let lp = parseInt(localPort, 10);
  if (!Number.isInteger(lp) || lp < 1 || lp > 65535) lp = await freePort();
  const id = crypto.randomUUID();
  const proc = spawn(SSH, buildForwardArgs({ host, remoteHost, remotePort: rp, localPort: lp }), { windowsHide: true });
  const t = { id, host, localPort: lp, remoteHost, remotePort: rp, status: 'starting', error: null, http: !!http, serviceStatus: 'not-checked', serviceError: null, serviceStatusCode: null, lastProbeAt: null, proc, pid: proc.pid };
  tunnels.set(id, t);
  let err = '';
  proc.stderr.on('data', d => { err += String(d); });
  proc.on('error', e => { clearProbe(t); t.status = 'error'; t.error = e.message; changed(); });
  proc.on('exit', code => { clearProbe(t); if (t.status !== 'stopping') { t.status = 'error'; t.error = (err.trim().split('\n').pop() || ('ssh exited ' + code)); } persist(); });
  setTimeout(() => {
    if (tunnels.has(id) && t.status === 'starting') {
      t.status = 'up';
      t.serviceStatus = initialServiceStatus(t);
      scheduleServiceProbe(t);
      persist();
    }
  }, 1300); // grace: alive after ~1.3s => tunnel is open; HTTP service health is probed separately
  persist();
  return t;
}

function killProc(t) {
  t.status = 'stopping';
  clearProbe(t);
  try {
    if (process.platform === 'win32' && t.pid) spawn('taskkill', ['/PID', String(t.pid), '/T', '/F'], { windowsHide: true });
    else if (t.proc) t.proc.kill();
  } catch (e) {}
}
function remove(id) { const t = tunnels.get(id); if (!t) return false; killProc(t); tunnels.delete(id); persist(); return true; }
function killAll() { for (const t of tunnels.values()) killProc(t); }

// Identity check before any orphan kill (PID reuse must never hit a stranger): the process at
// that pid has to actually be ssh — tasklist image name on Windows, `ps -o comm=` elsewhere.
function isSsh(pid) {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('tasklist', ['/FI', 'PID eq ' + pid, '/NH'], { windowsHide: true }).toString()
      : execFileSync('ps', ['-o', 'comm=', '-p', String(pid)]).toString();
    return /\bssh(\.exe)?\b/i.test(out);
  } catch { return false; }
}
// Pure (testable): parse a tunnels.json of either vintage. Legacy entries ({pid,localPort,host})
// can only be reaped; current entries carry the full forward config so they can be restored.
function parsePersistedTunnels(raw) {
  let prev; try { prev = JSON.parse(raw); } catch (e) { return { pids: [], configs: [] }; }
  if (!Array.isArray(prev)) return { pids: [], configs: [] };
  const pids = prev.filter(o => o && Number.isInteger(o.pid)).map(o => o.pid);
  const configs = prev.filter(o => o && o.host && o.remotePort)
    .map(o => ({ host: o.host, remoteHost: o.remoteHost || '127.0.0.1', remotePort: o.remotePort, localPort: o.localPort, http: !!o.http }));
  return { pids, configs };
}
function reapOrphans() {
  let raw = '[]';
  try { raw = fs.readFileSync(PIDFILE, 'utf8'); } catch (e) {}
  const { pids, configs } = parsePersistedTunnels(raw);
  let reaped = 0;
  for (const pid of pids) {
    if (!isSsh(pid)) continue;                                              // image-check before kill (PID reuse)
    reaped += 1;
    try { if (process.platform === 'win32') spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }); else process.kill(pid); } catch (e) {}
  }
  try { fs.writeFileSync(PIDFILE, '[]'); } catch (e) {}
  return { configs, reaped };
}
// Boot: reap orphans, then re-establish the forwards that were up when the app last ran.
async function restorePersisted() {
  const { configs, reaped } = reapOrphans();
  if (!configs.length) return;
  if (reaped) await new Promise(r => setTimeout(r, 800));   // let killed orphans release their local ports
  for (const c of configs) { try { await add(c); } catch (e) {} }
}

module.exports = { add, remove, list, killAll, reapOrphans, restorePersisted, parsePersistedTunnels, onChange, buildForwardArgs, freePort, initialServiceStatus, probeHttpService };
