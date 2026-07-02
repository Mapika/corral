import { requestJson, requestMutation, requestText } from './apiRequest.mjs';
import { wsUrl } from './serverBase.mjs';

// Tiny backend client. Token auth is a no-op in dev; the Tauri shell will inject one later via setToken().
let TOKEN = '';
export function setToken(t) { TOKEN = t || ''; }
// Backend origin. '' = same origin (the usual case); a standalone client (mobile app) points this
// at a paired corral server, e.g. 'http://192.168.0.24:7879'.
let BASE = '';
export function setServer(base) { BASE = base || ''; }
export function getServer() { return BASE; }
const abs = (path) => BASE + path;
const headers = () => (TOKEN ? { Authorization: 'Bearer ' + TOKEN } : {});
const json = (path, opts = {}) => requestJson(abs(path), { ...opts, getHeaders: headers });
const mutate = (path, opts = {}) => requestMutation(abs(path), { ...opts, getHeaders: headers });

export async function listSessions() {
  return json('/api/chat/list');
}

export async function listHosts() {
  return json('/api/hosts');
}

export async function listServerStatus() {
  return json('/api/servers', { retries: 0 });
}

export async function launchSession({ host = 'local', dir = '', model, perm, agent, worktree, prompt } = {}) {
  const q = new URLSearchParams({ host });
  if (dir) q.set('dir', dir);
  if (model) q.set('model', model);
  if (perm) q.set('perm', perm);
  if (agent) q.set('agent', agent);
  if (worktree) q.set('worktree', '1');
  if (prompt) q.set('prompt', prompt);
  return json('/api/chat/launch?' + q.toString(), { method: 'POST', retries: 0 });
}

export async function searchHistory(q, limit = 20) {
  return json('/api/history/search?q=' + encodeURIComponent(q) + '&limit=' + limit, { retries: 0 });
}

export async function setSessionLabel(id, label) {
  return mutate('/api/chat/label?id=' + encodeURIComponent(id) + '&label=' + encodeURIComponent(label || ''), { method: 'POST' });
}

export async function killSession(id) {
  return mutate('/api/chat/kill?id=' + encodeURIComponent(id), { method: 'POST' });
}

export async function interruptSession(id) {
  return mutate('/api/chat/interrupt?id=' + encodeURIComponent(id), { method: 'POST' });
}

export async function removeSession(id) {
  return mutate('/api/chat/remove?id=' + encodeURIComponent(id), { method: 'POST' });
}

export async function resumeSession(id) {
  return json('/api/chat/resume?id=' + encodeURIComponent(id), { method: 'POST', retries: 0 });
}

// One-tap answer to a roster-surfaced permission prompt (session.pendingPerm.id).
export async function respondPermission(id, requestId, decision) {
  const q = new URLSearchParams({ id, requestId, decision });
  return json('/api/chat/permission?' + q.toString(), { method: 'POST', retries: 0 });
}

