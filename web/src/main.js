import { mount } from 'svelte';
import './tokens.css';
import './app.css';
import './prose.css';
import Root from './Root.svelte';
import { setServer, setToken } from './lib/api.js';
import { pocketEnabled, startPocket } from './lib/pocket.js';
import { isLoopbackPage, isStandaloneShell, normalizeBase, SERVER_KEY, TOKEN_KEY } from './lib/serverBase.mjs';

// Where the auth comes from, by how this page is running:
//  - Desktop shell / pair link: the token arrives in the URL fragment (#tk=…) — read + scrub it.
//    A phone browser (non-loopback page) also persists it so the installed page survives reloads.
//  - Standalone shell (the mobile app; pages ship in the bundle, no same-origin backend): the
//    paired server origin + durable token come from storage; if absent, Root shows Connect.
//  - Plain dev browser: no token, backend is permissive.
async function boot() {
  const standalone = isStandaloneShell();
  const loopback = isLoopbackPage();
  const m = location.hash.match(/[#&]tk=([a-f0-9]+)/i);
  let paired = false;
  let pocketError = '';
  if (m) {
    setToken(m[1]);
    if (!loopback && !standalone) { try { localStorage.setItem(TOKEN_KEY, m[1]); } catch (e) {} }
    history.replaceState(null, '', location.pathname + location.search);
  } else if (standalone) {
    // Pocket mode first: the on-device backend's token is per-run, so it's re-minted here every
    // launch (never read from storage). The start can take seconds (payload extract + listen
    // wait) — say so instead of showing a blank page; a failure lands on Connect WITH the reason
    // and the "Run on this phone" button as the retry.
    if (pocketEnabled()) {
      bootStatus('Starting on this phone…');
      try { await startPocket(); paired = true; } catch (e) {
        pocketError = 'The on-device backend did not start' + (e?.message ? ' — ' + e.message : '.');
      }
      bootStatus('');
    }
    if (!paired) {
      let base = '', token = '';
      try { base = normalizeBase(localStorage.getItem(SERVER_KEY)); token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
      if (base && token) { setServer(base); setToken(token); paired = true; }
    }
  } else if (!loopback) {
    let token = '';
    try { token = localStorage.getItem(TOKEN_KEY) || ''; } catch (e) {}
    if (token) setToken(token);
  } else if (window.__TAURI_INTERNALS__) {
    try { const { invoke } = await import('@tauri-apps/api/core'); setToken(await invoke('get_token')); } catch (e) {}
  }
  mount(Root, { target: document.getElementById('app'), props: { standalone, paired, pocketError } });

  // Offline shell for browser pages (the mobile shell ships its own bundle, dev wants fresh
  // modules). serviceWorker only exists in secure contexts, so plain-http LAN pairing opts out
  // by itself; the TLS-paired phone and the desktop's loopback page get cache + last-herd offline.
  if (import.meta.env.PROD && !standalone && 'serviceWorker' in navigator) {
    try { navigator.serviceWorker.register('/sw.js'); } catch (e) {}
  }
}
// Pre-mount status line (Svelte isn't up yet while the pocket backend boots). Cleared before
// mount — Svelte 5 mount() appends to the target rather than replacing its contents.
function bootStatus(msg) {
  const el = document.getElementById('app');
  if (!el) return;
  el.innerHTML = msg
    ? '<div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;color:var(--text-dim,#888);font-size:13.5px">' + msg + '</div>'
    : '';
}
boot();
