<script>
  // Full session queue — a drill-in view off the dashboard (which only shows the attention list).
  // Filters, keyword search, per-row handoffs, and lifecycle actions live here.
  import Icon from './lib/Icon.svelte';
  import { isStaleResumableSession, lastActiveLabel, sessionAction, sessionInspectAction, sessionStatusLabel, sessionTone } from './lib/operatorStatus.mjs';
  import { filterSessionsForQueue, queueFilterCount, SESSION_QUEUE_FILTERS } from './lib/sessionQueue.mjs';

  let {
    sessions = [],
    filterRequest = null,
    onNewChat,
    onOpenFiles,
    onOpenSessionFiles,
    onOpenSessionTunnels,
    onOpenSessionChanges,
    onInspectChat,
    onOpenChat,
    onKillSession,
    onRemoveSession,
  } = $props();

  const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
  const isRemote = (host) => host && host !== 'local';
  let now = $state(Date.now());
  let mode = $state('all');
  let query = $state('');
  let lastToken = null;

  const runAction = (s) => {
    const action = sessionAction(s);
    if (action.kind === 'kill') return onKillSession?.(s);
    if (action.kind === 'remove') return onRemoveSession?.(s);
    return onOpenChat?.(s);
  };
  let queue = $derived(filterSessionsForQueue(sessions, { mode, query, host: 'all', now }));

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30000);
    return () => clearInterval(t);
  });
  $effect(() => {
    if (!filterRequest?.token || filterRequest.token === lastToken) return;
    lastToken = filterRequest.token;
    mode = filterRequest.filter || 'all';
    query = '';
  });
</script>