// --- files ---
export async function lsDir(host, p) {
  return json('/api/ls?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p));
}
// <img>/<iframe>/<a> can't set an Authorization header, so GET file/download URLs carry the token
// as a ?tk= param (loopback, single-user — acceptable). No-op in dev (no token).
export function fileUrl(host, p, opts = {}) {
  let u = abs('/api/file?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p));
  if (opts.dl) u += '&dl=1';
  if (TOKEN) u += '&tk=' + encodeURIComponent(TOKEN);
  return u;
}
export function dirDownloadUrl(host, p) {
  let u = abs('/api/download-dir?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p));
  if (TOKEN) u += '&tk=' + encodeURIComponent(TOKEN);
  return u;
}
export async function fileText(host, p) {
  return requestText(fileUrl(host, p), { getHeaders: headers, retries: 0 });
}
// mkdir / rename / delete. `p` is the parent dir for mkdir, the item path for rename/delete.
async function fileop(host, op, p, name) {
  const q = new URLSearchParams({ server: host, op, path: p });
  if (name) q.set('name', name);
  return json('/api/fileop?' + q.toString(), { method: 'POST', retries: 0 });
}
export const mkdir = (host, dir, name) => fileop(host, 'mkdir', dir, name);
export const renameItem = (host, p, name) => fileop(host, 'rename', p, name);
export const deleteItem = (host, p) => fileop(host, 'delete', p);

// git diff of a session/dir — { isRepo, diff, untracked[] }
export async function gitDiff(host, p) {
  return json('/api/git/diff?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(p), { fallback: { isRepo: false, diff: '', untracked: [] } });
}

export function uploadFile(host, dir, file, onProgress, name) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', abs('/api/upload?server=' + encodeURIComponent(host) + '&path=' + encodeURIComponent(dir) + '&name=' + encodeURIComponent(name || file.name)));
    if (TOKEN) xhr.setRequestHeader('Authorization', 'Bearer ' + TOKEN);
    xhr.upload.onprogress = (e) => { if (onProgress && e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch (x) { resolve({ ok: xhr.status < 300 }); } };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}

export function chatSocket(id) {
  const ws = new WebSocket(wsUrl(BASE, '/chat?id=' + encodeURIComponent(id)));
  if (TOKEN) ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })));
  return ws;
}

// /events push socket: the server streams {type:'sessions'|'tunnels'} snapshots on change, so the
// app can stand down its polling while connected. Same first-frame auth as chatSocket.
export function eventsSocket() {
  const ws = new WebSocket(wsUrl(BASE, '/events'));
  if (TOKEN) ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })));
  return ws;
}

// /ws terminal bridge: local shell, plain ssh, or tmux attach. Raw PTY output arrives as text
// frames; input goes as {type:'data'}, size changes as {type:'resize'}. Same first-frame auth.
export function termSocket({ host = 'local', target = '', cwd = '', cols = 80, rows = 24 } = {}) {
  const q = new URLSearchParams({ server: host, cols: String(cols), rows: String(rows) });
  if (target) q.set('target', target);
  if (cwd) q.set('cwd', cwd);
  const ws = new WebSocket(wsUrl(BASE, '/ws?' + q.toString()));
  if (TOKEN) ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })));
  return ws;
}

// --- remote access (phone pairing) — loopback/desktop only; the server hides secrets otherwise ---
export async function getRemoteConfig() { return json('/api/remote'); }
export async function setRemoteConfig({ enabled, rotate, certPath, keyPath } = {}) {
  const q = new URLSearchParams();
  if (enabled != null) q.set('enabled', enabled ? '1' : '0');
  if (rotate) q.set('rotate', '1');
  if (certPath != null) q.set('certPath', certPath);
  if (keyPath != null) q.set('keyPath', keyPath);
  return json('/api/remote?' + q.toString(), { method: 'POST', retries: 0 });
}

// --- phone push (ntfy relay) ---
export async function getPushConfig() { return json('/api/push'); }
export async function setPushConfig({ enabled, actions, server, topic, input, done, fail } = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of [['enabled', enabled], ['actions', actions], ['input', input], ['done', done], ['fail', fail]]) if (v != null) q.set(k, v ? '1' : '0');
  if (server != null) q.set('server', server);
  if (topic != null) q.set('topic', topic);
  return json('/api/push?' + q.toString(), { method: 'POST', retries: 0 });
}
export async function testPush() { return json('/api/push/test', { method: 'POST', retries: 0 }); }

// --- tunnels ---
export async function listTunnels() { return json('/api/tunnels'); }
export async function addTunnel(host, opts) {
  const q = new URLSearchParams({ server: host, remotePort: String(opts.remotePort) });
  if (opts.localPort) q.set('localPort', String(opts.localPort));
  if (opts.remoteHost) q.set('remoteHost', opts.remoteHost);
  if (opts.http) q.set('http', '1');
  return json('/api/tunnels?' + q.toString(), { method: 'POST', retries: 0 });
}
export async function removeTunnel(id) { return mutate('/api/tunnels?id=' + encodeURIComponent(id), { method: 'DELETE' }); }
