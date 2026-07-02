<script>
  // Home screen: what needs me, then what's alive, then the rest — decisions first, chrome never.
  import { respondPermission, resumeSession, removeSession } from '../lib/api.js';
  import { lastActiveLabel } from '../lib/operatorStatus.mjs';
  import { agentLabel, sessionHostLabel, sessionPathParts, sessionStatusView } from '../lib/sessionView.mjs';

  let { data, onOpenSession, onLaunch } = $props();

  let sessions = $derived(data.d.sessions);
  let waiting = $derived(sessions.filter((s) => s.pendingPerm));
  let attention = $derived(sessions.filter((s) => !s.pendingPerm && (s.status === 'error' || s.status === 'exited')));
  let active = $derived(sessions.filter((s) => !s.pendingPerm && (s.status === 'busy' || s.status === 'starting')));
  let idle = $derived(sessions.filter((s) => s.status === 'idle' && !s.pendingPerm));
  let rest = $derived(sessions
    .filter((s) => !s.pendingPerm && !['busy', 'starting', 'idle', 'error', 'exited'].includes(s.status))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)));
  let runningCount = $derived(active.length + waiting.length);

  const project = (s) => s.label || sessionPathParts(s.cwd).project;
  let acting = $state({});     // session id -> in-flight action guard

  async function respond(s, decision) {
    if (!s.pendingPerm || acting[s.id]) return;
    acting[s.id] = true;
    try { await respondPermission(s.id, s.pendingPerm.id, decision); await data.poll(); }
    catch (e) { onOpenSession?.(s); }          // prompt already answered/changed — resolve it in the chat
    finally { delete acting[s.id]; }
  }
  async function revive(s) {
    if (acting[s.id]) return;
    acting[s.id] = true;
    try { await resumeSession(s.id); await data.poll(); onOpenSession?.({ ...s, status: 'starting' }); }
    catch (e) {}
    finally { delete acting[s.id]; }
  }
  async function dismiss(s) {
    if (acting[s.id]) return;
    acting[s.id] = true;
    try { await removeSession(s.id); await data.poll(); }
    catch (e) {}
    finally { delete acting[s.id]; }
  }
</script>

<div class="herd">
  <div class="band">
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
  </div>

  {#if sessions.length === 0}
    <div class="empty">
      <b>The herd is quiet.</b>
      <span>No sessions anywhere. Ranch one.</span>
      <button class="ranch" onclick={() => onLaunch?.()}>Ranch an agent</button>
    </div>
  {/if}

  {#if waiting.length || attention.length}
    <section>
      <h2>Needs you</h2>
      {#each waiting as s (s.id)}
        <div class="card">
          <button class="cbody" onclick={() => onOpenSession?.(s)}>
            <span class="dot ask"></span>
            <span class="cmain">
              <b>{project(s)}</b>
              <span class="csub">{agentLabel(s.agent)} wants to use <code>{s.pendingPerm.tool}</code>{#if s.pendingPerm.count > 1} (+{s.pendingPerm.count - 1} more){/if}</span>
              {#if s.pendingPerm.summary}<span class="csub"><code>{s.pendingPerm.summary}</code></span>{/if}
            </span>
            <span class="chost">{sessionHostLabel(s.host)}</span>
          </button>
          <div class="cactions">
            <button class="deny" onclick={() => respond(s, 'deny')} disabled={!!acting[s.id]}>Deny</button>
            <span class="sp"></span>
            <button class="quiet" onclick={() => respond(s, 'allow-always')} disabled={!!acting[s.id]}>Always</button>
            <button class="allow" onclick={() => respond(s, 'allow')} disabled={!!acting[s.id]}>Allow</button>
          </div>
        </div>
      {/each}
      {#each attention as s (s.id)}
        <div class="card">
          <button class="cbody" onclick={() => onOpenSession?.(s)}>
            <span class="dot err"></span>
            <span class="cmain">
              <b>{project(s)}</b>
              <span class="csub">{sessionStatusView(s.status).label} · {lastActiveLabel(s.updatedAt)}</span>
            </span>
            <span class="chost">{sessionHostLabel(s.host)}</span>
          </button>
          <div class="cactions">
            <button class="deny" onclick={() => dismiss(s)} disabled={!!acting[s.id]}>Dismiss</button>
            <span class="sp"></span>
            {#if s.sessionId}<button class="allow" onclick={() => revive(s)} disabled={!!acting[s.id]}>Resume</button>{/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  {#if active.length || idle.length}
    <section>
      <h2>Alive</h2>
      {#each [...active, ...idle] as s (s.id)}
        <button class="row" onclick={() => onOpenSession?.(s)}>
          <span class="dot {sessionStatusView(s.status).tone}"></span>
          <span class="cmain">
            <b>{project(s)}</b>
            <span class="csub">{agentLabel(s.agent)} · {sessionStatusView(s.status).label} · {lastActiveLabel(s.updatedAt)}</span>
          </span>
          <span class="chost">{sessionHostLabel(s.host)}</span>
        </button>
      {/each}
    </section>
  {/if}

  {#if rest.length}
    <section>
      <h2>Rested</h2>
      {#each rest.slice(0, 20) as s (s.id)}
        <button class="row" onclick={() => onOpenSession?.(s)}>
          <span class="dot dormant"></span>
          <span class="cmain">
            <b>{project(s)}</b>
            <span class="csub">{agentLabel(s.agent)} · {lastActiveLabel(s.updatedAt)}</span>
          </span>
          <span class="chost">{sessionHostLabel(s.host)}</span>
        </button>
      {/each}
    </section>
  {/if}
</div>

<style>
  .herd { padding: 0 var(--s4) var(--s6); }

  /* stat band — thin oversized numerals do the talking */
  .band { display: flex; gap: var(--s5); padding: var(--s5) 0 var(--s5); border-bottom: 1px solid var(--seam); }
  .stat { display: flex; flex-direction: column; gap: 6px; }
  .stat b { font-size: 46px; line-height: .9; font-weight: var(--w-thin); color: var(--text-dim); font-variant-numeric: tabular-nums; }
  .stat b.alive { background: var(--mercury-flow); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat b.warn { color: var(--text); }
  .stat span { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }

  .empty { min-height: 46dvh; display: flex; flex-direction: column; justify-content: center; gap: 12px; }
  .empty b { font-size: clamp(34px, 9vw, 46px); line-height: 1.02; font-weight: var(--w-light); color: var(--text); }
  .empty span { color: var(--text-dim); font-size: 13px; }
  .ranch { align-self: flex-start; margin-top: 14px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); padding: 12px 22px; font: var(--w-med) 13px var(--sans); cursor: pointer; }

  section { padding-top: var(--s5); }
  h2 { margin: 0 0 var(--s2); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: var(--w-reg); color: var(--text-faint); }

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
