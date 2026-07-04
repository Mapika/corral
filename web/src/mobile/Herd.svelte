<script>
  // Home screen: what needs me, then what's alive, then the rest — decisions first, chrome never.
  // The merged herd spans every paired ranch; actions route to the session's own server.
  import { showToast } from './nav.svelte.js';
  import { lastActiveLabel } from '../lib/operatorStatus.mjs';
  import { sessionKey } from '../lib/ranches.mjs';
  import { diffstatLabel, jobProject, jobStatusView, pendingJobs, reviewJobs } from '../lib/reviewQueue.mjs';
  import { agentLabel, sessionHostLabel, sessionPathParts, sessionStatusView } from '../lib/sessionView.mjs';
  import Shader from '../lib/Shader.svelte';

  const buzz = (ms = 12) => { try { navigator.vibrate?.(ms); } catch (e) {} };

  let { data, onOpenSession, onLaunch, onOpenReview, onOpenQueue } = $props();

  let sessions = $derived(data.d.sessions);
  let multi = $derived(data.d.ranches.length > 1);
  const where = (s) => (multi && s.ranchName ? s.ranchName + ' · ' : '') + sessionHostLabel(s.host);
  // The overnight ranch: landings owed a decision, and how much is still cooking tonight.
  let review = $derived(reviewJobs(data.d.queue));
  let queuePending = $derived(pendingJobs(data.d.queue));
  let waiting = $derived(sessions.filter((s) => s.pendingPerm));
  let attention = $derived(sessions.filter((s) => !s.pendingPerm && (s.status === 'error' || s.status === 'exited')));
  let active = $derived(sessions.filter((s) => !s.pendingPerm && (s.status === 'busy' || s.status === 'starting')));
  let idle = $derived(sessions.filter((s) => s.status === 'idle' && !s.pendingPerm));
  let rest = $derived(sessions
    .filter((s) => !s.pendingPerm && !['busy', 'starting', 'idle', 'error', 'exited'].includes(s.status))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  let runningCount = $derived(active.length + waiting.length);

  const project = (s) => s.label || sessionPathParts(s.cwd).project;
  let acting = $state({});     // ranch:session key -> in-flight action guard

  // Decision actions are optimistic — the card reacts under the thumb, the round-trip settles
  // behind it, and the next poll reconciles either way.
  async function respond(s, decision) {
    const k = sessionKey(s);
    if (!s.pendingPerm || acting[k]) return;
    buzz();
    acting[k] = true;
    const perm = s.pendingPerm;
    s.pendingPerm = null;
    try { await data.clientFor(s.ranch).respondPermission(s.id, perm.id, decision); await data.poll(); }
    catch (e) { onOpenSession?.(s); }          // prompt already answered/changed — resolve it in the chat
    finally { delete acting[k]; }
  }
  async function revive(s) {
    const k = sessionKey(s);
    if (acting[k]) return;
    acting[k] = true;
    try { await data.clientFor(s.ranch).resumeSession(s.id); await data.poll(); onOpenSession?.({ ...s, status: 'starting' }); }
    catch (e) { showToast('Could not resume this session.'); }
    finally { delete acting[k]; }
  }
  async function dismiss(s) {
    const k = sessionKey(s);
    if (acting[k]) return;
    acting[k] = true;
    data.d.sessions = data.d.sessions.filter((x) => sessionKey(x) !== k);
    try { await data.clientFor(s.ranch).removeSession(s.id); await data.poll(); }
    catch (e) { showToast('Could not dismiss — it stays in the herd.'); await data.poll(); }
    finally { delete acting[k]; }
  }

  // Quick keep straight from the card; bounce always routes through the review screen (it
  // deletes the branch — the diff deserves at least one look).
  async function quickKeep(j) {
    if (acting[j.id]) return;
    buzz();
    acting[j.id] = true;
    try {
      const r = await data.clientFor(j.ranch).queueKeep(j.id);
      if (r?.ok) showToast('Kept — merged into ' + jobProject(j) + '.');
      else if (r?.conflict) showToast('Merge refused — the branch is waiting for your desktop.');
      else showToast(r?.error || 'Keep failed.');
      await data.poll();
    } catch (e) { showToast('Keep failed — try again.'); }
    finally { delete acting[j.id]; }
  }
</script>

<div class="herd">
  <div class="band">
    <div class="atmo" class:alive={runningCount > 0} aria-hidden="true"><Shader alive={runningCount > 0} /></div>
    <div class="stat">
      <b class:alive={runningCount > 0}>{runningCount}</b>
      <span>running</span>
    </div>
    <div class="stat">
      <b>{waiting.length}</b>
      <span>waiting on you</span>
    </div>
    <div class="stat">
      <b class:warn={attention.length > 0}>{attention.length}</b>
      <span>attention</span>
    </div>
    {#if review.length || queuePending.length}
      <div class="stat">
        <b class:alive={review.length > 0}>{review.length}</b>
        <span>landed</span>
      </div>
    {/if}
  </div>

  {#if sessions.length === 0}
    {#if data.d.loaded}
      <div class="empty">
        <b>The herd is quiet.</b>
        <span>No sessions anywhere. Ranch one.</span>
        <button class="ranch" onclick={() => onLaunch?.()}>Ranch an agent</button>
      </div>
    {:else}
      <div class="empty"><span class="conn">connecting…</span></div>
    {/if}
  {/if}

  {#if review.length || queuePending.length}
    <section>
      <h2 class="qhead">Fresh diffs
        <button class="qlink" onclick={() => onOpenQueue?.()}>{queuePending.length ? queuePending.length + ' queued' : 'queue'}</button>
      </h2>
      {#each review as j (j.ranch + ':' + j.id)}
        <div class="card">
          <button class="cbody" onclick={() => onOpenReview?.(j)}>
            <span class="dot {jobStatusView(j.status).tone}"></span>
            <span class="cmain">
              <b>{j.label || jobProject(j)}</b>
              <span class="csub">{jobProject(j)} · {jobStatusView(j.status).label}{#if j.diffstat}{' · '}<code>{diffstatLabel(j.diffstat)}</code>{/if}</span>
              {#if j.error}<span class="csub"><code>{j.error}</code></span>{/if}
            </span>
            {#if multi && j.ranchName}<span class="chost">{j.ranchName}</span>{/if}
          </button>
          <div class="cactions">
            <button class="deny" onclick={() => onOpenReview?.(j)} disabled={!!acting[j.id]}>Review</button>
            <span class="sp"></span>
            {#if j.status === 'landed'}
              <button class="allow" onclick={() => quickKeep(j)} disabled={!!acting[j.id]}>Keep</button>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  {#if waiting.length || attention.length}
    <section>
      <h2>Needs you</h2>
      {#each waiting as s (sessionKey(s))}
        <div class="card">
          <button class="cbody" onclick={() => onOpenSession?.(s)}>
            <span class="dot ask"></span>
            <span class="cmain">
              <b>{project(s)}</b>
              <span class="csub">{agentLabel(s.agent)} wants to use <code>{s.pendingPerm.tool}</code>{#if s.pendingPerm.count > 1} (+{s.pendingPerm.count - 1} more){/if}</span>
              {#if s.pendingPerm.summary}<span class="csub"><code>{s.pendingPerm.summary}</code></span>{/if}
            </span>
            <span class="chost">{where(s)}</span>
          </button>
          <div class="cactions">
            <button class="deny" onclick={() => respond(s, 'deny')} disabled={!!acting[sessionKey(s)]}>Deny</button>
            <span class="sp"></span>
            <button class="quiet" onclick={() => respond(s, 'allow-always')} disabled={!!acting[sessionKey(s)]}>Always</button>
            <button class="allow" onclick={() => respond(s, 'allow')} disabled={!!acting[sessionKey(s)]}>Allow</button>
          </div>
        </div>
      {/each}
      {#each attention as s (sessionKey(s))}
        <div class="card">
          <button class="cbody" onclick={() => onOpenSession?.(s)}>
            <span class="dot err"></span>
            <span class="cmain">
              <b>{project(s)}</b>
              <span class="csub">{sessionStatusView(s.status).label} · {lastActiveLabel(s.updatedAt)}</span>
            </span>
            <span class="chost">{where(s)}</span>
          </button>
          <div class="cactions">
            <button class="deny" onclick={() => dismiss(s)} disabled={!!acting[sessionKey(s)]}>Dismiss</button>
            <span class="sp"></span>
            {#if s.sessionId}<button class="allow" onclick={() => revive(s)} disabled={!!acting[sessionKey(s)]}>Resume</button>{/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  {#if active.length || idle.length}
    <section>
      <h2>Alive</h2>
      {#each [...active, ...idle] as s (sessionKey(s))}
        <button class="row" onclick={() => onOpenSession?.(s)}>
          <span class="dot {sessionStatusView(s.status).tone}"></span>
          <span class="cmain">
            <b>{project(s)}</b>
            <span class="csub">{agentLabel(s.agent)} · {sessionStatusView(s.status).label} · {lastActiveLabel(s.updatedAt)}</span>
          </span>
          <span class="chost">{where(s)}</span>
        </button>
      {/each}
    </section>
  {/if}

  {#if rest.length}
    <section>
      <h2>Rested</h2>
      {#each rest.slice(0, 20) as s (sessionKey(s))}
        <button class="row" onclick={() => onOpenSession?.(s)}>
          <span class="dot dormant"></span>
          <span class="cmain">
            <b>{project(s)}</b>
            <span class="csub">{agentLabel(s.agent)} · {lastActiveLabel(s.updatedAt)}</span>
          </span>
          <span class="chost">{where(s)}</span>
        </button>
      {/each}
    </section>
  {/if}
</div>

<style>
  .herd { padding: 0 var(--s4) var(--s6); }

  /* stat band — thin oversized numerals over the mercury atmosphere (flowing while agents run) */
  .band { position: relative; display: flex; gap: var(--s5); padding: var(--s5) var(--s3); margin: 0 calc(-1 * var(--s4)); border-bottom: 1px solid var(--seam); overflow: hidden; }
  .atmo { position: absolute; inset: 0; opacity: .3; transition: opacity 1.2s; pointer-events: none; }
  .atmo.alive { opacity: .7; }
  .stat { position: relative; display: flex; flex-direction: column; gap: 6px; }
  .stat b { font-size: 46px; line-height: .9; font-weight: var(--w-thin); color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .stat b.alive { background: var(--mercury-flow); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat b.warn { color: var(--text); }
  .stat span { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }

  .empty { min-height: 46dvh; display: flex; flex-direction: column; justify-content: center; gap: 12px; }
  .empty b { font-size: clamp(34px, 9vw, 46px); line-height: 1.02; font-weight: var(--w-light); color: var(--text); }
  .empty span { color: var(--text-dim); font-size: 13px; }
  .empty .conn { font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  .ranch { align-self: flex-start; margin-top: 14px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); padding: 12px 22px; font: var(--w-med) 13px var(--sans); cursor: pointer; }

  section { padding-top: var(--s5); }
  h2 { margin: 0 0 var(--s2); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: var(--w-reg); color: var(--text-faint); }
  .qhead { display: flex; align-items: baseline; justify-content: space-between; }
  .qlink { background: none; border: 0; padding: 0; color: var(--text-dim); font: inherit; letter-spacing: inherit; text-transform: inherit; cursor: pointer; text-decoration: underline; text-underline-offset: 3px; }

  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
  .dot.busy { background: var(--mercury); animation: breathe 1.8s ease-in-out infinite; }
  .dot.idle { background: var(--text); }
  .dot.error, .dot.err { background: var(--alert); }
  .dot.ask { background: var(--alert); animation: breathe 1.4s ease-in-out infinite; }
  .dot.dormant { border: 1.5px dashed var(--text-faint); background: transparent; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .35; } }

  .cmain { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; text-align: left; }
  .cmain b { color: var(--text); font-size: 15px; font-weight: var(--w-med); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .csub { color: var(--text-dim); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .csub code { font: 11.5px var(--mono); color: var(--text); }
  .chost { flex: none; color: var(--text-faint); font: 10.5px var(--mono); }

  .row { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 10px 2px; background: none; border: 0; border-bottom: 1px solid var(--seam); color: inherit; font: inherit; cursor: pointer; }
  .row:active { background: var(--chip); }

  /* decision card — the phone's reason to exist */
  .card { border-bottom: 1px solid var(--seam); padding: 4px 0 14px; }
  .cbody { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 56px; padding: 10px 2px; background: none; border: 0; color: inherit; font: inherit; cursor: pointer; }
  .cactions { display: flex; align-items: center; gap: 10px; padding-left: 19px; }
  .cactions .sp { flex: 1; }
  .allow { background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); min-height: 42px; padding: 0 24px; font: var(--w-med) 13px var(--sans); cursor: pointer; }
  .quiet { background: var(--chip); color: var(--text-dim); border: 0; border-radius: var(--pill); min-height: 42px; padding: 0 18px; font: var(--w-reg) 13px var(--sans); cursor: pointer; }
  .quiet:active { background: var(--chip-hi); color: var(--text); }
  .deny { background: none; border: 0; color: var(--text-dim); font-size: 10.5px; letter-spacing: .14em; text-transform: uppercase; padding: 12px 2px; cursor: pointer; }
  .deny:active { color: var(--alert); }
  .allow:disabled, .quiet:disabled, .deny:disabled { opacity: .45; pointer-events: none; }

  @media (prefers-reduced-motion: reduce) { .dot.busy, .dot.ask { animation: none; } }
</style>
