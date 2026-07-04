<script>
  // The review gate, phone-sized: the landed diff full-screen, Keep / Bounce docked under the
  // thumb. Keep merges into the repo's checked-out branch (a refused merge degrades the job to
  // `conflict` — branch kept for the desktop); Bounce deletes worktree + branch, so it asks twice.
  import { highlightCode } from '../lib/markdown.js';
  import { diffstatLabel, jobProject, jobStatusView } from '../lib/reviewQueue.mjs';
  import { pushOverlay, showToast } from './nav.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { job, client, onclose, onchanged, onOpenSession } = $props();

  const hlDiff = (t) => highlightCode(t, 'diff');
  let changes = $state({ loading: true });
  let busy = $state(false);
  let armBounce = $state(false);        // two-step: BOUNCE -> "SURE?" — it deletes the branch
  let view = $derived(jobStatusView(job.status));

  $effect(() => {
    (async () => {
      if (!job.worktreeDir) { changes = { isRepo: false }; return; }
      try { changes = await client.gitDiff('local', job.worktreeDir); }
      catch (e) { changes = { isRepo: false }; }
    })();
  });

  $effect(() => pushOverlay(() => onclose?.()));

  async function keep() {
    if (busy) return;
    busy = true;
    try {
      const r = await client.queueKeep(job.id);
      if (r?.ok) { showToast('Kept — merged into ' + jobProject(job) + '.'); onchanged?.(); onclose?.(); }
      else if (r?.conflict) { showToast('Merge refused — the branch is waiting for your desktop.'); onchanged?.(); onclose?.(); }
      else showToast(r?.error || 'Keep failed.');
    } catch (e) { showToast('Keep failed — ' + (e?.message || 'try again.')); }
    finally { busy = false; }
  }
  async function bounce() {
    if (busy) return;
    if (!armBounce) { armBounce = true; setTimeout(() => (armBounce = false), 3000); return; }
    busy = true;
    try {
      const r = await client.queueBounce(job.id);
      if (r?.ok) { showToast('Bounced — worktree and branch removed.'); onchanged?.(); onclose?.(); }
      else showToast(r?.error || 'Bounce failed.');
    } catch (e) { showToast('Bounce failed — ' + (e?.message || 'try again.')); }
    finally { busy = false; }
  }
</script>

<div class="review">
  <header>
    <button class="back" onclick={() => onclose?.()} aria-label="Back"><Icon name="chevron-left" size={22} /></button>
    <div class="who">
      <b>{job.label || jobProject(job)}</b>
      <span>{job.ranchName ? job.ranchName + ' · ' : ''}{jobProject(job)} · {view.label}{job.diffstat ? ' · ' + diffstatLabel(job.diffstat) : ''}</span>
    </div>
  </header>

  {#if job.error}
    <p class="jerr">{job.error}</p>
  {/if}

  <div class="diffbody">
    {#if changes.loading}
      <div class="cph">loading…</div>
    {:else if !changes.isRepo}
      <div class="cph">{job.worktreeDir ? 'The worktree is gone.' : 'Nothing to show — the run left no worktree.'}</div>
    {:else if !changes.diff && !(changes.untracked && changes.untracked.length)}
      <div class="cph">No changes — working tree clean.</div>
    {:else}
      {#if changes.untracked && changes.untracked.length}
        <div class="untracked"><span>New files</span>{#each changes.untracked as u}<code>{u}</code>{/each}</div>
      {/if}
      {#if changes.diff}<pre class="diff"><code>{@html hlDiff(changes.diff)}</code></pre>{/if}
    {/if}
  </div>

  <div class="dock">
    <button class="deny" class:armed={armBounce} onclick={bounce} disabled={busy}>{armBounce ? 'Bounce — sure?' : 'Bounce'}</button>
    <span class="sp"></span>
    {#if job.sessionId}
      <button class="quiet" onclick={() => onOpenSession?.(job)} disabled={busy}>Open</button>
    {/if}
    {#if job.status !== 'failed'}
      <button class="allow" onclick={keep} disabled={busy}>{busy ? 'Working…' : job.status === 'conflict' ? 'Retry merge' : 'Keep'}</button>
    {/if}
  </div>
</div>

<style>
  .review { position: fixed; inset: 0; z-index: 32; display: flex; flex-direction: column; background: var(--bg); }

  header { flex: none; display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 0 6px 0 0; padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--seam); }
  .back { flex: none; width: 46px; height: 46px; background: none; border: 0; color: var(--text-dim); cursor: pointer; display: grid; place-items: center; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .who b { color: var(--text); font-size: 15px; font-weight: var(--w-med); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who span { color: var(--text-faint); font: 10.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .jerr { flex: none; margin: 0; padding: 10px var(--s4); color: var(--alert); font-size: 12px; border-bottom: 1px solid var(--seam); }

  .diffbody { flex: 1; min-height: 0; overflow: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .cph { padding: var(--s5) var(--s4); color: var(--text-dim); font-size: 13px; }
  .untracked { display: flex; flex-direction: column; gap: 6px; padding: var(--s3) var(--s4); border-bottom: 1px solid var(--seam); }
  .untracked span { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  .untracked code { font: 11.5px var(--mono); color: var(--text); overflow-wrap: anywhere; }
  .diff { margin: 0; padding: var(--s3) var(--s4) var(--s5); background: var(--frame); font: 11px/1.55 var(--mono); color: #d8d8d8; white-space: pre-wrap; word-break: break-word; min-height: 100%; }

  .dock { flex: none; display: flex; align-items: center; gap: 10px; padding: 10px var(--s4) calc(10px + env(safe-area-inset-bottom, 0px)); border-top: 1px solid var(--seam); background: var(--bg); }
  .dock .sp { flex: 1; }
  .allow { background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); min-height: 46px; padding: 0 26px; font: var(--w-med) 14px var(--sans); cursor: pointer; }
  .quiet { background: var(--chip); color: var(--text-dim); border: 0; border-radius: var(--pill); min-height: 46px; padding: 0 18px; font: var(--w-reg) 13px var(--sans); cursor: pointer; }
  .deny { background: none; border: 0; color: var(--text-dim); font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; padding: 14px 2px; cursor: pointer; }
  .deny.armed { color: var(--alert); }
  .allow:disabled, .quiet:disabled, .deny:disabled { opacity: .45; pointer-events: none; }
</style>
