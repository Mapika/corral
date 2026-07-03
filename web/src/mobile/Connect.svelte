<script>
  // Pairing screen for the standalone app: scan the QR the desktop shows (camera + BarcodeDetector
  // where the webview offers them) or paste the pair link. Verifies against the server before
  // persisting, so a bad link never strands the app.
  import { setServer, setToken } from '../lib/api.js';
  import { requestJson } from '../lib/apiRequest.mjs';
  import { pocketAvailable, startPocket } from '../lib/pocket.js';
  import { parsePairInput, SERVER_KEY, TOKEN_KEY } from '../lib/serverBase.mjs';

  let { onPaired, initialError = '' } = $props();

  let input = $state('');
  let busy = $state(false);
  // Seeded with the cold-boot failure (main.js): the operator lands here knowing WHY the phone
  // backend didn't come up, with "Run on this phone" as the retry.
  let error = $state(initialError);
  let scanning = $state(false);
  let videoEl = $state(null);
  let stream = null, scanTimer = null;

  const canScan = typeof BarcodeDetector !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;

  // Pocket builds carry an on-device runtime — offer "Run on this phone" above pairing.
  let pocketOk = $state(false);
  $effect(() => { pocketAvailable().then((ok) => (pocketOk = ok)); });

  async function runLocal() {
    busy = true; error = '';
    try {
      await startPocket();
      // Best-effort: the foreground service's notification needs POST_NOTIFICATIONS on 13+.
      try {
        const { isPermissionGranted, requestPermission } = await import('@tauri-apps/plugin-notification');
        if (!(await isPermissionGranted())) await requestPermission();
      } catch (e) {}
      onPaired?.();
    } catch (e) {
      error = 'Could not start the on-device backend' + (e?.message ? ' — ' + e.message : '.');
    } finally {
      busy = false;
    }
  }

  async function connect(text) {
    const { base, token } = parsePairInput(text);
    if (!base) { error = 'Paste the pair link from the desktop app.'; return; }
    if (!token) { error = 'That link is missing its pairing code — copy the full link (…#tk=…).'; return; }
    busy = true; error = '';
    try {
      await requestJson(base + '/api/chat/list', { headers: { Authorization: 'Bearer ' + token }, retries: 1 });
      try { localStorage.setItem(SERVER_KEY, base); localStorage.setItem(TOKEN_KEY, token); } catch (e) {}
      setServer(base); setToken(token);
      onPaired?.();
    } catch (e) {
      error = e?.status === 401 || e?.status === 403
        ? 'The server refused this pairing code. Open the QR on the desktop again and rescan.'
        : 'Could not reach ' + base + ' — is the phone on the same network (or tailnet) and remote access enabled?';
    } finally {
      busy = false;
    }
  }

  async function startScan() {
    error = '';
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      scanning = true;
      queueMicrotask(async () => {
        if (!videoEl) return;
        videoEl.srcObject = stream;
        await videoEl.play().catch(() => {});
        const detector = new BarcodeDetector({ formats: ['qr_code'] });
        const tick = async () => {
          if (!scanning || !videoEl) return;
          try {
            const codes = await detector.detect(videoEl);
            if (codes.length) {
              const raw = codes[0].rawValue || '';
              stopScan();
              await connect(raw);
              return;
            }
          } catch (e) {}
          scanTimer = setTimeout(tick, 250);
        };
        tick();
      });
    } catch (e) {
      scanning = false;
      error = 'Camera unavailable — paste the pair link instead.';
    }
  }
  function stopScan() {
    scanning = false;
    clearTimeout(scanTimer);
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
  }
  $effect(() => () => stopScan());
</script>

<div class="connect">
  <div class="hero">
    <span class="brand">corral</span>
    <b>Pair with your&nbsp;ranch.</b>
    <p>On the desktop app, open <span class="k">Phone</span> in the titlebar, enable remote access, and point the camera at the QR — or paste the pair link below.</p>
  </div>

  {#if scanning}
    <div class="cam">
      <!-- svelte-ignore a11y_media_has_caption -->
      <video bind:this={videoEl} playsinline muted></video>
      <button class="quiet" onclick={stopScan}>Cancel</button>
    </div>
  {:else}
    <div class="form">
      {#if pocketOk}
        <button class="scan" onclick={runLocal} disabled={busy}>{busy ? 'Starting…' : 'Run on this phone'}</button>
        <div class="or"><span>or</span></div>
      {/if}
      {#if canScan}
        <button class="scan" onclick={startScan}>Scan the QR</button>
        <div class="or"><span>or</span></div>
      {/if}
      <input bind:value={input} placeholder="http://192.168.1.20:7879/#tk=…"
             autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url"
             onkeydown={(e) => { if (e.key === 'Enter') connect(input); }} />
      <button class="go" onclick={() => connect(input)} disabled={busy}>{busy ? 'Connecting…' : 'Connect'}</button>
      {#if error}<p class="err">{error}</p>{/if}
    </div>
  {/if}
</div>

<style>
  .connect { min-height: 100dvh; display: flex; flex-direction: column; justify-content: center; gap: var(--s6); padding: var(--s6) var(--s5) calc(var(--s6) + env(safe-area-inset-bottom, 0px)); background: var(--bg); }
  .hero { display: flex; flex-direction: column; gap: 14px; }
  .brand { font-size: 11px; letter-spacing: .18em; text-transform: uppercase; color: var(--text-faint); }
  .hero b { color: var(--text); font-size: clamp(38px, 11vw, 54px); line-height: .98; font-weight: var(--w-light); }
  .hero p { margin: 4px 0 0; color: var(--text-dim); font-size: 13.5px; line-height: 1.55; max-width: 320px; }
  .hero .k { color: var(--text); }

  .form { display: flex; flex-direction: column; gap: 12px; }
  .scan { min-height: 52px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); font: var(--w-med) 15px var(--sans); cursor: pointer; }
  .or { display: flex; align-items: center; gap: 12px; color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .or::before, .or::after { content: ''; flex: 1; height: 1px; background: var(--seam); }
  input { width: 100%; background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: 16px var(--mono); padding: 14px; }
  input:focus { box-shadow: inset 0 0 0 1px var(--text-dim); }
  input::placeholder { color: var(--text-faint); }
  .go { min-height: 50px; background: var(--chip); color: var(--text); border: 0; border-radius: var(--pill); font: var(--w-med) 14px var(--sans); cursor: pointer; }
  .go:active { background: var(--chip-hi); }
  .go:disabled { opacity: .5; }
  .err { margin: 2px 0 0; color: var(--alert); font-size: 12.5px; line-height: 1.5; }

  .cam { display: flex; flex-direction: column; gap: 12px; }
  video { width: 100%; aspect-ratio: 3 / 4; object-fit: cover; background: var(--frame); }
  .quiet { min-height: 46px; background: var(--chip); color: var(--text-dim); border: 0; border-radius: var(--pill); font: 13px var(--sans); cursor: pointer; }
</style>
