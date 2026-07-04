<script>
  // Tonight's queue across the herd: what's waiting, what's running, what already closed.
  // Per-ranch hold ("start at 01:00") lives here too — the queue itself drains on its ranch.
  import { closedJobs, jobProject, jobStatusView, pendingJobs } from '../lib/reviewQueue.mjs';
  import { pushOverlay, showToast } from './nav.svelte.js';
  import Icon from '../lib/Icon.svelte';

  let { data, onclose, onOpenReview } = $props();

  let multi = $derived(data.d.ranches.length > 1);
  let pending = $derived(pendingJobs(data.d.queue));
  let closed = $derived(closedJobs(data.d.queue));
  const where = (j) => (multi && j.ranchName ? j.ranchName : '');

  $effect(() => pushOverlay(() => onclose?.()));

  let acting = $state({});
  async function removeJob(j) {
    if (acting[j.id]) return;
    acting[j.id] = true;
    try { await data.clientFor(j.ranch).queueRemove(j.id); await data.poll(); }
    catch (e) { showToast('Could not remove it.'); }
    finally { delete acting[j.id]; }
  }
  async function toTop(j) {
    try { await data.clientFor(j.ranch).queueMove(j.id, 0); await data.poll(); } catch (e) {}
  }

  // Hold: one time picker; applies to every ranch that has queued jobs (each holds its own drain).
  let holdTime = $state('01:00');
  let holdRanches = $derived([...new Set(pending.filter((j) => j.status === 'queued').map((j) => j.ranch))]);
  let heldRanches = $derived(data.d.ranches.filter((r) => data.d.queue.some((j) => j.ranch === r.id && j.status === 'queued') && holdOf(r.id)));
  function holdOf(ranchId) {
    // the merged jobs don't carry hold; read it straight from the last snapshot via any queued job? —
    // holds ride per-ranch, so the data layer keeps them on d.ranches (queueHold), set in recompute.
    return data.d.ranches.find((r) => r.id === ranchId)?.queueHold || null;
  }
  function nextOccurrence(hhmm) {
    const [h, m] = String(hhmm || '').split(':').map((n) => parseInt(n, 10));
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const t = new Date();
    t.setHours(h, m, 0, 0);
    if (t.getTime() <= Date.now()) t.setDate(t.getDate() + 1);
    return t.getTime();
  }
  async function holdAll() {
    const until = nextOccurrence(holdTime);
    if (!until) return;
    try {
      await Promise.allSettled(holdRanches.map((rid) => data.clientFor(rid).queueHold(until)));
      await data.poll();
      showToast('Held — the queue starts at ' + holdTime + '.');
    } catch (e) { showToast('Hold failed.'); }
  }
  async function releaseAll() {
    try {
      await Promise.allSettled(holdRanches.map((rid) => data.clientFor(rid).queueRelease()));
      await data.poll();
      showToast('Released — draining now.');
    } catch (e) { showToast('Release failed.'); }
  }
  const holdLabel = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
</script>

