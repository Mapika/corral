<script>
  // The phone console: HERD (decide) · RANCH (launch) · FLEET (watch), with chat as a full-screen
  // push. Built for thumbs on the Ink system — flush surfaces, seams, one warm signal.
  import { untrack } from 'svelte';
  import { getWebPush, testWebPush, webPushSubscribe, webPushUnsubscribe } from '../lib/api.js';
  import { applicationServerKeyBytes, subscriptionParams } from '../lib/webPushClient.mjs';
  import { deepLinkTarget, releaseUpdate } from '../lib/appUpdate.mjs';
  import { reviewJobs } from '../lib/reviewQueue.mjs';
  import { clearPocket, onPocketState, pocketAvailable, pocketEnabled, pocketLoggedIn, startPocket, stopPocket } from '../lib/pocket.js';
  import { pushOverlay, showToast, toast } from './nav.svelte.js';
  import { parseRanches, RANCHES_KEY, serializeRanches, upsertRanch } from '../lib/ranches.mjs';
  import { isResumableSession } from '../lib/operatorStatus.mjs';
  import Icon from '../lib/Icon.svelte';
  import Connect from './Connect.svelte';
  import FleetFeed from './FleetFeed.svelte';
  import Herd from './Herd.svelte';
  import LaunchSheet from './LaunchSheet.svelte';
  import MobileChat from './MobileChat.svelte';
  import QueueScreen from './QueueScreen.svelte';
  import ReviewScreen from './ReviewScreen.svelte';
  import SearchScreen from './SearchScreen.svelte';
  import Sheet from './Sheet.svelte';
  import { createMobileData } from './data.svelte.js';

  let { standalone = false, initialPaired = true, pocketError = '' } = $props();

  let paired = $state(standalone ? initialPaired : true);
  let tab = $state('herd');
  let chat = $state(null);           // full-screen session descriptor
  let launchOpen = $state(false);
  let launchDir = $state('');        // prefill from a history hit ("Ranch here")
  let launchRanch = $state('');      // …on the ranch that hit came from
  let searchOpen = $state(false);
  let settingsOpen = $state(false);
  // #session=<id> / #review=<jobId> deep links — a push notification's Click target. Resolved
  // once the roster/queue knows the target, then scrubbed from the address.
  let deepLink = $state((typeof location !== 'undefined' && (location.hash.match(/[#&]session=([\w-]+)/) || [])[1]) || null);
  let reviewLink = $state((typeof location !== 'undefined' && (location.hash.match(/[#&]review=([\w-]+)/) || [])[1]) || null);
  let review = $state(null);         // full-screen review of a landed queue job
  let queueOpen = $state(false);

  // APK version + update check against GitHub releases (standalone shell only).
  const VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
  let update = $state(null);         // null | {checking} | {latest,url,newer} | {error}

  // Web Push enrolment (browser pages only — the APK webview has no push, it uses ntfy/corral://).
  let notif = $state({ supported: false, subscribed: false, busy: false, denied: false, error: '', note: '' });

  const data = createMobileData({ standalone });

  let liveCount = $derived(data.d.sessions.filter((s) => s.status === 'busy' || s.status === 'starting').length);
  let needCount = $derived(data.d.sessions.filter((s) => s.pendingPerm || s.status === 'error' || s.status === 'exited').length
    + reviewJobs(data.d.queue).length);
  let ranchCount = $derived(data.d.ranches.length);
  // Partial trouble: some ranches unreachable while others answer — worth a word in the header.
  let degraded = $derived(data.d.offlineCount > 0 && !data.d.offline);

  $effect(() => {
    if (!paired) return;
    // untracked: start() synchronously calls poll(), which READS d.live — tracked, that makes
    // this effect re-run on every socket delivery and flap the connection forever.
    untrack(() => data.start());
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
  $effect(() => {
    if (!reviewLink) return;
    const j = data.d.queue.find((x) => x.id === reviewLink);
    if (!j) return;                  // queue snapshot not in yet — re-runs when it lands
    reviewLink = null;
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) {}
    review = j;
  });

  // A push notification tapped while the console is already open: the service worker focuses
  // this window and posts the target instead of navigating.
  $effect(() => {
    if (standalone || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMsg = (e) => {
      if (!e.data) return;
      if (e.data.type === 'open-session' && e.data.session) deepLink = e.data.session;
      if (e.data.type === 'open-review' && e.data.review) reviewLink = e.data.review;
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  });

  // corral://session/<id> and corral://review/<jobId> — the APK's notification deep links. A cold
  // start arrives via getCurrent, a running app via onOpenUrl; both funnel into the same
  // roster/queue-resolved links.
  $effect(() => {
    if (!standalone || typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
    let unlisten = null, gone = false;
    (async () => {
      try {
        const { getCurrent, onOpenUrl } = await import('@tauri-apps/plugin-deep-link');
        const take = (urls) => {
          const t = deepLinkTarget(urls && urls[0]);
          if (t && t.kind === 'session') deepLink = t.id;
          if (t && t.kind === 'review') reviewLink = t.id;
        };
        take(await getCurrent());
        const un = await onOpenUrl(take);
        if (gone) un(); else unlisten = un;
      } catch (e) {}
    })();
    return () => { gone = true; try { unlisten && unlisten(); } catch (e) {} };
  });

  // Probe push state when the sheet opens: supported means a live SW registration (secure
  // origin + production build) and the Push/Notification APIs present.
  $effect(() => {
    if (!settingsOpen || standalone) return;
    (async () => {
      try {
        const apis = typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
        const reg = apis ? await navigator.serviceWorker.getRegistration() : null;
        const sub = reg ? await reg.pushManager.getSubscription() : null;
        notif = { ...notif, supported: !!reg, subscribed: !!sub, denied: apis && Notification.permission === 'denied' };
      } catch (e) {}
    })();
  });

  async function toggleNotif() {
    notif.busy = true; notif.error = ''; notif.note = '';
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) throw new Error('no service worker');
      const existing = await reg.pushManager.getSubscription();
      if (existing) {
        try { await webPushUnsubscribe(existing.endpoint); } catch (e) {}
        await existing.unsubscribe();
        notif.subscribed = false;
      } else {
        const perm = await Notification.requestPermission();
        notif.denied = perm === 'denied';
        if (perm !== 'granted') throw new Error('notifications not allowed');
        const { publicKey } = await getWebPush();
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKeyBytes(publicKey) });
        const params = subscriptionParams(sub.toJSON());
        if (!params) { await sub.unsubscribe(); throw new Error('bad subscription'); }
        await webPushSubscribe(params);
        notif.subscribed = true;
      }
    } catch (e) { notif.error = e?.message || 'push setup failed'; }
    notif.busy = false;
  }

  async function sendTestPush() {
    notif.note = ''; notif.error = '';
    try { await testWebPush(); notif.note = 'sent — should land in a moment'; }
    catch (e) { notif.error = e?.message || 'test failed'; }
  }

  async function checkUpdate() {
    update = { checking: true };
    try {
      const r = await fetch('https://api.github.com/repos/Mapika/corral/releases/latest', { headers: { accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error('GitHub said ' + r.status);
      update = releaseUpdate(await r.json(), VERSION);
    } catch (e) { update = { error: e?.message || 'update check failed' }; }
  }
  async function openRelease(url) {
    try { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); } catch (e) {}
  }

  // Pull-to-refresh on the tab scroller: cosmetic pull past 46px triggers a real refresh.
  // overscroll-behavior on <main> keeps the browser's own page-reload gesture out of the way.
  let mainEl = $state(null);
  let pull = $state(0);
  let refreshing = $state(false);
  let startY = 0, pulling = false;
  function tstart(e) {
    if (mainEl && mainEl.scrollTop <= 0) { startY = e.touches[0].clientY; pulling = true; }
  }
  function tmove(e) {
    if (!pulling || refreshing) return;
    const dy = e.touches[0].clientY - startY;
    pull = dy > 0 && mainEl.scrollTop <= 0 ? Math.min(72, dy * 0.38) : 0;
  }
  async function tend() {
    if (!pulling) return;
    pulling = false;
    if (pull > 46 && !refreshing) {
      refreshing = true;
      try { navigator.vibrate?.(8); } catch (e) {}
      await Promise.allSettled([data.poll(), data.loadHosts()]);
      refreshing = false;
    }
    pull = 0;
  }

  // ranchName rides along only when there's something to disambiguate — one ranch, no chrome.
  const chatDesc = (s) => ({ kind: 'chat', id: s.id, ranch: s.ranch, ranchName: ranchCount > 1 ? s.ranchName : null, agent: s.agent || 'claude', host: s.host, cwd: s.cwd, model: s.model, status: s.status, sessionId: s.sessionId, label: s.label || null });
  async function openSession(s) {
    let next = s;
    if (s.status === 'dormant' || isResumableSession(s)) {
      try {
        const r = await data.clientFor(s.ranch).resumeSession(s.id);
        if (r?.ok === false) return;
        next = { ...s, status: 'starting' };
        await data.poll();
      } catch (e) { return; }
    }
    chat = chatDesc(next);
  }
  // A review job's transcript: resolve its session in the merged roster (same ranch), then the
  // normal open path (resumes a dormant one) takes over.
  function openReviewSession(j) {
    const s = data.d.sessions.find((x) => x.id === j.sessionId && x.ranch === j.ranch);
    if (s) openSession(s);
    else showToast('The session is no longer in the herd.');
  }
  let pocketOn = $state(pocketEnabled());

  // First pairing (boot Connect): the data layer isn't running yet, so seed the roster in
  // storage directly; start() reads it. A pocket "Run on this phone" arrives with no ranch info.
  function bootPaired(info) {
    if (info) {
      try {
        const list = upsertRanch(parseRanches(localStorage.getItem(RANCHES_KEY)), { ...info, now: Date.now() }).list;
        localStorage.setItem(RANCHES_KEY, serializeRanches(list));
      } catch (e) {}
    }
    paired = true;
    pocketOn = pocketEnabled();
  }

  // Ranch N+1, added from settings while everything is live.
  let addOpen = $state(false);
  function addPaired(info) {
    addOpen = false;
    if (!info) return;
    const { ranch, refreshed } = data.addRanch(info);
    showToast(refreshed ? ranch.name + ' was already paired — pairing key refreshed.' : 'Paired with ' + ranch.name + '.');
  }

  // Per-ranch renames, inline in the settings sheet.
  let renamingRanch = $state(null);       // ranch id under edit
  let ranchDraft = $state('');
  function saveRanchName(r) {
    const next = ranchDraft.trim();
    renamingRanch = null;
    if (next && next !== r.name) data.renameRanchById(r.id, next);
  }

  // Wake-on-LAN (0.8): any live sibling broadcasts the magic packet for the sleeper's
  // remembered MACs. Machines take a beat to boot — say so instead of pretending it's instant.
  let wakingRanch = $state(null);
  async function wakeRanchRow(r) {
    wakingRanch = r.id;
    const res = await data.wakeRanch(r.id);
    wakingRanch = null;
    showToast(res.ok ? 'Magic packet sent — give it ~30 seconds.' : 'Could not wake: ' + res.error);
  }

  function unpairRanch(r) {
    if (r.kind === 'pocket') {
      clearPocket();
      pocketOn = false;
      data.removeRanchById(r.id);
      stopPocket();
    } else {
      data.removeRanchById(r.id);
      showToast('Unpaired from ' + r.name + '.');
    }
    if (standalone && data.d.ranches.length === 0) { settingsOpen = false; paired = false; }
  }

  // Watchdog signal: the shell restarts a crashed on-device backend and reports over pocket-state
  // (pocket.js refreshes its base/token; here we surface it and refresh the roster).
  let pocketRanch = $derived(data.d.ranches.find((r) => r.kind === 'pocket') || null);
  let pocketDown = $state(false);
  let pocketRestarting = $state(false);
  $effect(() => {
    if (!pocketOn) return;
    return onPocketState((p) => {
      pocketDown = !p.running;
      if (p.running) { data.poll(); claudeAuthed = null; probeAuth(); }
    });
  });
  // Pocket can join the herd later, from settings (e.g. the phone started out pair-only).
  let pocketAvail = $state(false);
  let pocketStarting = $state(false);
  $effect(() => { if (settingsOpen && standalone && !pocketOn) pocketAvailable().then((ok) => (pocketAvail = ok)); });
  async function runPocketFromSettings() {
    pocketStarting = true;
    try {
      await startPocket();
      pocketOn = true;
      data.attachPocket();
      probeAuth();
    } catch (e) { showToast('Could not start the on-device backend' + (e?.message ? ' — ' + e.message : '.')); }
    finally { pocketStarting = false; }
  }

  // Manual restart for when the watchdog gave up (or the app just woke to a dead backend).
  async function restartPocket() {
    pocketRestarting = true;
    try { await startPocket(); pocketDown = false; await data.poll(); }
    catch (e) { showToast('Restart failed' + (e?.message ? ' — ' + e.message : '')); }
    finally { pocketRestarting = false; }
  }

  // Claude auth on this phone: probed (a file check in the shell), not assumed — the Herd nudge
  // and the settings section both key off it. null = unknown/not applicable.
  let claudeAuthed = $state(null);
  async function probeAuth() {
    if (!standalone || !pocketOn) return;
    claudeAuthed = await pocketLoggedIn();
  }
  $effect(() => { if (pocketOn) probeAuth(); });

  // Claude login for pocket mode: OAuth manual paste-back driven by pocket_login/-_code in the
  // shell (credentials land in the app-private HOME — no other way in from outside the app).
  let login = $state({ busy: false, url: '', code: '', msg: '', error: '' });
  async function loginStart() {
    login = { ...login, busy: true, error: '', msg: '' };
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const out = await invoke('pocket_login');
      const url = (String(out).match(/https:\/\/\S+/) || [''])[0];
      if (!url) throw new Error('no login URL in output');
      login = { ...login, busy: false, url };
    } catch (e) {
      login = { ...login, busy: false, error: String(e?.message || e) };
    }
  }
  async function openLoginUrl(url) {
    try { const { openUrl } = await import('@tauri-apps/plugin-opener'); await openUrl(url); } catch (e) {}
  }
  async function loginSubmit() {
    login = { ...login, busy: true, error: '' };
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('pocket_login_code', { code: login.code });
      login = { busy: false, url: '', code: '', msg: 'Signed in — Claude is ready on this phone.', error: '' };
      claudeAuthed = true;
    } catch (e) {
      login = { ...login, busy: false, error: String(e?.message || e) };
    }
  }

  // Share -> Corral: MainActivity stashed the payload in the bridge (files already copied to
  // ~/shared); drain it on mount and on every return to the foreground, and turn it into a
  // prefilled launch — the user picks the project and taps go.
  let sharedBrief = $state('');
  async function takeShared() {
    if (!standalone || typeof window === 'undefined' || !window.__TAURI_INTERNALS__) return;
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const raw = await invoke('pocket_take_shared');
      if (!raw) return;
      const s = JSON.parse(raw);
      const lines = [];
      if (s.subject) lines.push(s.subject);
      if (s.text) lines.push(s.text);
      for (const f of s.files || []) lines.push('Shared file: ' + f);
      if (!lines.length) return;
      sharedBrief = lines.join('\n');
      launchOpen = true;
    } catch (e) {}
  }
  $effect(() => {
    takeShared();
    const onVis = () => { if (document.visibilityState === 'visible') takeShared(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  });

  // Hardware back peels overlays (sheets register themselves via Sheet; chat and search are
  // full-screen pushes, so they register here where their state lives).
  $effect(() => {
    if (!chat) return;
    return pushOverlay(() => { chat = null; data.poll(); });
  });
  $effect(() => {
    if (!searchOpen) return;
    return pushOverlay(() => (searchOpen = false));
  });
</script>

{#if standalone && !paired}
  <Connect onPaired={bootPaired} initialError={pocketError} />
{:else}
  <div class="mshell">
    <header class="top">
      <button class="brand" onclick={() => (tab = 'herd')}>corral</button>
      <span class="sp"></span>
      {#if data.d.offline}
        <span class="off"><span class="odot"></span>offline</span>
      {:else if degraded}
        <span class="off"><span class="odot"></span>{data.d.offlineCount} of {ranchCount} offline</span>
      {:else if data.d.loaded && !data.d.live}
        <span class="off"><span class="pdot2"></span>polling</span>
      {:else if liveCount}
        <span class="run"><span class="ldot"></span>{liveCount} running</span>
      {/if}
      <button class="gear" onclick={() => (searchOpen = true)} aria-label="Search history"><Icon name="search" size={15} /></button>
      <button class="gear" onclick={() => (settingsOpen = true)} aria-label="Settings"><Icon name="kebab" size={16} stroke={2.75} /></button>
    </header>

    {#if pocketOn && (pocketDown || pocketRanch?.offline)}
      <button class="nudge" onclick={restartPocket} disabled={pocketRestarting}>
        <span class="odot"></span>
        {pocketRestarting ? 'restarting…' : pocketDown ? 'the on-device backend is down — tap to restart' : 'not responding — tap to restart'}
      </button>
    {:else if pocketOn && claudeAuthed === false}
      <button class="nudge" onclick={() => (settingsOpen = true)}>
        <span class="odot"></span>
        Claude isn't signed in on this phone — tap to log in
      </button>
    {/if}

    <main bind:this={mainEl} ontouchstart={tstart} ontouchmove={tmove} ontouchend={tend} ontouchcancel={tend}>
      {#if pull > 0 || refreshing}
        <div class="ptr" style:height="{refreshing ? 40 : pull}px" aria-hidden="true">
          <span class="pdot" class:armed={pull > 46 || refreshing} class:spin={refreshing}></span>
        </div>
      {/if}
      {#if tab === 'herd'}
        <Herd {data} onOpenSession={openSession} onLaunch={() => (launchOpen = true)}
          onOpenReview={(j) => (review = j)} onOpenQueue={() => (queueOpen = true)} />
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
      {#key (chat.ranch || '') + ':' + chat.id}
        <MobileChat session={chat} client={data.clientFor(chat.ranch)} onclose={() => { chat = null; data.poll(); }} onchanged={() => data.poll()} />
      {/key}
    {/if}

    {#if queueOpen}
      <QueueScreen {data} onclose={() => (queueOpen = false)} onOpenReview={(j) => (review = j)} />
    {/if}

    {#if review}
      {#key (review.ranch || '') + ':' + review.id}
        <ReviewScreen job={review} client={data.clientFor(review.ranch)}
          onclose={() => (review = null)} onchanged={() => data.poll()}
          onOpenSession={(j) => { review = null; queueOpen = false; openReviewSession(j); }} />
      {/key}
    {/if}

    {#if searchOpen}
      <SearchScreen {data}
        onclose={() => (searchOpen = false)}
        onOpenSession={(s) => { searchOpen = false; openSession(s); }}
        onRanchAt={(cwd, ranch) => { searchOpen = false; launchDir = cwd; launchRanch = ranch || ''; launchOpen = true; }} />
    {/if}

    {#if launchOpen}
      {#key launchDir + launchRanch + sharedBrief}
        <LaunchSheet {data} initialDir={launchDir} initialRanch={launchRanch} initialBrief={sharedBrief}
          onclose={() => { launchOpen = false; launchDir = ''; launchRanch = ''; sharedBrief = ''; }}
          onLaunched={(desc) => { launchOpen = false; launchDir = ''; launchRanch = ''; sharedBrief = ''; chat = desc; }} />
      {/key}
    {/if}

    {#if settingsOpen}
      <Sheet onclose={() => (settingsOpen = false)} label="Settings">
        <div class="settings">
          <h2>{ranchCount === 1 ? 'Ranch' : 'Ranches'}</h2>
          {#each data.d.ranches as r (r.id)}
            <div class="ranchrow">
              {#if renamingRanch === r.id}
                <div class="renamerow">
                  <!-- svelte-ignore a11y_autofocus -->
                  <input bind:value={ranchDraft} autofocus maxlength="40"
                         onkeydown={(e) => { if (e.key === 'Enter') saveRanchName(r); }} />
                  <button class="savebtn" onclick={() => saveRanchName(r)}>Save</button>
                </div>
              {:else}
                <button class="rmain" onclick={() => { renamingRanch = r.id; ranchDraft = r.name; }} title="Rename">
                  <span class="rdot" class:live={r.live} class:down={r.offline}></span>
                  <span class="rname">{r.name}</span>
                  <code class="rbase">{r.kind === 'pocket' ? 'this phone' : r.kind === 'origin' ? 'this device' : r.base.replace(/^https?:\/\//, '')}</code>
                </button>
                {#if r.offline && (r.macs || []).length && data.d.ranches.some((x) => x.id !== r.id && !x.offline)}
                  <button class="rkill" onclick={() => wakeRanchRow(r)} disabled={wakingRanch === r.id}>{wakingRanch === r.id ? 'waking…' : 'wake'}</button>
                {/if}
                {#if r.kind !== 'origin'}
                  <button class="rkill" onclick={() => unpairRanch(r)}>{r.kind === 'pocket' ? 'stop' : 'unpair'}</button>
                {/if}
              {/if}
            </div>
            {#if r.offline && r.error}<p class="errline">{r.error}</p>{/if}
          {/each}
          <button class="unpair checkupd" onclick={() => { settingsOpen = false; addOpen = true; }}>Add a ranch</button>
          {#if standalone && !pocketOn && pocketAvail}
            <button class="unpair checkupd" onclick={runPocketFromSettings} disabled={pocketStarting}>{pocketStarting ? 'Starting…' : 'Run Corral on this phone'}</button>
          {/if}
          {#if !standalone}
            <h2 class="apph">Notifications</h2>
            {#if !notif.supported}
              <p class="hint">Push needs a secure origin — pair over HTTPS (Transport in the pairing dialog) to get buzzed without the ntfy app.</p>
            {:else if notif.denied && !notif.subscribed}
              <p class="hint">Notifications are blocked for this site — allow them in the browser's site settings, then try again.</p>
            {:else}
              <button class="unpair checkupd" onclick={toggleNotif} disabled={notif.busy}>
                {notif.busy ? 'working…' : notif.subscribed ? 'Disable push on this phone' : 'Enable push on this phone'}
              </button>
              {#if notif.subscribed}
                <button class="testpush" onclick={sendTestPush}>Send a test</button>
              {/if}
            {/if}
            {#if notif.error}<p class="errline">{notif.error}</p>{/if}
            {#if notif.note}<p class="hint">{notif.note}</p>{/if}
          {/if}
          {#if standalone && pocketOn}
            <h2 class="apph">Claude</h2>
            {#if claudeAuthed}
              <p class="kv"><span>Account</span><code>signed in</code></p>
            {/if}
            {#if !login.url}
              <button class="unpair checkupd" onclick={loginStart} disabled={login.busy}>{login.busy ? 'starting…' : claudeAuthed ? 'Log in again' : 'Log in to Claude'}</button>
            {:else}
              <button class="getupd" onclick={() => openLoginUrl(login.url)}>Open the login page</button>
              <p class="hint">Approve there, copy the code, paste it below.</p>
              <input class="logincode" bind:value={login.code} placeholder="paste the code"
                     autocapitalize="off" autocorrect="off" spellcheck="false" />
              <button class="unpair checkupd" onclick={loginSubmit} disabled={login.busy || !login.code.trim()}>{login.busy ? 'signing in…' : 'Submit code'}</button>
            {/if}
            {#if login.msg}<p class="hint">{login.msg}</p>{/if}
            {#if login.error}<p class="errline">{login.error}</p>{/if}
          {/if}
          {#if standalone}
            <h2 class="apph">App</h2>
            <p class="kv"><span>Version</span><code>v{VERSION}</code></p>
            <button class="unpair checkupd" onclick={checkUpdate} disabled={update?.checking}>{update?.checking ? 'checking…' : 'Check for updates'}</button>
            {#if update && !update.checking}
              {#if update.error}
                <p class="errline">{update.error}</p>
              {:else if update.newer}
                <button class="getupd" onclick={() => openRelease(update.url)}>Get v{update.latest} from GitHub</button>
              {:else if update.latest}
                <p class="hint">v{update.latest} is the latest — you're current.</p>
              {/if}
            {/if}
          {/if}
          <p class="hint">Phone push (ntfy) and remote access are configured on the desktop app.</p>
        </div>
      </Sheet>
    {/if}

    {#if addOpen}
      <Sheet onclose={() => (addOpen = false)} label="Add a ranch">
        <Connect mode="add" onPaired={addPaired} />
      </Sheet>
    {/if}

    {#if toast.msg}
      <div class="toast" role="status">{toast.msg}</div>
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
  .gear { background: none; border: 0; color: var(--text-faint); font-size: 15px; width: 42px; height: 42px; cursor: pointer; display: inline-grid; place-items: center; }
  .pdot2 { width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); animation: breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

  .nudge { flex: none; display: flex; align-items: center; gap: 9px; width: 100%; min-height: 40px; padding: 0 var(--s3); background: var(--surface); border: 0; border-bottom: 1px solid var(--seam); color: var(--text-dim); font: var(--w-reg) 12px var(--sans); text-align: left; cursor: pointer; }
  .nudge:disabled { opacity: .6; }

  .toast { position: fixed; left: 50%; bottom: calc(72px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); z-index: 50; max-width: 86vw; background: var(--paper); color: var(--ink); font: var(--w-med) 12.5px var(--sans); padding: 11px 18px; border-radius: var(--pill); box-shadow: 0 4px 24px rgba(0,0,0,.35); animation: fade .16s ease both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }

  main { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .ptr { display: grid; place-items: center; overflow: hidden; transition: height .18s ease; }
  .pdot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-faint); transition: background .12s, transform .12s; }
  .pdot.armed { background: var(--mercury); transform: scale(1.25); }
  .pdot.spin { animation: breathe 1s ease-in-out infinite; }

  nav { flex: none; display: flex; align-items: stretch; border-top: 1px solid var(--seam); background: var(--bg); padding-bottom: env(safe-area-inset-bottom, 0px); }
  nav button { flex: 1; min-height: 52px; background: none; border: 0; color: var(--text-faint); font-size: 10px; letter-spacing: .18em; text-transform: uppercase; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }
  nav button.on { color: var(--text); }
  .badge { min-width: 17px; height: 17px; display: inline-grid; place-items: center; padding: 0 5px; border-radius: var(--pill); background: var(--alert); color: #fff; font-size: 10px; letter-spacing: 0; }
  .ranchbtn { flex: none !important; align-self: center; width: 44px; min-height: 44px !important; margin: 4px 10px; border-radius: var(--pill) !important; background: var(--paper) !important; color: var(--ink) !important; font-size: 22px !important; letter-spacing: 0 !important; line-height: 1; }

  .settings h2 { margin: 0 0 var(--s3); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: var(--w-reg); color: var(--text-faint); }
  .ranchrow { display: flex; align-items: stretch; border-bottom: 1px solid var(--seam); }
  .rmain { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 2px; background: none; border: 0; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .rdot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
  .rdot.live { background: var(--mercury); }
  .rdot.down { background: var(--alert); }
  .rname { flex: none; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 14px; font-weight: var(--w-med); }
  .rbase { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: right; color: var(--text-faint); font: 11px var(--mono); }
  .rkill { flex: none; background: none; border: 0; color: var(--text-dim); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; padding: 0 2px 0 14px; cursor: pointer; }
  .rkill:active { color: var(--alert); }
  .renamerow { flex: 1; display: flex; gap: 10px; align-items: center; padding: 8px 0; }
  .renamerow input { flex: 1; min-width: 0; background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: 16px var(--sans); padding: 11px 13px; }
  .renamerow input:focus { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .savebtn { flex: none; min-height: 42px; border: 0; background: var(--paper); color: var(--ink); border-radius: var(--pill); padding: 0 18px; font: var(--w-med) 13px var(--sans); cursor: pointer; }
  .kv { display: flex; justify-content: space-between; gap: 12px; margin: 0; padding: 12px 0; border-bottom: 1px solid var(--seam); font-size: 13px; color: var(--text-dim); }
  .kv code { font: 12px var(--mono); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .errline { color: var(--alert); font-size: 12px; }
  .unpair { margin-top: var(--s4); width: 100%; min-height: 48px; background: var(--chip); color: var(--text); border: 0; border-radius: var(--pill); font: var(--w-reg) 14px var(--sans); cursor: pointer; }
  .apph { margin-top: var(--s5) !important; }
  .checkupd { margin-top: var(--s3); }
  .checkupd:disabled { opacity: .6; }
  .getupd { margin-top: var(--s3); width: 100%; min-height: 48px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); font: var(--w-med) 14px var(--sans); cursor: pointer; }
  .testpush { margin-top: var(--s2); width: 100%; min-height: 44px; background: none; border: 0; color: var(--text-dim); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; cursor: pointer; }
  .hint { margin-top: var(--s3); color: var(--text-faint); font-size: 11.5px; line-height: 1.5; }
  .logincode { margin-top: var(--s3); width: 100%; background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: 16px var(--mono); padding: 14px; }
  .logincode:focus { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .logincode::placeholder { color: var(--text-faint); }

  @media (prefers-reduced-motion: reduce) { .ldot { animation: none; } }
</style>
