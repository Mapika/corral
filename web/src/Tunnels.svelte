<script>
  import { listTunnels, addTunnel, removeTunnel } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';
  import { copyTunnelUrl, tunnelLocalUrl } from './lib/tunnelActions.mjs';
  import { parseTunnelForm, tunnelListState, tunnelStatusView } from './lib/tunnelStatus.mjs';
  import { openExternalUrl } from './lib/externalOpen.mjs';
  import { toast } from './lib/toast.svelte.js';
  import Icon from './lib/Icon.svelte';

  let { host } = $props();

  let all = $state([]);
  let remotePort = $state('');
  let localPort = $state('');
  let remoteHost = $state('127.0.0.1');
  let http = $state(true);
  let busy = $state(false);
  let err = $state('');
  let loadErr = $state('');
  let refreshing = $state(false);

  let mine = $derived(all.filter((t) => t.host === host));
  let listState = $derived(tunnelListState({ tunnels: mine, loadErr }));
  async function refresh() {
    refreshing = true; loadErr = '';
    try { all = await listTunnels(); }
    catch (e) { loadErr = apiErrorMessage(e, 'Could not load tunnels.'); }
    refreshing = false;
  }
  async function add() {
    err = '';
    const parsed = parseTunnelForm({ remoteHost, remotePort, localPort });
    if (!parsed.ok) { err = parsed.error; return; }
    busy = true;
    try {
      const r = await addTunnel(host, { remotePort: parsed.remotePort, localPort: parsed.localPort, remoteHost: parsed.remoteHost, http });
      if (!r || !r.ok) { err = (r && r.error) || 'failed'; return; }
      remotePort = ''; localPort = '';
      await refresh();
    } catch (e) {
      err = 'Forward failed: ' + apiErrorMessage(e, 'unknown');
    } finally {
      busy = false;
    }
  }
  async function drop(id) {
    err = '';
    try {
      await removeTunnel(id);
      await refresh();
    } catch (e) {
      err = 'Remove failed: ' + apiErrorMessage(e, 'unknown');
    }
  }
  function openHttp(t) {
    const result = openExternalUrl(tunnelLocalUrl(t));
    err = result.ok ? '' : 'Open failed: ' + (result.error || 'unknown');
  }
  async function copyHttp(t) {
    const result = await copyTunnelUrl(t, { toast });
    err = result.ok ? '' : 'Copy failed: ' + (result.error || 'unknown');
  }
  $effect(() => { refresh(); const t = setInterval(refresh, 2500); return () => clearInterval(t); });
</script>

