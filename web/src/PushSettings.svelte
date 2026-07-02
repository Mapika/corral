<script>
  // Phone push setup: point Corral at an ntfy-compatible relay (ntfy.sh by default, self-hosted
  // works the same) and pick which moments buzz. The topic IS the credential — treat it like one.
  import { getPushConfig, setPushConfig, testPush } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';

  let { onclose } = $props();

  let cfg = $state(null);
  let error = $state('');
  let note = $state('');
  let busyAction = $state('');

  const randomTopic = () => 'corral-' + crypto.getRandomValues(new Uint32Array(2)).reduce((acc, n) => acc + n.toString(36), '');

  $effect(() => {
    (async () => {
      try {
        const loaded = await getPushConfig();
        if (!loaded.topic) loaded.topic = randomTopic();
        cfg = loaded;
      } catch (e) { error = apiErrorMessage(e, 'Could not load push settings.'); }
    })();
  });

  async function save(showNote = true) {
    if (!cfg) return false;
    error = ''; busyAction = 'save';
    try {
      const r = await setPushConfig({
        enabled: cfg.enabled, server: cfg.server, topic: cfg.topic,
        input: cfg.events.input, done: cfg.events.done, fail: cfg.events.fail,
      });
      cfg = { ...r.config, topic: cfg.topic };
      if (showNote) { note = 'saved'; setTimeout(() => (note = ''), 1600); }
      return true;
    } catch (e) { error = apiErrorMessage(e, 'Save failed.'); return false; }
    finally { busyAction = ''; }
  }

  async function sendTest() {
    if (!(await save(false))) return;
    error = ''; busyAction = 'test';
    try { await testPush(); note = 'sent — check your phone'; setTimeout(() => (note = ''), 3200); }
    catch (e) { error = apiErrorMessage(e, 'Test failed.'); }
    finally { busyAction = ''; }
  }

  const onKey = (e) => { if (e.key === 'Escape') onclose?.(); };
</script>

<svelte:window onkeydown={onKey} />

<div class="backdrop" onclick={(e) => { if (e.target === e.currentTarget) onclose?.(); }} role="presentation">
  <div class="panel" role="dialog" aria-label="Push notifications">
    <header>
      <span class="title">Push to your phone</span>
      <span class="sub">ntfy relay</span>
    </header>

    {#if cfg}
      <div class="body">
        <p class="hint">
          Install the <b>ntfy</b> app (iOS / Android), subscribe to the topic below, and Corral
          buzzes you when an agent needs a decision. Anyone who knows the topic can read these
          notifications — keep it unguessable. Self-hosted ntfy works: change the server.
        </p>

        <label class="row check">
          <input type="checkbox" bind:checked={cfg.enabled} />
          <span>Enabled</span>
        </label>

        <div class="row">
          <span class="olabel">Server</span>
          <input class="field" bind:value={cfg.server} spellcheck="false" autocomplete="off" placeholder="https://ntfy.sh" />
        </div>
        <div class="row">
          <span class="olabel">Topic</span>
          <input class="field" bind:value={cfg.topic} spellcheck="false" autocomplete="off" placeholder="corral-…" />
          <button class="ghost" onclick={() => (cfg.topic = randomTopic())}>reroll</button>
        </div>

        <div class="row">
          <span class="olabel">Notify on</span>
          <div class="checks">
            <label class="check"><input type="checkbox" bind:checked={cfg.events.input} /><span>needs a decision</span></label>
            <label class="check"><input type="checkbox" bind:checked={cfg.events.done} /><span>turn complete</span></label>
            <label class="check"><input type="checkbox" bind:checked={cfg.events.fail} /><span>died unexpectedly</span></label>
          </div>
        </div>

        {#if error}<div class="err" role="alert">{error}</div>{/if}
        {#if note}<div class="note">{note}</div>{/if}
      </div>

      <footer>
        <button class="ghost" onclick={sendTest} disabled={!!busyAction}>{busyAction === 'test' ? 'sending…' : 'Send test'}</button>
        <span class="sp"></span>
        <button class="ghost" onclick={() => onclose?.()}>Close</button>
        <button class="primary" onclick={async () => { if (await save()) onclose?.(); }} disabled={!!busyAction}>Save</button>
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
  .panel { width: min(480px, calc(100vw - 24px)); display: flex; flex-direction: column; background: var(--surface); box-shadow: 0 18px 50px rgba(0,0,0,.5); }
  header { display: flex; align-items: baseline; gap: 11px; padding: var(--s4) var(--s4) var(--s3); }
  .title { font-size: 19px; font-weight: var(--w-light); color: var(--text); }
  .sub { font: 12px var(--mono); color: var(--text-dim); }
  .body { display: grid; gap: var(--s3); padding: 0 var(--s4) var(--s3); }
  .hint { margin: 0; color: var(--text-dim); font-size: 12.5px; line-height: 1.55; }
  .hint b { color: var(--text); font-weight: var(--w-med); }
  .row { display: flex; align-items: center; gap: 10px; }
  .olabel { flex: none; width: 74px; color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .field { flex: 1; min-width: 0; background: var(--chip); border: 0; color: var(--text); padding: 0 12px; height: 34px; font: 12.5px/1 var(--mono); }
  .field:focus { outline: 0; background: var(--chip-hi); }
  .checks { display: grid; gap: 7px; }
  .check { display: inline-flex; align-items: center; gap: 9px; color: var(--text-dim); font-size: 12.5px; cursor: pointer; }
  .check input { accent-color: var(--text-dim); }
  .err { color: var(--alert); font-size: 12px; }
  .note { color: var(--text-dim); font: 11.5px var(--mono); }
  footer { display: flex; align-items: center; gap: 9px; padding: var(--s3) var(--s4) var(--s4); border-top: 1px solid var(--seam); }
  .sp { flex: 1; }
  .ghost { background: none; border: 0; color: var(--text-dim); padding: 8px 4px; cursor: pointer; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; transition: color .12s; }
  .ghost:hover { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .ghost:disabled { opacity: .5; cursor: default; }
  .primary { background: var(--paper); border: 0; color: var(--ink); border-radius: var(--pill); padding: 9px 19px; cursor: pointer; font: var(--w-med) 12px var(--sans); }
  .primary:disabled { opacity: .6; cursor: default; }
</style>