<div class="queue">
  <header>
    <button class="back" onclick={() => onclose?.()} aria-label="Back"><Icon name="chevron-left" size={22} /></button>
    <div class="who"><b>Tonight's queue</b><span>{pending.length} waiting or running</span></div>
  </header>

  <div class="body">
    {#if pending.length === 0 && closed.length === 0}
      <div class="empty">
        <b>Nothing queued.</b>
        <span>Ranch an agent and pick “Queue for tonight” — the herd works while you sleep.</span>
      </div>
    {/if}

    {#if pending.length}
      <section>
        <h2>Up tonight</h2>
        {#each pending as j (j.ranch + ':' + j.id)}
          <div class="jrow">
            <span class="dot {jobStatusView(j.status).tone}"></span>
            <span class="jmain">
              <b>{j.label || jobProject(j)}</b>
              <span class="jsub">{jobProject(j)} · {jobStatusView(j.status).label}{where(j) ? ' · ' + where(j) : ''}</span>
            </span>
            {#if j.status === 'queued'}
              <button class="jact" onclick={() => toTop(j)} title="Run first">First</button>
              <button class="jact warn" onclick={() => removeJob(j)} disabled={!!acting[j.id]}>Remove</button>
            {/if}
          </div>
        {/each}
        {#if heldRanches.length}
          <p class="note">Held — starts at {holdLabel(heldRanches[0].queueHold)}{heldRanches.length > 1 ? ' (every held ranch)' : ''}.
            <button class="linkish" onclick={releaseAll}>Release now</button></p>
        {:else if holdRanches.length}
          <div class="holdrow">
            <span>Start at</span>
            <input type="time" bind:value={holdTime} />
            <button class="jact" onclick={holdAll}>Hold until then</button>
          </div>
        {/if}
      </section>
    {/if}

    {#if closed.length}
      <section>
        <h2>Closed</h2>
        {#each closed.slice(0, 20) as j (j.ranch + ':' + j.id)}
          <button class="jrow tap" onclick={() => j.status !== 'bounced' && onOpenReview?.(j)}>
            <span class="dot {jobStatusView(j.status).tone}"></span>
            <span class="jmain">
              <b>{j.label || jobProject(j)}</b>
              <span class="jsub">{jobStatusView(j.status).label}{where(j) ? ' · ' + where(j) : ''}</span>
            </span>
          </button>
        {/each}
      </section>
    {/if}
  </div>
</div>

<style>
  .queue { position: fixed; inset: 0; z-index: 31; display: flex; flex-direction: column; background: var(--bg); }

  header { flex: none; display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 0 6px 0 0; padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--seam); }
  .back { flex: none; width: 46px; height: 46px; background: none; border: 0; color: var(--text-dim); cursor: pointer; display: grid; place-items: center; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .who b { color: var(--text); font-size: 15px; font-weight: var(--w-med); }
  .who span { color: var(--text-faint); font: 10.5px var(--mono); }

  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--s4) var(--s6); }
  .empty { min-height: 40dvh; display: flex; flex-direction: column; justify-content: center; gap: 12px; }
  .empty b { font-size: clamp(30px, 8vw, 40px); line-height: 1.05; font-weight: var(--w-light); color: var(--text); }
  .empty span { color: var(--text-dim); font-size: 13px; line-height: 1.5; }

  section { padding-top: var(--s5); }
  h2 { margin: 0 0 var(--s2); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: var(--w-reg); color: var(--text-faint); }

  .jrow { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 10px 2px; border-bottom: 1px solid var(--seam); background: none; border-left: 0; border-right: 0; border-top: 0; color: inherit; font: inherit; text-align: left; }
  .jrow.tap { cursor: pointer; }
  .jrow.tap:active { background: var(--chip); }
  .jmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .jmain b { color: var(--text); font-size: 15px; font-weight: var(--w-med); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .jsub { color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
  .dot.busy { background: var(--mercury); animation: breathe 1.8s ease-in-out infinite; }
  .dot.idle { background: var(--text); }
  .dot.error { background: var(--alert); }
  .dot.ask { background: var(--alert); animation: breathe 1.4s ease-in-out infinite; }
  .dot.dormant { border: 1.5px dashed var(--text-faint); background: transparent; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

  .jact { flex: none; background: var(--chip); border: 0; border-radius: var(--pill); color: var(--text-dim); min-height: 36px; padding: 0 14px; font: var(--w-reg) 12px var(--sans); cursor: pointer; }
  .jact.warn:active { color: var(--alert); }
  .jact:disabled { opacity: .45; }

  .holdrow { display: flex; align-items: center; gap: 10px; padding: var(--s3) 0; color: var(--text-dim); font-size: 12.5px; }
  .holdrow input { background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: 15px var(--mono); padding: 9px 12px; }
  .note { padding: var(--s3) 0; margin: 0; color: var(--text-faint); font-size: 12px; }
  .linkish { background: none; border: 0; color: var(--text-dim); text-decoration: underline; font: inherit; cursor: pointer; padding: 0 0 0 6px; }

  @media (prefers-reduced-motion: reduce) { .dot.busy, .dot.ask { animation: none; } }
</style>