<div class="view">
  <div class="wrap">
    <div class="phead">
      <span>Tunnels</span>
      <span class="phost">{host}</span>
      <button class="mini" onclick={refresh} disabled={refreshing}><Icon name="swap" size={13} /> refresh</button>
    </div>

    <div class="addbar">
      <label>remote port <input type="number" bind:value={remotePort} placeholder="e.g. 8080" /></label>
      <label>remote host <input bind:value={remoteHost} /></label>
      <label>local port <input type="number" bind:value={localPort} placeholder="auto" /></label>
      <label class="chk"><input type="checkbox" bind:checked={http} /> http</label>
      <button class="add" onclick={add} disabled={busy}>{busy ? 'Opening…' : 'Forward'}</button>
    </div>
    {#if err}<div class="err" role="alert">{err}</div>{/if}

    <div class="list">
      {#if listState.showError}
        <div class="loaderr" role="alert">
          <b>Could not load tunnels.</b>
          <span>{loadErr}</span>
          <button onclick={refresh}>Retry</button>
        </div>
      {/if}
      {#if listState.showEmpty}
        <div class="empty">No forwards on {host} yet.</div>
      {:else}
        <div class="rows">
          {#each mine as t (t.id)}
            {@const view = tunnelStatusView(t)}
            <div class="cell">
              <div class="trow">
                <span class="dot {view.tone}" title={view.detail}></span>
                <span class="route"><b>127.0.0.1:{t.localPort}</b><span class="arrow">→</span>{t.remoteHost}:{t.remotePort}</span>
                <span class="st">{view.label}</span>
                <span class="sp"></span>
                {#if t.http && view.canCopy}
                  <button class="act" onclick={() => copyHttp(t)}>Copy URL</button>
                {/if}
                {#if t.http && view.canOpen}
                  <button class="act" onclick={() => openHttp(t)}>Open</button>
                {/if}
                <button class="act danger" onclick={() => drop(t.id)}>Remove</button>
              </div>
              {#if view.tone === 'warn'}<div class="terr warn">{view.detail}</div>{/if}
              {#if t.status === 'error' && t.error}<div class="terr">{t.error}</div>{/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .view { position: absolute; inset: 0; overflow: auto; background: var(--bg); padding: var(--s5); }
  .wrap { max-width: 1060px; margin: 0 auto; }
  .phead { min-height: 46px; display: flex; align-items: center; gap: var(--s3); padding: 0 var(--s3); border-bottom: 1px solid var(--seam); color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .phost { font-family: var(--mono); font-size: 11px; letter-spacing: .01em; text-transform: none; color: var(--text-dim); }
  .phead .mini { margin-left: auto; }
  .mini { display: inline-flex; align-items: center; gap: 7px; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 8px 15px; cursor: pointer; font: var(--w-reg) 12px var(--sans); letter-spacing: 0; text-transform: none; transition: color .12s, background .12s, opacity .12s; }
  .mini:hover { color: var(--text); background: var(--chip-hi); }
  .mini:disabled { opacity: .45; pointer-events: none; }

  .addbar { display: flex; flex-wrap: wrap; align-items: end; gap: var(--s3); padding: var(--s4) var(--s3); }
  .addbar label { display: flex; flex-direction: column; gap: 7px; font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  /* sharp 0px inputs */
  .addbar input { width: 148px; background: var(--chip); border: 0; color: var(--text); padding: 10px 12px; font: 13px/1 var(--mono); transition: background .12s; }
  .addbar input::placeholder { color: var(--text-faint); }
  .addbar input:focus { outline: 0; background: var(--chip-hi); }
  .addbar .chk { flex-direction: row; align-items: center; gap: 7px; text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text-dim); }
  .addbar .chk input { width: auto; accent-color: var(--paper); }
  /* primary action — light pill */
  .add { background: var(--paper); color: var(--ink); font: var(--w-med) 13px var(--sans); border: 0; border-radius: var(--pill); padding: 10px 22px; cursor: pointer; transition: transform .14s, opacity .14s; }
  .add:hover { transform: translateY(-1px); }
  .add:disabled { opacity: .35; pointer-events: none; }
  .err { color: var(--text); padding: 12px var(--s3) 0; font-size: 13px; }

  .list { padding: var(--s1) 0; }
  .empty { color: var(--text-dim); padding: var(--s4) var(--s3); font-size: 13px; }
  .loaderr { display: grid; gap: 7px; margin-bottom: var(--s3); padding: var(--s3); background: var(--surface); color: var(--text-dim); font-size: 13px; }
  .loaderr b { color: var(--text); font-weight: var(--w-med); }
  .loaderr button { justify-self: start; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 6px 13px; cursor: pointer; font: var(--w-reg) 11.5px var(--sans); }
  .loaderr button:hover { color: var(--text); background: var(--chip-hi); }
  /* flush seam-separated rows, matching Sessions/Hosts */
  .rows { display: grid; gap: 1px; background: var(--seam); }
  .cell { background: var(--bg); }
  .cell:hover { background: var(--surface); }
  .trow { display: flex; align-items: center; gap: 13px; min-height: 48px; padding: 0 var(--s3); }
  .trow .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; box-sizing: border-box; }
  .dot.ok { background: var(--text); }
  .dot.warn { border: 1.5px solid var(--text); }
  .dot.starting { background: var(--mercury-flow); animation: pulse 2.2s ease-in-out infinite; }
  .dot.err { background: var(--alert); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  .route { display: inline-flex; align-items: center; gap: 9px; font-family: var(--mono); font-size: 13px; color: var(--text-dim); }
  .route b { color: var(--text); font-weight: var(--w-semi); }
  .route .arrow { color: var(--text-faint); }
  .st { font-size: 10px; text-transform: uppercase; letter-spacing: .12em; color: var(--text-faint); }
  .sp { flex: 1; }
  .act { background: none; border: 0; color: var(--text-dim); padding: 6px 0 6px 14px; cursor: pointer; font: var(--w-reg) 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; transition: color .12s; }
  .act:hover { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .act.danger:hover { color: var(--alert); }
  .mini:focus-visible, .add:focus-visible, .loaderr button:focus-visible, .addbar input:focus-visible, .act:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }
  .terr { color: var(--text-dim); font-size: 11px; font-family: var(--mono); padding: 0 var(--s3) 12px 34px; }
  .terr.warn { color: var(--text); }

  @media (prefers-reduced-motion: reduce) { .dot.starting { animation: none; } }
  @media (max-width: 760px) { .view { padding: var(--s3); } }
</style>
