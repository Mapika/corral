<script>
  // Phone pairing: flip on the LAN listener, show the pair QR. The QR encodes
  // http://<lan-ip>:<port>/#tk=<durable-token> — scan it with the Corral app (or any camera:
  // the same link opens the console in the phone's browser, already authenticated).
  import QRCode from 'qrcode';
  import { getRemoteConfig, setRemoteConfig } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';
  import { buildPairUrl } from './lib/serverBase.mjs';
  import { writeClipboardText } from './lib/clipboardAction.mjs';

  let { onclose } = $props();

  let cfg = $state(null);        // { enabled, port, tls, running, error, addresses, token, certPath, keyPath }
  let address = $state('');
  let qr = $state('');
  let error = $state('');
  let note = $state('');
  let busy = $state(false);
  let tlsOpen = $state(false);
  let certDraft = $state('');
  let keyDraft = $state('');

  let pairUrl = $derived(cfg?.enabled && cfg?.token && address ? buildPairUrl(address, cfg.port, cfg.token, { tls: !!cfg.tls }) : '');

  async function load() {
    try {
      cfg = await getRemoteConfig();
      if (!address || !(cfg.addresses || []).includes(address)) address = (cfg.addresses || [])[0] || '';
      certDraft = cfg.certPath || ''; keyDraft = cfg.keyPath || '';
    } catch (e) { error = apiErrorMessage(e, 'Could not load remote settings.'); }
  }
  async function saveTls() {
    busy = true; error = '';
    try {
      cfg = await setRemoteConfig({ certPath: certDraft.trim(), keyPath: keyDraft.trim() });
      certDraft = cfg.certPath || ''; keyDraft = cfg.keyPath || '';
      note = cfg.tls ? 'serving https — re-scan on every phone' : 'back to plain http';
      setTimeout(() => (note = ''), 3200);
    } catch (e) { error = apiErrorMessage(e, 'Could not update TLS settings.'); }
    finally { busy = false; }
  }
  async function toggle(enabled) {
    busy = true; error = '';
    try {
      cfg = await setRemoteConfig({ enabled });
      if (!address || !(cfg.addresses || []).includes(address)) address = (cfg.addresses || [])[0] || '';
    } catch (e) { error = apiErrorMessage(e, 'Could not update remote access.'); }
    finally { busy = false; }
  }
  async function rotate() {
    busy = true; error = '';
    try {
      cfg = await setRemoteConfig({ rotate: true });
      note = 'new code — every phone must re-pair'; setTimeout(() => (note = ''), 3200);
    } catch (e) { error = apiErrorMessage(e, 'Could not rotate the pairing code.'); }
    finally { busy = false; }
  }
  async function copyLink() {
    const r = await writeClipboardText(pairUrl);
    note = r.ok ? 'link copied' : 'copy failed';
    setTimeout(() => (note = ''), 1800);
  }

  $effect(() => { load(); });
  $effect(() => {
    const url = pairUrl;
    if (!url) { qr = ''; return; }
    QRCode.toDataURL(url, { margin: 2, width: 240, color: { dark: '#000000', light: '#ffffff' } })
      .then((d) => (qr = d))
      .catch(() => (qr = ''));
  });

  const onKey = (e) => { if (e.key === 'Escape') onclose?.(); };
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }} role="presentation">
  <div class="panel" role="dialog" aria-label="Phone pairing">
    <header>
      <span class="title">Ranch from your phone</span>
      <span class="sub">remote access</span>
    </header>

    {#if cfg}
      <div class="body">
        <p class="hint">
          Opens a second door to this backend on your local network (port {cfg.port}) with its own
          durable pairing code. Scan the QR with the <b>Corral</b> app — or with the camera, which
          opens the console in the phone's browser. Trusted networks only (home Wi-Fi, tailnet);
          the link never leaves this machine.
        </p>

        <label class="row check">
          <input type="checkbox" checked={cfg.enabled} disabled={busy} onchange={(e) => toggle(e.currentTarget.checked)} />
          <span>Enabled</span>
        </label>

        {#if cfg.enabled && cfg.error}
          <div class="err" role="alert">listener: {cfg.error}</div>
        {/if}

        {#if cfg.enabled && (cfg.addresses || []).length > 1}
          <div class="row">
            <span class="olabel">Network</span>
            <div class="addrs">
              {#each cfg.addresses as a (a)}
                <button class="addr" class:on={address === a} onclick={() => (address = a)}>{a}</button>
              {/each}
            </div>
          </div>
        {/if}

        {#if cfg.enabled && qr}
          <div class="qrwrap">
            <img class="qr" src={qr} alt="Pair QR code" width="240" height="240" />
            <div class="qrside">
              <code class="link">{pairUrl}</code>
              <div class="qractions">
                <button class="ghost" onclick={copyLink}>Copy link</button>
                <button class="ghost" onclick={rotate} disabled={busy}>New code</button>
              </div>
            </div>
          </div>
        {:else if cfg.enabled && !(cfg.addresses || []).length}
          <div class="err">No private network address found on this machine.</div>
        {/if}

        {#if cfg.enabled}
          <div class="row tlsrow">
            <span class="olabel">Transport</span>
            <button class="ghost" onclick={() => (tlsOpen = !tlsOpen)}>{cfg.tls ? 'https (TLS)' : 'plain http'} — change</button>
          </div>
          {#if tlsOpen}
            <div class="tlsbox">
              <p class="hint">Point at a PEM pair the phone will trust — <code>tailscale cert</code> output
                is the easy path on a tailnet. Clear both fields to go back to plain http.</p>
              <div class="row">
                <span class="olabel">Cert</span>
                <input class="field" bind:value={certDraft} spellcheck="false" autocomplete="off" placeholder="C:\path\to\machine.crt" />
              </div>
              <div class="row">
                <span class="olabel">Key</span>
                <input class="field" bind:value={keyDraft} spellcheck="false" autocomplete="off" placeholder="C:\path\to\machine.key" />
              </div>
              <div class="row"><span class="olabel"></span><button class="ghost" onclick={saveTls} disabled={busy}>Apply</button></div>
            </div>
          {/if}
        {/if}

        {#if error}<div class="err" role="alert">{error}</div>{/if}
        {#if note}<div class="note">{note}</div>{/if}
      </div>

      <footer>
        <span class="foot">the pairing code stays valid across restarts</span>
        <span class="sp"></span>
        <button class="primary" onclick={() => onclose?.()}>Done</button>
      </footer>
    {:else if error}
      <div class="body"><div class="err" role="alert">{error}</div></div>
    {:else}
      <div class="body"><div class="hint">loading…</div></div>
    {/if}
  </div>
</div>

<style>
  .backdrop { position: fixed; inset: 0; z-index: 50; background: rgba(0,0,0,.55); display: grid; place-items: center; padding: clamp(12px, 4vw, 40px); overflow: auto; animation: fade .14s ease; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
  .panel { width: min(560px, calc(100vw - 24px)); display: flex; flex-direction: column; background: var(--surface); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
  header { display: flex; align-items: baseline; gap: 11px; padding: var(--s4) var(--s4) var(--s3); }
  .title { font-size: 19px; font-weight: var(--w-light); color: var(--text); }
  .sub { font: 12px var(--mono); color: var(--text-dim); }
  .body { display: grid; gap: var(--s3); padding: 0 var(--s4) var(--s3); }
  .hint { margin: 0; color: var(--text-dim); font-size: 12.5px; line-height: 1.55; }
  .hint b { color: var(--text); font-weight: var(--w-med); }
  .row { display: flex; align-items: center; gap: 10px; }
  .olabel { flex: none; width: 74px; color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .check { display: inline-flex; align-items: center; gap: 9px; color: var(--text-dim); font-size: 12.5px; cursor: pointer; }
  .check input { accent-color: var(--text-dim); }
  .addrs { display: flex; flex-wrap: wrap; gap: 7px; }
  .addr { background: var(--chip); border: 0; border-radius: var(--pill); color: var(--text-dim); padding: 6px 13px; font: 11.5px var(--mono); cursor: pointer; }
  .addr.on { background: var(--paper); color: var(--ink); }

  /* the QR sits in a paper-white frame — the one bright block in the dark console */
  .qrwrap { display: flex; gap: var(--s3); align-items: stretch; }
  .qr { flex: none; display: block; background: #fff; padding: 0; width: 176px; height: 176px; }
  .qrside { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 10px; justify-content: center; }
  .link { font: 11px/1.5 var(--mono); color: var(--text-dim); overflow-wrap: anywhere; }
  .qractions { display: flex; gap: 12px; }

  .err { color: var(--alert); font-size: 12px; }
  .note { color: var(--text-dim); font: 11.5px var(--mono); }
  .field { flex: 1; min-width: 0; background: var(--chip); border: 0; color: var(--text); padding: 0 12px; height: 34px; font: 12px/1 var(--mono); }
  .field:focus { outline: 0; background: var(--chip-hi); }
  .tlsbox { display: grid; gap: 10px; padding: 12px 0 2px; border-top: 1px solid var(--seam); }
  .tlsbox .hint code { font: 11px var(--mono); color: var(--text); }
  footer { display: flex; align-items: center; gap: 9px; padding: var(--s3) var(--s4) var(--s4); border-top: 1px solid var(--seam); }
  .foot { color: var(--text-faint); font-size: 11px; }
  .sp { flex: 1; }
  .ghost { background: none; border: 0; color: var(--text-dim); padding: 8px 4px; cursor: pointer; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; transition: color .12s; }
  .ghost:hover { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .ghost:disabled { opacity: .5; cursor: default; }
  .primary { background: var(--paper); border: 0; color: var(--ink); border-radius: var(--pill); padding: 9px 19px; cursor: pointer; font: var(--w-med) 12px var(--sans); }
</style>
