import { mount } from 'svelte';
import './tokens.css';
import './app.css';
import './prose.css';
import App from './App.svelte';
import { setToken } from './lib/api.js';

// In the packaged Tauri app the per-run auth token arrives in the URL fragment (#tk=…) that the
// Rust shell opens this page with — the loopback origin doesn't reliably get Tauri IPC, so we read
// it here rather than via invoke('get_token'). Scrub it from the address once captured. The invoke
// path stays as a fallback. In a plain browser (dev) there's no token and the backend is permissive.
async function boot() {
  const m = location.hash.match(/[#&]tk=([a-f0-9]+)/i);
  if (m) {
    setToken(m[1]);
    history.replaceState(null, '', location.pathname + location.search);
  } else if (window.__TAURI_INTERNALS__) {
    try { const { invoke } = await import('@tauri-apps/api/core'); setToken(await invoke('get_token')); } catch (e) {}
  }
  mount(App, { target: document.getElementById('app') });
}
boot();
