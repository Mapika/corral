<script>
  // The phone console: HERD (decide) · RANCH (launch) · FLEET (watch), with chat as a full-screen
  // push. Built for thumbs on the Ink system — flush surfaces, seams, one warm signal.
  import { getServer, resumeSession } from '../lib/api.js';
  import { SERVER_KEY, TOKEN_KEY } from '../lib/serverBase.mjs';
  import { isResumableSession } from '../lib/operatorStatus.mjs';
  import Connect from './Connect.svelte';
  import FleetFeed from './FleetFeed.svelte';
  import Herd from './Herd.svelte';
  import LaunchSheet from './LaunchSheet.svelte';
  import MobileChat from './MobileChat.svelte';
  import Sheet from './Sheet.svelte';
  import { createMobileData } from './data.svelte.js';

  let { standalone = false, initialPaired = true } = $props();

  let paired = $state(standalone ? initialPaired : true);
  let tab = $state('herd');
  let chat = $state(null);           // full-screen session descriptor
  let launchOpen = $state(false);
  let settingsOpen = $state(false);
  // #session=<id> deep link — a push notification's Click target. Resolved once the roster
  // knows the session, then scrubbed from the address.
  let deepLink = $state((typeof location !== 'undefined' && (location.hash.match(/[#&]session=([\w-]+)/) || [])[1]) || null);

  const data = createMobileData();

  let liveCount = $derived(data.d.sessions.filter((s) => s.status === 'busy' || s.status === 'starting').length);
  let needCount = $derived(data.d.sessions.filter((s) => s.pendingPerm || s.status === 'error' || s.status === 'exited').length);

  $effect(() => {
    if (!paired) return;
    data.start();
    return () => data.stop();
  });

  $effect(() => {
    if (!deepLink) return;
    const s = data.d.sessions.find((x) => x.id === deepLink);
    if (!s) return;                  // roster not in yet — re-runs when sessions land
    deepLink = null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    openSession(s);
  });

  const chatDesc = (s) => ({ kind: 'chat', id: s.id, agent: s.agent || 'claude', host: s.host, cwd: s.cwd, model: s.model, status: s.status, sessionId: s.sessionId, label: s.label || null });
  async function openSession(s) {
    let next = s;
    if (s.status === 'dormant' || isResumableSession(s)) {
      try {
        const r = await resumeSession(s.id);
        if (r?.ok === false) return;
        next = { ...s, status: 'starting' };
        await data.poll();
      } catch (e) { return; }
    }
    chat = chatDesc(next);
  }
  function unpair() {
    try { localStorage.removeItem(SERVER_KEY); localStorage.removeItem(TOKEN_KEY); } catch (e) {}
    location.reload();
  }
</script>

{#if standalone && !paired}
  <Connect onPaired={() => (paired = true)} />
{:else}
  <div class="mshell">
    <header class="top">
      <button class="brand" onclick={() => (tab = 'herd')}>corral</button>
      <span class="sp"></span>
      {#if data.d.offline}
        <span class="off"><span class="odot"></span>offline</span>
      {:else if liveCount}
        <span class="run"><span class="ldot"></span>{liveCount} running</span>
      {/if}
      <button class="gear" onclick={() => (settingsOpen = true)} aria-label="Settings">&#8942;</button>
    </header>

    <main>
      {#if tab === 'herd'}
        <Herd {data} onOpenSession={openSession} onLaunch={() => (launchOpen = true)} />
      {:else}
        <FleetFeed {data} onOpenSession={openSession} onLaunch={() => (launchOpen = true)} />
      {/if}
    </main>

    <nav>
      <button class:on={tab === 'herd'} onclick={() => (tab = 'herd')}>
        Herd{#if needCount}<span class="badge">{needCount}</span>{/if}
      </button>
      <button class="ranchbtn" onclick={() => (launchOpen = true)} aria-label="Ranch a new agent">+</button>
      <button class:on={tab === 'fleet'} onclick={() => (tab = 'fleet')}>Fleet</button>
    </nav>

    {#if chat}
      {#key chat.id}
        <MobileChat session={chat} onclose={() => { chat = null; data.poll(); }} onchanged={() => data.poll()} />
      {/key}
    {/if}

    {#if launchOpen}
      <LaunchSheet {data} onclose={() => (launchOpen = false)} onLaunched={(desc) => { launchOpen = false; chat = desc; }} />
    {/if}

    {#if settingsOpen}
      <Sheet onclose={() => (settingsOpen = false)} label="Settings">
        <div class="settings">
          <h2>Connection</h2>
          <p class="kv"><span>Server</span><code>{getServer() || 'this device'}</code></p>
          <p class="kv"><span>Stream</span><code>{data.d.live ? 'live' : data.d.offline ? 'offline' : 'polling'}</code></p>
          {#if data.d.error}<p class="errline">{data.d.error}</p>{/if}
          {#if standalone}
            <button class="unpair" onclick={unpair}>Unpair from this server</button>
          {/if}
          <p class="hint">Phone push (ntfy) and remote access are configured on the desktop app.</p>
        </div>
      </Sheet>
    {/if}
  </div>
{/if}

<style>
  .mshell { height: 100dvh; display: flex; flex-direction: column; background: var(--bg); }

  .top { flex: none; display: flex; align-items: center; gap: var(--s2); min-height: 46px; padding: env(safe-area-inset-top, 0px) var(--s3) 0; border-bottom: 1px solid var(--seam); }
  .brand { background: none; border: 0; cursor: pointer; padding: 0; font: var(--w-reg) 11px var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--text-dim); }
  .sp { flex: 1; }
  .run, .off { display: inline-flex; align-items: center; gap: 7px; font-size: 9.5px; letter-spacing: .12em; text-transform: uppercase; color: var(--text); }
  .off { color: var(--text-dim); }
  .ldot { width: 6px; height: 6px; border-radius: 50%; background: var(--mercury); animation: breathe 2.4s ease-in-out infinite; }
  .odot { width: 6px; height: 6px; border-radius: 50%; background: var(--alert); }
  .gear { background: none; border: 0; color: var(--text-faint); font-size: 15px; width: 42px; height: 42px; cursor: pointer; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

  main { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }

  nav { flex: none; display: flex; align-items: stretch; border-top: 1px solid var(--seam); background: var(--bg); padding-bottom: env(safe-area-inset-bottom, 0px); }
  nav button { flex: 1; min-height: 52px; background: none; border: 0; color: var(--text-faint); font-size: 10px; letter-spacing: .18em; text-transform: uppercase; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  nav button.on { color: var(--text); }
  .badge { min-width: 17px; height: 17px; display: inline-grid; place-items: center; padding: 0 5px; border-radius: var(--pill); background: var(--alert); color: #fff; font-size: 10px; letter-spacing: 0; }
  .ranchbtn { flex: none !important; align-self: center; width: 44px; min-height: 44px !important; margin: 4px 10px; border-radius: var(--pill) !important; background: var(--paper) !important; color: var(--ink) !important; font-size: 22px !important; letter-spacing: 0 !important; line-height: 1; }

  .settings h2 { margin: 0 0 var(--s3); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: var(--w-reg); color: var(--text-faint); }
  .kv { display: flex; justify-content: space-between; gap: 12px; margin: 0; padding: 12px 0; border-bottom: 1px solid var(--seam); font-size: 13px; color: var(--text-dim); }
  .kv code { font: 12px var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .errline { color: var(--alert); font-size: 12px; }
  .unpair { margin-top: var(--s4); width: 100%; min-height: 48px; background: var(--chip); color: var(--text); border: 0; border-radius: var(--pill); font: var(--w-reg) 14px var(--sans); cursor: pointer; }
  .hint { margin-top: var(--s3); color: var(--text-faint); font-size: 11.5px; line-height: 1.5; }

  @media (prefers-reduced-motion: reduce) { .ldot { animation: none; } }
</style>
