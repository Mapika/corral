<script>
  // Host grid — a drill-in view off the dashboard: every ssh-config host with health, tmux
  // targets, and per-host actions (chat / terminal / files / tunnels).
  import Icon from './lib/Icon.svelte';
  import { buildHostCards } from './lib/hostHealth.mjs';

  let {
    groups = [],
    sessions = [],
    hostStatuses = [],
    onNewChat,
    onOpenFiles,
    onOpenTunnels,
    onOpenTerminal,
    onOpenSessionFiles,
    onRefresh,
  } = $props();

  const isRemote = (host) => host && host !== 'local';
  let hostCards = $derived(buildHostCards({ groups, sessions, statuses: hostStatuses }));
</script>

<section class="view">
  <div class="wrap">
    <div class="phead">
      <span>Hosts</span>
      <button class="mini" onclick={() => onRefresh?.()} title="Re-probe host health"><Icon name="swap" size={13} /> refresh</button>
    </div>
    <div class="hostlist">
      {#each hostCards as g (g.host)}
        <article class="hostrow" class:offline={g.tone === 'offline'}>
          <button class="hmain" onclick={() => onOpenFiles?.(g.host)} title="Browse files on {g.label}">
            <span class="hdot {g.tone}"></span>
            <span class="htext">
              <b class:remote={isRemote(g.host)}>{g.label}</b>
              <small>{g.sessions} sessions / {g.detail}</small>
            </span>
            <span class="hstate">{g.statusLabel}</span>
          </button>
          {#if g.tmuxTargets.length}
            <div class="tmuxlist" aria-label="Tmux sessions on {g.label}">
              {#each g.tmuxTargets as target (target.name)}
                <div class="tmuxrow" class:attached={target.attached}>
                  <button class="tmuxmain" onclick={() => target.path ? onOpenSessionFiles?.({ host: g.host, cwd: target.path }) : onOpenFiles?.(g.host)} title={target.path || target.name}>
                    <span>{target.name}{#if target.views > 1} · {target.views} views{/if}</span>
                    <small>{target.path || 'no cwd'}</small>
                  </button>
                  <button class="tmuxnew" onclick={() => onOpenTerminal?.(g.host, { target: target.name })} title="Attach terminal to {target.name}">
                    <Icon name="terminal" size={12} />
                  </button>
                  <button class="tmuxnew" onclick={() => onNewChat?.(g.host, target.path)} disabled={!target.path} title="New chat in {target.path || target.name}">
                    <Icon name="plus" size={12} />
                  </button>
                </div>
              {/each}
            </div>
          {/if}
          <div class="hacts" aria-label="Host actions">
            <button title={g.canLaunch ? 'New chat' : g.launchBlockedLabel} onclick={() => g.canLaunch && onNewChat?.(g.host)} disabled={!g.canLaunch}><Icon name="plus" size={14} /></button>
            <button title="Terminal" onclick={() => onOpenTerminal?.(g.host)}><Icon name="terminal" size={14} /></button>
            <button title="Browse files" onclick={() => onOpenFiles?.(g.host)}><Icon name="folder" size={14} /></button>
            {#if isRemote(g.host)}
              <button title="Port forwarding" onclick={() => onOpenTunnels?.(g.host)}><Icon name="swap" size={14} /></button>
            {/if}
          </div>
        </article>
      {/each}
    </div>
  </div>
</section>

<style>
  .view { position: absolute; inset: 0; overflow: auto; background: var(--bg); padding: var(--s5); }
  .wrap { max-width: 1060px; margin: 0 auto; }
  .phead { min-height: 46px; display: flex; align-items: center; gap: var(--s3); padding: 0 var(--s3); border-bottom: 1px solid var(--seam); color: var(--text-faint); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; }
  .phead .mini { margin-left: auto; }
  .mini { display: inline-flex; align-items: center; gap: 7px; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 8px 15px; cursor: pointer; font: var(--w-reg) 12px var(--sans); letter-spacing: 0; text-transform: none; transition: color .12s, background .12s; }
  .mini:hover { color: var(--text); background: var(--chip-hi); }

  .hostlist { display: grid; gap: 1px; background: var(--seam); }
  .hostrow { min-width: 0; background: var(--bg); display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: var(--s2); padding: var(--s2); }
  .hostrow:hover { background: var(--surface); }
  .hostrow.offline > * { opacity: .55; }
  .hmain { min-width: 0; display: grid; grid-template-columns: 14px minmax(0, 1fr) auto; align-items: center; gap: 9px; border: 0; background: none; color: inherit; text-align: left; cursor: pointer; font: inherit; }
  .hdot { width: 8px; height: 8px; border-radius: 50%; box-sizing: border-box; background: var(--text-faint); }
  .hdot.local { border: 1.5px solid var(--text-faint); background: transparent; }
  .hdot.online { background: var(--mercury-flow); }
  .hdot.offline { background: var(--text-dim); }
  .hdot.unknown { border: 1.5px dashed var(--text-faint); background: transparent; }
  .htext { min-width: 0; display: grid; gap: 3px; }
  .htext b, .htext small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .htext b { color: var(--text); font-size: 13.5px; font-weight: var(--w-med); }
  .htext b.remote { font-family: var(--mono); font-size: 12px; }
  .htext small { color: var(--text-faint); font-size: 11px; line-height: 1.35; }
  /* fixed-width columns so the status labels align down the list regardless of how many
     hover-actions a row has (local rows have 3, remote rows 4) */
  .hstate { min-width: 64px; text-align: right; color: var(--text-faint); font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; }
  .tmuxlist { grid-column: 1 / -1; margin-left: 23px; display: grid; gap: 5px; }
  .tmuxrow { display: grid; grid-template-columns: minmax(0, 1fr) 26px 26px; align-items: stretch; gap: 5px; }
  .tmuxrow.attached .tmuxmain { border-left-color: var(--text); }
  .tmuxmain { min-width: 0; display: grid; gap: 2px; background: var(--chip); border: 0; border-left: 2px solid transparent; color: var(--text); text-align: left; cursor: pointer; padding: 6px 8px; font: inherit; transition: background .12s; }
  .tmuxmain:hover { background: var(--chip-hi); }
  .tmuxmain span, .tmuxmain small { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tmuxmain span { font: 11.5px var(--mono); }
  .tmuxmain small { color: var(--text-faint); font: 10px var(--mono); }
  .tmuxnew { display: grid; place-items: center; background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; transition: color .12s, background .12s; }
  .tmuxnew:hover { color: var(--text); background: var(--chip-hi); }
  .tmuxnew:disabled { opacity: .35; pointer-events: none; }
  .hacts { display: flex; justify-content: flex-end; gap: 6px; width: 130px; opacity: 0; pointer-events: none; transition: opacity .12s; }
  .hostrow:hover .hacts, .hostrow:focus-within .hacts { opacity: 1; pointer-events: auto; }
  .hacts button { width: 28px; height: 28px; display: grid; place-items: center; background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; transition: color .12s, background .12s; }
  .hacts button:hover { color: var(--text); background: var(--chip-hi); }
  .hacts button:disabled { cursor: not-allowed; opacity: .38; background: none; }

  @media (hover: none), (pointer: coarse) { .hacts { opacity: 1; pointer-events: auto; } }
  @media (max-width: 760px) {
    .view { padding: var(--s3); }
    .hostrow { grid-template-columns: 1fr; }
    .hacts { padding-left: 23px; }
  }
</style>
