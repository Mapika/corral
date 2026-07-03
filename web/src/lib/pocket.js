// Pocket mode ("Run on this phone"): the Android app boots the bundled backend on-device and the
// console talks to it over loopback. Availability is a runtime probe into the shell — only
// pocket-flavor APKs carry the runtime, the slim build answers false and the UI stays pairing-only.
// The per-run token is NEVER persisted (it rotates with every backend spawn); only a flag
// survives restarts, and boot re-invokes pocket_start for fresh credentials.
import { setServer, setToken } from './api.js';
import { requestJson } from './apiRequest.mjs';

export const POCKET_KEY = 'corral-pocket';

async function invoke(cmd) {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke(cmd);
}

export async function pocketAvailable() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return false;
  try { return !!(await invoke('pocket_available')); } catch (e) { return false; }
}

// Boot (or attach to) the on-device backend and point the client at it. Verifies the API answers
// this run's token before wiring anything, so a half-started backend never strands the console.
export async function startPocket() {
  const { port, token } = await invoke('pocket_start');
  const base = 'http://127.0.0.1:' + port;
  await requestJson(base + '/api/chat/list', { headers: { Authorization: 'Bearer ' + token }, retries: 3 });
  setServer(base); setToken(token);
  try { localStorage.setItem(POCKET_KEY, '1'); } catch (e) {}
  return { base, token };
}

export function pocketEnabled() {
  try { return localStorage.getItem(POCKET_KEY) === '1'; } catch (e) { return false; }
}

export function clearPocket() {
  try { localStorage.removeItem(POCKET_KEY); } catch (e) {}
}

export async function stopPocket() {
  try { await invoke('pocket_stop'); } catch (e) {}
}
