// Pocket mode ("Run on this phone"): the Android app boots the bundled backend on-device and the
// console talks to it over loopback. Availability is a runtime probe into the shell — only
// pocket-flavor APKs carry the runtime, the slim build answers false and the UI stays pairing-only.
// The token is never persisted on the JS side (only a flag survives restarts; boot re-invokes
// pocket_start for credentials) — the Rust side keeps a run.json in app-private storage so a
// backend that outlived the app process can be re-adopted with its sessions intact.
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

// Whether Claude credentials exist in the pocket HOME (null = shell unavailable / unknown).
export async function pocketLoggedIn() {
  if (typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return null;
  try { return !!(await invoke('pocket_logged_in')); } catch (e) { return null; }
}

// Boot (or attach to) the on-device backend and point the client at it. Verifies the API answers
// this run's token before wiring anything, so a half-started backend never strands the console.
export async function startPocket() {
  const { port, token } = await invoke('pocket_start');
  const base = 'http://127.0.0.1:' + port;
  await requestJson(base + '/api/chat/list', { headers: { Authorization: 'Bearer ' + token }, retries: 3 });
  setServer(base); setToken(token);
  try { localStorage.setItem(POCKET_KEY, '1'); } catch (e) {}
  watchPocket();
  return { base, token };
}

// The Rust watchdog restarts a crashed backend and emits pocket-state — running:false while it's
// down, then running:true with the NEW port/token. Rewiring here means the data layer's next
// socket-reconnect attempt lands on the live backend instead of hammering the dead port forever.
let watching = false;
const stateListeners = new Set();
export function onPocketState(fn) { stateListeners.add(fn); return () => stateListeners.delete(fn); }
async function watchPocket() {
  if (watching || typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
  watching = true;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    await listen('pocket-state', (e) => {
      const p = e.payload || {};
      if (p.running && p.port) { setServer('http://127.0.0.1:' + p.port); setToken(p.token); }
      for (const fn of stateListeners) { try { fn(p); } catch (err) {} }
    });
  } catch (e) { watching = false; }
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
