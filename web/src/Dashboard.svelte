<script>
  import Icon from './lib/Icon.svelte';
  import Shader from './lib/Shader.svelte';
  import { dashboardRecentProjects } from './lib/dashboardRecentProjects.mjs';
  import { dashboardSummaryStats, dashboardToday } from './lib/dashboardToday.mjs';
  import { buildHostCards } from './lib/hostHealth.mjs';
  import { operatorAttention, operatorMetrics, sessionUsageTotals } from './lib/operatorStatus.mjs';
  import { tunnelStatusView } from './lib/tunnelStatus.mjs';

  let {
    sessions = [],
    groups = [],
    tunnels = [],
    recentRoots = [],
    hostStatuses = [],
    running = 0,
    syncIssues = [],
    onNewChat,
    onOpenFiles,
    onOpenTunnels,
    onOpenSessionFiles,
    onOpenSessionTunnels,
    onOpenSessionChanges,
    onInspectChat,
    onOpenChat,
    onOpenHistory,
    onOpenSessions,
    onOpenHosts,
    onOpenFleet,
    onRefresh,
  } = $props();

  const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
  const isRemote = (host) => host && host !== 'local';
  let now = $state(Date.now());
  const runStatAction = (action) => {
    if (!action) return;
    if (action.kind === 'fleet') return (onOpenFleet || onOpenSessions)?.('running');
    if (action.kind === 'filter') return onOpenSessions?.(action.filter);
    if (action.kind === 'tunnels') {
      const first = tunnels.find((t) => tunnelStatusView(t).tone === 'ok') || tunnels[0];
      if (first?.host) onOpenTunnels?.(first.host);
      return;
    }
    if (action.kind === 'refresh') return onRefresh?.();
  };
  const runTodayItem = (item) => {
    if (!item) return;
    if (item.type === 'session') {
      const session = sessions.find((s) => s.id === item.sessionId);
      if (session) return (onInspectChat || onOpenChat)?.(session);
      return;
    }
    if (item.type === 'project') {
      if (item.canLaunch !== false) onNewChat?.(item.host, item.dir);
      return;
    }
    if (item.type === 'host') {
      if (item.canLaunch !== false) onNewChat?.(item.host);
      else onRefresh?.();
    }
  };
  let metrics = $derived(operatorMetrics({ sessions, tunnels, hosts: groups.slice(1).map((g) => g.host), now }));
  let hostCards = $derived(buildHostCards({ groups, sessions, statuses: hostStatuses }));
  let recentProjects = $derived(dashboardRecentProjects({ groups, roots: recentRoots, sessions, hostCards, limit: 6 }));
  let attention = $derived(operatorAttention(metrics));
  const fmtTok = (n) => n < 1000 ? String(n) : n < 1e6 ? (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k' : (n / 1e6).toFixed(1) + 'm';
  let usageTotals = $derived(sessionUsageTotals(sessions));
  let summaryStats = $derived(usageTotals.tokens
    ? [...dashboardSummaryStats(metrics), { id: 'tokens', tone: 'quiet', value: fmtTok(usageTotals.tokens), label: usageTotals.costUsd != null ? 'tokens · $' + usageTotals.costUsd.toFixed(2) : 'tokens', action: null }]
    : dashboardSummaryStats(metrics));
  let today = $derived(dashboardToday({ sessions, recentProjects, hostCards, now }));

  $effect(() => {
    const t = setInterval(() => (now = Date.now()), 30000);
    return () => clearInterval(t);
  });
</script>

<section class="dash">
  <div class="wrap">
  {#if syncIssues.length}
    <section class="syncpanel" aria-label="Sync issues">
      <span class="syncbar"></span>
      <div>
        <b>Sync needs attention</b>
        <span>{syncIssues.map((issue) => `${issue.label}: ${issue.detail}`).join(' / ')}</span>
      </div>
      <button onclick={() => onRefresh?.()}><Icon name="swap" size={13} /> retry</button>
    </section>
  {/if}

  <div class="stats compactstats" aria-label="Operator status">
    <div class="atmo" class:alive={running > 0} aria-hidden="true"><Shader alive={running > 0} /></div>
    {#each summaryStats as stat (stat.id)}
      <button class="stat {stat.tone}" onclick={() => runStatAction(stat.action)} title="Open {stat.label}">
        <span class="num">{stat.value}</span>
        <span class="lab">{stat.label}</span>
      </button>
    {/each}
  </div>

  <section class="today {attention.tone}">
    <div class="todayhead">
      <div>
        <span class="sectionlabel">{today.title}</span>
      </div>
      {#if today.items.length === 0}
        <button class="mini" onclick={() => onNewChat?.('local')}><Icon name="plus" size={13} /> {today.emptyActionLabel}</button>
      {/if}
    </div>

    {#if today.items.length}
      <div class="todaylist">
        {#each today.items as item (item.id)}
          <article class="todayitem {item.tone}">
            <button class="todaymain" onclick={() => runTodayItem(item)} title={item.detail}>
              <span class="dot {item.tone}"></span>
              <span class="itext">
                <b>{item.title}</b>
                <small>{item.detail}</small>
              </span>
            </button>
            <div class="itemtools" aria-label="Session handoffs">
              {#if item.type === 'session'}
                {@const todaySession = sessions.find((s) => s.id === item.sessionId)}
                {#if todaySession}
                  <button class="rowico" title="Review changes for {base(todaySession.cwd)}" onclick={() => onOpenSessionChanges?.(todaySession)}>
                    <Icon name="pencil" size={13} />
                  </button>
                  <button class="rowico" title="Browse files for {base(todaySession.cwd)}" onclick={() => onOpenSessionFiles ? onOpenSessionFiles(todaySession) : onOpenFiles?.(todaySession.host)}>
                    <Icon name="folder" size={13} />
                  </button>
                  {#if isRemote(todaySession.host)}
                    <button class="rowico" title="Port forwarding on {todaySession.host}" onclick={() => onOpenSessionTunnels ? onOpenSessionTunnels(todaySession) : onOpenTunnels?.(todaySession.host)}>
                      <Icon name="swap" size={13} />
                    </button>
                  {/if}
                {/if}
              {/if}
            </div>
            <span class="itag">{item.eyebrow}</span>
            <button class="iact" onclick={() => runTodayItem(item)} title={item.detail}>{item.primaryLabel}</button>
          </article>
        {/each}
      </div>
    {:else}
      <div class="empty soft">
        <b>{today.empty?.title || 'Nothing needs your eye.'}</b>
        {#if today.empty?.hint}<small>{today.empty.hint}</small>{/if}
      </div>
    {/if}
    {#if today.note}
      <button class="hostnote" onclick={() => onOpenHosts?.()} title="Open hosts">
        {today.note.label} <span class="notelink">hosts</span>
      </button>
    {/if}
  </section>

  <nav class="drill" aria-label="Open a full view">
    <button class="mini" onclick={() => onOpenFleet?.()}>fleet</button>
    <button class="mini" onclick={() => onOpenSessions?.()}>sessions</button>
    <button class="mini" onclick={() => onOpenHosts?.()}>hosts</button>
    <button class="mini" onclick={() => onOpenHistory?.()}>history</button>
    <button class="mini" onclick={() => onNewChat?.('local')}><Icon name="plus" size={13} /> new chat</button>
  </nav>
  </div>
</section>

<style>
  .dash { position: absolute; inset: 0; overflow: auto; overflow-x: hidden; background: var(--bg); padding: var(--s5); }
  .wrap { max-width: 1060px; margin: 0 auto; }
  .drill { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: var(--s2) var(--s3) 0; }
  .mini { display: inline-flex; align-items: center; gap: 7px; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 8px 15px; cursor: pointer; font: var(--w-reg) 12px var(--sans); transition: color .12s, background .12s; }
  .mini:hover { color: var(--text); background: var(--chip-hi); }

  .syncpanel { display: grid; grid-template-columns: 3px minmax(0, 1fr) auto; align-items: center; gap: var(--s3); min-height: 50px; border: 1px solid var(--hair); border-left: 0; border-right: 0; margin-bottom: var(--s4); color: var(--text-dim); background: var(--surface); }
  .syncbar { align-self: stretch; background: var(--alert); }
  .syncpanel div { min-width: 0; display: grid; gap: 2px; }
  .syncpanel b { color: var(--text); font-size: 13px; font-weight: var(--w-med); }
  .syncpanel span:not(.syncbar) { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11.5px var(--mono); color: var(--text-faint); }
  .syncpanel button { display: inline-flex; align-items: center; gap: 7px; margin-right: var(--s3); background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 7px 13px; cursor: pointer; font: var(--w-reg) 12px var(--sans); }
  .syncpanel button:hover { color: var(--text); background: var(--chip-hi); }

  .stats { position: relative; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); border-top: 1px solid var(--seam); border-bottom: 1px solid var(--seam); margin-bottom: var(--s4); }
  .atmo { position: absolute; inset: 0; opacity: .35; transition: opacity 1.2s; pointer-events: none; }
  .atmo.alive { opacity: .8; }
  .stat { position: relative; min-height: 92px; padding: 16px var(--s3) 14px; border: 0; background: none; text-align: left; cursor: pointer; display: grid; align-content: center; gap: 8px; }
  .stat:hover, .stat:focus-visible { background: var(--surface); outline: 0; }
  .stat:focus-visible { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .num { color: var(--text); font: var(--w-thin) 44px/.95 var(--sans); letter-spacing: -.01em; font-variant-numeric: tabular-nums; }
  .lab { color: var(--text-faint); font-size: 10px; line-height: 1.1; letter-spacing: .16em; text-transform: uppercase; }
  .stat.live .num { background: var(--mercury-flow); -webkit-background-clip: text; background-clip: text; color: transparent; }
  .stat.alert .lab { color: var(--alert); }

  .today { border: 0; background: none; margin-bottom: var(--s4); }
  .empty.soft { display: grid; gap: 9px; padding: var(--s5) var(--s3); }
  .empty.soft b { color: var(--text); font: var(--w-light) 26px/1.1 var(--sans); }
  .empty.soft small { color: var(--text-faint); font: 12px/1.5 var(--mono); max-width: 52ch; }
  .hostnote { display: block; width: 100%; text-align: left; background: none; border: 0; border-top: 1px solid var(--seam); padding: 11px var(--s3); color: var(--text-faint); font: 11.5px var(--mono); cursor: pointer; transition: color .12s; }
  .hostnote:hover { color: var(--text-dim); }
  .hostnote .notelink { margin-left: 9px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); }
  .hostnote:hover .notelink { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .todayhead { min-height: 48px; display: flex; align-items: center; gap: var(--s3); padding: 0 var(--s3); border-bottom: 1px solid var(--seam); }
  .todayhead > div { min-width: 0; display: grid; gap: 5px; }
  .sectionlabel, .phead { color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .todayhead p { margin: 0; color: var(--text-dim); font-size: 13px; line-height: 1.35; }
  .todayhead .mini { margin-left: auto; }
  .todaylist { display: grid; gap: 1px; background: var(--seam); }
  .todayitem { min-width: 0; min-height: 64px; display: grid; grid-template-columns: minmax(0, 1fr) auto auto auto; align-items: center; column-gap: var(--s3); background: var(--bg); }
  .todayitem:hover { background: var(--surface); }
  .todaymain { min-width: 0; align-self: stretch; display: grid; grid-template-columns: 18px minmax(0, 1fr); align-items: center; gap: var(--s3); border: 0; background: none; color: var(--text); text-align: left; cursor: pointer; padding: 0 0 0 var(--s3); font: inherit; }
  .itext { min-width: 0; display: grid; gap: 4px; }
  .itext b, .itext small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .itext b { color: var(--text); font-size: 15px; font-weight: var(--w-reg); }
  .itext small { color: var(--text-faint); font: 11.5px var(--mono); }
  .itag { color: var(--text-faint); font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; text-align: right; }
  .iact { flex: none; min-width: 60px; text-align: right; background: none; border: 0; padding: 8px 0; margin-right: var(--s3); color: var(--text-dim); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; cursor: pointer; transition: color .12s; }
  .iact:hover { color: var(--text); text-decoration: underline; text-underline-offset: 4px; }
  .todayitem:hover .iact { color: var(--text); }
  /* fixed width so the eyebrow/action columns align whether a row has 0, 2 or 3 handoffs */
  .itemtools { display: flex; align-items: center; justify-content: flex-end; gap: 6px; width: 96px; opacity: 0; pointer-events: none; transition: opacity .12s; }
  .todayitem:hover .itemtools, .todayitem:focus-within .itemtools { opacity: 1; pointer-events: auto; }

  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  @media (prefers-reduced-motion: reduce) { .dot.busy, .dot.live { animation: none; } }
  @media (hover: none), (pointer: coarse) {
    .itemtools { opacity: 1; pointer-events: auto; }
  }
  @media (max-width: 760px) {
    .dash { padding: var(--s3); }
    .stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .syncpanel { grid-template-columns: 3px minmax(0, 1fr); align-items: start; padding: 10px 0; row-gap: 8px; }
    .syncpanel .syncbar { grid-row: 1 / span 2; }
    .syncpanel span:not(.syncbar) { overflow: visible; text-overflow: clip; white-space: normal; line-height: 1.35; }
    .syncpanel button { grid-column: 2; justify-self: start; margin-right: 0; }
    .todayitem { grid-template-columns: 1fr; align-items: stretch; column-gap: 0; }
    .todaymain { grid-template-columns: 18px minmax(0, 1fr); min-height: 0; padding: 12px var(--s3) 4px; }
    .itag { display: none; }
    .iact { justify-self: start; margin: 0 0 12px 37px; }
    .itemtools { padding: 2px var(--s3) 6px 37px; }
  }
</style>