<section class="view">
  <div class="wrap">
    <div class="phead">
      <span>Sessions</span>
      <button class="mini" onclick={() => onNewChat?.('local')}><Icon name="plus" size={13} /> local</button>
    </div>
    {#if sessions.length}
      <div class="queuecontrols">
        <div class="seg" aria-label="Session queue filter">
          {#each SESSION_QUEUE_FILTERS as filter (filter.id)}
            <button class:on={mode === filter.id} onclick={() => (mode = filter.id)}>
              <span>{filter.label}</span>
              <b>{queueFilterCount(sessions, filter.id, now, 'all')}</b>
            </button>
          {/each}
        </div>
        <input class="qsearch" bind:value={query} spellcheck="false" autocomplete="off" placeholder="project / host" aria-label="Filter sessions" />
      </div>
    {/if}
    {#if sessions.length === 0}
      <div class="empty"><b>No sessions yet.</b></div>
    {:else if queue.length === 0}
      <div class="empty"><b>No matching sessions.</b></div>
    {:else}
      <div class="sessionlist">
        {#each queue as s (s.id)}
          {@const inspect = sessionInspectAction(s)}
          {@const stale = isStaleResumableSession(s, now)}
          <div class="qrow" class:stale>
            <button class="qmain" onclick={() => (onInspectChat || onOpenChat)?.(s)} title={inspect.title + ': ' + s.cwd} aria-label="{inspect.label} {base(s.cwd)}">
              <span class="dot {sessionTone(s)}"></span>
              <span class="qname">{s.label || base(s.cwd)}</span>
              <span class="qmeta">{(s.agent && s.agent !== 'claude' ? s.agent + ' · ' : '') + (isRemote(s.host) ? s.host : 'this computer')}</span>
              <span class="qstate">{stale ? 'stale' : sessionStatusLabel(s)}</span>
              <span class="qage" title="Last active">{lastActiveLabel(s.updatedAt || s.createdAt, now)}</span>
            </button>
            <div class="qtools" aria-label="Session handoffs">
              <button class="rowico" title="Review changes for {base(s.cwd)}" onclick={() => onOpenSessionChanges?.(s)}>
                <Icon name="pencil" size={13} />
              </button>
              <button class="rowico" title="Browse files for {base(s.cwd)}" onclick={() => onOpenSessionFiles ? onOpenSessionFiles(s) : onOpenFiles?.(s.host)}>
                <Icon name="folder" size={13} />
              </button>
              {#if isRemote(s.host)}
                <button class="rowico" title="Port forwarding on {s.host}" onclick={() => onOpenSessionTunnels?.(s)}>
                  <Icon name="swap" size={13} />
                </button>
              {/if}
            </div>
            <button class="rowact" class:danger={sessionAction(s).kind === 'kill' || sessionAction(s).kind === 'remove'} onclick={() => runAction(s)}>
              {sessionAction(s).label}
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

<style>
  .view { position: absolute; inset: 0; overflow: auto; background: var(--bg); padding: var(--s5); }
  .wrap { max-width: 1060px; margin: 0 auto; }
  .phead { min-height: 46px; display: flex; align-items: center; gap: var(--s3); padding: 0 var(--s3); border-bottom: 1px solid var(--seam); color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .phead .mini { margin-left: auto; }
  .mini { display: inline-flex; align-items: center; gap: 7px; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 8px 15px; cursor: pointer; font: var(--w-reg) 12px var(--sans); letter-spacing: 0; text-transform: none; transition: color .12s, background .12s; }
  .mini:hover { color: var(--text); background: var(--chip-hi); }

  .queuecontrols { display: grid; grid-template-columns: minmax(0, 1fr) 176px; gap: 8px; align-items: center; padding: var(--s2); border-bottom: 1px solid var(--seam); }
  .seg { min-width: 0; display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 4px; }
  .seg button { min-width: 0; height: 30px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; font: var(--w-reg) 10.5px var(--sans); transition: color .12s, background .12s; }
  .seg button:hover, .seg button.on { color: var(--text); background: var(--chip-hi); }
  .seg span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .seg b { flex: none; color: var(--text-faint); font: 10px var(--mono); }
  .qsearch { min-width: 0; height: 30px; background: var(--chip); border: 0; color: var(--text); padding: 0 10px; outline: 0; font: 11.5px var(--mono); transition: background .12s; }
  .qsearch:focus { background: var(--chip-hi); }
  .qsearch::placeholder { color: var(--text-faint); }
  .empty { padding: var(--s4); color: var(--text-dim); display: grid; gap: 4px; font-size: 13px; }
  .empty b { color: var(--text); font-weight: var(--w-med); }

  .sessionlist { padding: var(--s1) 0; }
  .qrow { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; min-height: 44px; border-left: 2px solid transparent; }
  .qrow:hover { background: var(--surface); border-left-color: var(--text); }
  .qrow.stale { border-left-color: var(--text-dim); }
  .qrow.stale .qstate { color: var(--text-dim); }
  .qrow.stale .dot.dormant { border-color: var(--text-dim); }
  .qmain { min-width: 0; display: grid; grid-template-columns: 16px minmax(80px, 1fr) minmax(70px, .75fr) auto auto; align-items: center; gap: 10px; height: 44px; background: none; border: 0; color: var(--text); text-align: left; cursor: pointer; font: inherit; }
  .qtools { display: flex; align-items: center; justify-content: flex-end; gap: 6px; width: 90px; margin-right: 8px; opacity: 0; pointer-events: none; transition: opacity .12s; }
  .qrow:hover .qtools, .qrow:focus-within .qtools { opacity: 1; pointer-events: auto; }
  .rowico { width: 28px; height: 28px; display: grid; place-items: center; background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; transition: color .12s, background .12s; }
  .rowico:hover { color: var(--text); background: var(--chip-hi); }
  .dot { width: 9px; height: 9px; border-radius: 50%; box-sizing: border-box; justify-self: center; }
  .dot.idle { border: 1.5px solid var(--text-faint); }
  .dot.busy { background: var(--mercury-flow); animation: breathe 2.4s ease-in-out infinite; }
  .dot.dormant { border: 1.5px dashed var(--text-faint); }
  .dot.off { background: var(--text-faint); }
  .dot.alert { background: var(--alert); }
  .qname, .qmeta, .qstate, .qage { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .qname { font-size: 13.5px; }
  .qmeta { color: var(--text-dim); font-family: var(--mono); font-size: 11.5px; }
  .qstate { color: var(--text-faint); font-size: 10px; letter-spacing: .12em; text-transform: uppercase; }
  .qage { color: var(--text-faint); font-family: var(--mono); font-size: 11px; }
  .rowact { min-width: 60px; text-align: right; margin-right: var(--s2); background: none; border: 0; color: var(--text-dim); padding: 6px 0; cursor: pointer; font: var(--w-reg) 10px var(--sans); letter-spacing: .14em; text-transform: uppercase; transition: color .12s; }
  .rowact:hover { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .rowact.danger:hover { color: var(--alert); }

  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  @media (prefers-reduced-motion: reduce) { .dot.busy { animation: none; } }
  @media (hover: none), (pointer: coarse) { .qtools { opacity: 1; pointer-events: auto; } }
  @media (max-width: 760px) {
    .view { padding: var(--s3); }
    .queuecontrols { grid-template-columns: 1fr; }
    .qmain { grid-template-columns: 16px minmax(80px, 1fr) auto; }
    .qmeta, .qage { display: none; }
    .qtools { gap: 4px; margin-right: 6px; }
    .rowico { width: 26px; height: 26px; }
  }
</style>
