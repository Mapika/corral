<script>
  import Chat from './Chat.svelte';
  import Files from './Files.svelte';
  import History from './History.svelte';
  import Hosts from './Hosts.svelte';
  import Sessions from './Sessions.svelte';
  import Terminal from './Terminal.svelte';
  import Tunnels from './Tunnels.svelte';
  import Dashboard from './Dashboard.svelte';
  import FleetGrid from './FleetGrid.svelte';
  import PushSettings from './PushSettings.svelte';
  import RemoteAccess from './RemoteAccess.svelte';
  import CommandPalette from './CommandPalette.svelte';
  import DirPicker from './DirPicker.svelte';
  import Toasts from './lib/Toasts.svelte';
  import Titlebar from './lib/Titlebar.svelte';
  import { toast } from './lib/toast.svelte.js';
  import { eventsSocket, listSessions, listHosts, listServerStatus, listTunnels, listQueue, launchSession, queueBounce, queueKeep, resumeSession, killSession, removeSession } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';
  import { copyOperatorBriefText, runOperatorRequest, syncIssueItems } from './lib/appShell.mjs';
  import { buildCommandItems } from './lib/commandItems.mjs';
  import { buildHostCards, needsHostStatusFollowUp } from './lib/hostHealth.mjs';
  import { isLiveSession, isResumableSession, operatorBriefText } from './lib/operatorStatus.mjs';
  import { agentLabel } from './lib/sessionView.mjs';
  import { parseRecentRoots, RECENT_ROOTS_KEY, recentRootsForHost, rememberLaunchRoot, serializeRecentRoots } from './lib/recentRoots.mjs';
  import { openExternalUrl } from './lib/externalOpen.mjs';

  let sessions = $state([]);
  let queueJobs = $state([]);        // the overnight ranch: this backend's jobs
  let hosts = $state([]);
  let hostStatuses = $state([]);
  let tunnels = $state([]);
  let localHome = $state('~');
  let selected = $state(null);
  let picker = $state(null);
  let paletteOpen = $state(false);
  let pushOpen = $state(false);
  let remoteOpen = $state(false);
  let recentRoots = $state([]);
  let returnTo = $state(null);       // chat to jump back to after a session handoff (files/terminal/tunnels)
  let dashboardFilterRequest = $state(null);
  let syncErrors = $state({ sessions: '', hosts: '', tunnels: '', hostStatus: '' });
  let hostFollowupTimer = null;
  let nextHostFollowupAt = 0;
  let handoffSeq = 0;
  let dashboardFilterSeq = 0;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || '~';
  const canResumeSession = (s) => s?.status === 'dormant' || isResumableSession(s);
  const goRunning = () => openFleet();

  let prevStatus = {};
  const inTauri = typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__;
  async function notify(s, title, body) {
    if (inTauri) {
      // Native toasts via the notification plugin — the WebView's web Notification API is
      // unreliable inside the Tauri shell.
      try {
        const n = await import('@tauri-apps/plugin-notification');
        let ok = await n.isPermissionGranted();
        if (!ok) ok = (await n.requestPermission()) === 'granted';
        if (ok) n.sendNotification({ title, body });
      } catch (e) {}
      return;
    }
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try { new Notification(title, { body, tag: s.id }).onclick = () => { window.focus(); pickChat(s); }; } catch (e) {}
  }
  function diffNotify(next) {
    for (const s of next) {
      const was = prevStatus[s.id];
      const finished = (was === 'busy' || was === 'starting') && (s.status === 'idle' || s.status === 'exited' || s.status === 'error');
      const attended = !document.hidden && selected?.kind === 'chat' && selected.id === s.id;
      if (finished && !attended) {
        const where = base(s.cwd) + (s.host !== 'local' ? ' / ' + s.host : '');
        if (s.status === 'idle') notify(s, agentLabel(s.agent) + ' is ready', where + ' finished its turn');
        else notify(s, 'Session ended', where + ' (' + s.status + ')');
      }
    }
    prevStatus = Object.fromEntries(next.map((s) => [s.id, s.status]));
  }

  // /events push channel: while it's live the server streams session/tunnel snapshots, so the
  // 4s/5s polls stand down; on disconnect they take over again until the socket reconnects
  // (exponential backoff, capped at 10s).
  let eventsWs = null;
  let eventsLive = false;
  let eventsRetry = 0;
  let eventsReconnectTimer = null;
  let eventsStopped = false;
  function connectEvents() {
    eventsWs = eventsSocket();
    eventsWs.onopen = () => { eventsRetry = 0; };
    eventsWs.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch (e) { return; }
      eventsLive = true; // frames only flow once the server accepted us
      if (msg.type === 'sessions') {
        diffNotify(msg.sessions);
        sessions = msg.sessions;
        syncErrors = { ...syncErrors, sessions: '' };
      } else if (msg.type === 'tunnels') {
        tunnels = msg.tunnels;
        syncErrors = { ...syncErrors, tunnels: '' };
      } else if (msg.type === 'queue') {
        queueJobs = msg.queue.jobs || [];
      }
    };
    eventsWs.onclose = () => {
      eventsLive = false;
      if (eventsStopped) return;
      eventsRetry += 1;
      eventsReconnectTimer = setTimeout(connectEvents, Math.min(10000, 500 * 2 ** Math.min(eventsRetry, 5)));
    };
  }

  async function poll() {
    if (eventsLive) return;
    try {
      const next = await listSessions();
      diffNotify(next);
      sessions = next;
      syncErrors = { ...syncErrors, sessions: '' };
    } catch (e) {
      syncErrors = { ...syncErrors, sessions: apiErrorMessage(e, 'Could not refresh sessions.') };
    }
    try { queueJobs = (await listQueue()).jobs || []; } catch (e) {}
  }
  async function loadHosts() {
    try {
      const h = await listHosts();
      hosts = h.hosts || [];
      localHome = h.local || '~';
      syncErrors = { ...syncErrors, hosts: '' };
    } catch (e) {
      syncErrors = { ...syncErrors, hosts: apiErrorMessage(e, 'Could not refresh hosts.') };
    }
  }
  async function loadTunnels() {
    if (eventsLive) return;
    try {
      tunnels = await listTunnels();
      syncErrors = { ...syncErrors, tunnels: '' };
    } catch (e) {
      syncErrors = { ...syncErrors, tunnels: apiErrorMessage(e, 'Could not refresh tunnels.') };
    }
  }
  function scheduleHostStatusFollowUp(next) {
    if (!needsHostStatusFollowUp(next) || hostFollowupTimer) return;
    const now = Date.now();
    if (now < nextHostFollowupAt) return;
    nextHostFollowupAt = now + 15000;
    hostFollowupTimer = setTimeout(() => {
      hostFollowupTimer = null;
      loadServerStatus();
    }, 2500);
  }
  async function loadServerStatus() {
    try {
      const next = await listServerStatus();
      hostStatuses = next;
      scheduleHostStatusFollowUp(next);
      syncErrors = { ...syncErrors, hostStatus: '' };
    } catch (e) {
      syncErrors = { ...syncErrors, hostStatus: apiErrorMessage(e, 'Could not refresh host checks.') };
    }
  }
  async function refreshAll() {
    await Promise.allSettled([poll(), loadHosts(), loadTunnels(), loadServerStatus()]);
  }
  async function initialLoad() {
    for (let i = 0; i < 12; i += 1) {
      try {
        const next = await listSessions();
        prevStatus = Object.fromEntries(next.map((s) => [s.id, s.status]));
        sessions = next;
        syncErrors = { ...syncErrors, sessions: '' };
        await Promise.allSettled([loadHosts(), loadTunnels(), loadServerStatus()]);
        return;
      } catch (e) {
        syncErrors = { ...syncErrors, sessions: apiErrorMessage(e, 'Could not refresh sessions.') };
        await sleep(500);
      }
    }
  }

  function newChat(host, start) {
    const launch = shellHostCards.find((card) => card.host === (host || 'local'));
    if (launch?.canLaunch === false) {
      toast(launch.launchBlockedLabel || 'Host is not ready for new sessions');
      return;
    }
    picker = { host, start: start || (host === 'local' ? localHome : '/') };
  }
  function saveRecentRoots(next) {
    recentRoots = next;
    try { localStorage.setItem(RECENT_ROOTS_KEY, serializeRecentRoots(next)); } catch (e) {}
  }
  async function startSession({ dir, model, perm, agent, worktree }) {
    const host = picker?.host || 'local';
    const launch = await runOperatorRequest({
      label: 'Launch',
      request: () => launchSession({ host, dir, model, perm, agent, worktree }),
      toast,
    });
    if (!launch.ok) {
      picker = { host, start: dir, launchError: launch.error };
      return;
    }
    const r = launch.result;
    picker = null;
    saveRecentRoots(rememberLaunchRoot(recentRoots, { host, dir, ts: Date.now() }));
    await poll();
    selected = { kind: 'chat', id: r.id, agent: agent || 'claude', host, cwd: dir, model: model || null, status: 'starting', sessionId: null };
  }
  const chatDesc = (s) => ({ kind: 'chat', id: s.id, agent: s.agent || 'claude', host: s.host, cwd: s.cwd, model: s.model, status: s.status, sessionId: s.sessionId, label: s.label || null });
  const pickChat = (s) => { returnTo = null; selected = chatDesc(s); };
  async function openChat(s) {
    let next = s;
    if (canResumeSession(s)) {
      const resume = await runOperatorRequest({
        label: 'Resume',
        request: () => resumeSession(s.id),
        toast,
      });
      if (!resume.ok) return;
      next = { ...s, status: 'starting' };
      await poll();
    }
    pickChat(next);
  }
  const openFiles = (host) => { returnTo = null; selected = { kind: 'files', host, path: host === 'local' ? localHome : '~' }; };
  const openSessionFiles = (session) => {
    const host = session?.host || 'local';
    selected = { kind: 'files', host, path: session?.cwd || (host === 'local' ? localHome : '~') };
    returnTo = session?.id ? chatDesc(session) : null;    // a handoff keeps one-click way back to its chat
  };
  const openTunnels = (host) => { returnTo = null; selected = { kind: 'tunnels', host }; };
  const openTerminal = (host, opts = {}) => { returnTo = null; selected = { kind: 'term', host: host || 'local', target: opts.target || null, cwd: opts.cwd || null }; };
  const openSessionTerminal = (session) => {
    openTerminal(session.host, { cwd: session.cwd });
    returnTo = session?.id ? chatDesc(session) : null;
  };
  const openHistory = () => { returnTo = null; selected = { kind: 'history', host: 'local' }; };
  const openSessions = (filter) => {
    if (filter) dashboardFilterRequest = { filter, token: ++dashboardFilterSeq };
    returnTo = null;
    selected = { kind: 'sessions', host: 'local' };
  };
  const openHosts = () => { returnTo = null; selected = { kind: 'hosts', host: 'local' }; };
  const openFleet = () => { returnTo = null; selected = { kind: 'fleet', host: 'local' }; };
  const openSessionTunnels = (session) => {
    const host = session?.host;
    if (!host || host === 'local') return;
    selected = { kind: 'tunnels', host };
    returnTo = session?.id ? chatDesc(session) : null;
  };
  const openSessionChanges = (session) => {
    if (!session?.id) return;
    returnTo = null;
    selected = { ...chatDesc(session), reviewChangesToken: ++handoffSeq };
  };
  // The overnight ranch's review gate, desktop side. Review opens the landing session with its
  // changes panel up (the session lives in the worktree, so the diff IS the landing).
  const reviewQueueJob = (job) => {
    const s = sessions.find((x) => x.id === job.sessionId);
    if (s) openSessionChanges(s);
    else toast('The landing session is gone from the herd.');
  };
  async function keepQueueJob(job) {
    try {
      const r = await queueKeep(job.id);
      if (r?.ok) toast('Kept — merged into ' + base(job.dir) + '.');
      else toast(r?.conflict ? 'Merge refused — the corral/ branch stays for a manual merge.' : 'Keep failed: ' + (r?.error || 'unknown'));
      await poll();
    } catch (e) { toast('Keep failed: ' + apiErrorMessage(e, 'unknown')); }
  }
  async function bounceQueueJob(job) {
    try {
      const r = await queueBounce(job.id);
      toast(r?.ok ? 'Bounced — worktree and branch removed.' : 'Bounce failed: ' + (r?.error || 'unknown'));
      await poll();
    } catch (e) { toast('Bounce failed: ' + apiErrorMessage(e, 'unknown')); }
  }
  async function stopSession(s) {
    try {
      await killSession(s.id);
      await poll();
    } catch (e) {
      toast('End failed: ' + apiErrorMessage(e, 'unknown'));
    }
  }
  async function clearSession(s) {
    try {
      await removeSession(s.id);
      if (selected?.kind === 'chat' && selected.id === s.id) selected = null;
      await poll();
    } catch (e) {
      toast('Remove failed: ' + apiErrorMessage(e, 'unknown'));
    }
  }
  async function copyOperatorBrief() {
    const text = operatorBriefText({ sessions, tunnels, hostCards: buildHostCards({ groups, sessions, statuses: hostStatuses }) });
    await copyOperatorBriefText(text, { toast });
  }
  async function runCommand(cmd) {
    paletteOpen = false;
    if (cmd.kind === 'view') { returnTo = null; selected = null; return; }
    if (cmd.kind === 'operator-brief') { await copyOperatorBrief(); return; }
    if (cmd.kind === 'operator-filter') {
      openSessions(cmd.filter || 'all');
      return;
    }
    if (cmd.kind === 'operator-refresh') {
      selected = null;
      await refreshAll();
      return;
    }
    if (cmd.kind === 'new-chat') { newChat(cmd.host); return; }
    if (cmd.kind === 'recent-project') { newChat(cmd.host, cmd.path); return; }
    if (cmd.kind === 'tmux-chat') { newChat(cmd.host, cmd.path); return; }
    if (cmd.kind === 'tmux-files') {
      openSessionFiles({ host: cmd.host, cwd: cmd.path });
      return;
    }
    if (cmd.kind === 'files') { openFiles(cmd.host); return; }
    if (cmd.kind === 'terminal') { openTerminal(cmd.host, { cwd: cmd.path }); return; }
    if (cmd.kind === 'tmux-attach') { openTerminal(cmd.host, { target: cmd.target }); return; }
    if (cmd.kind === 'history') { openHistory(); return; }
    if (cmd.kind === 'tunnels') { openTunnels(cmd.host); return; }
    if (cmd.kind === 'tunnel') {
      if (cmd.url) {
        const result = openExternalUrl(cmd.url);
        if (!result.ok) toast('Open failed: ' + (result.error || 'unknown'));
      }
      else openTunnels(cmd.host);
      return;
    }
    if (cmd.kind === 'session-files') {
      const s = sessions.find((x) => x.id === cmd.sessionId) || { host: cmd.host, cwd: cmd.path };
      openSessionFiles(s);
      return;
    }
    if (cmd.kind === 'session-changes') {
      const s = sessions.find((x) => x.id === cmd.sessionId);
      if (s) openSessionChanges(s);
      return;
    }
    if (cmd.kind === 'session-tunnels') {
      const s = sessions.find((x) => x.id === cmd.sessionId) || { host: cmd.host };
      openSessionTunnels(s);
      return;
    }
    if (cmd.kind === 'session-inspect') {
      const s = sessions.find((x) => x.id === cmd.sessionId);
      if (s) pickChat(s);
      return;
    }
    if (cmd.kind === 'session-remove') {
      const s = sessions.find((x) => x.id === cmd.sessionId);
      if (s) await clearSession(s);
      return;
    }
    if (cmd.kind === 'session') {
      const s = sessions.find((x) => x.id === cmd.sessionId);
      if (s) await openChat(s);
    }
  }

  let groups = $derived([{ host: 'local', label: 'This computer' }, ...hosts.map((h) => ({ host: h, label: h }))]);
  let shellHostCards = $derived(buildHostCards({ groups, sessions, statuses: hostStatuses }));
  let syncIssues = $derived(syncIssueItems(syncErrors));
  let running = $derived(sessions.filter((s) => isLiveSession(s)).length);
  let attnCount = $derived(sessions.filter((s) => s.status === 'error' || s.status === 'exited').length);
  $effect(() => {
    const count = attnCount;
    if (!inTauri) return;
    import('@tauri-apps/api/core').then(({ invoke }) => invoke('set_attention', { count }).catch(() => {})).catch(() => {});
  });
  let mainKey = $derived(selected
    ? (selected.kind === 'chat' ? 'chat:' + selected.id
      : selected.kind === 'term' ? 'term:' + selected.host + ':' + (selected.target || '') + ':' + (selected.cwd || '')
      : selected.kind + ':' + selected.host)
    : 'none');
  let crumbView = $derived(selected ? {
    name: selected.kind === 'chat' ? (selected.label || base(selected.cwd)) : selected.kind === 'term' ? (selected.target || 'terminal') : selected.kind,
    host: selected.host === 'local' ? 'this computer' : selected.host,
  } : null);
  let commandItems = $derived(buildCommandItems({ groups, sessions, tunnels, recentRoots, hostStatuses }));
  let pickerRoots = $derived(picker ? recentRootsForHost({ host: picker.host, roots: recentRoots, sessions }) : []);

  $effect(() => {
    try { recentRoots = parseRecentRoots(localStorage.getItem(RECENT_ROOTS_KEY)); } catch (e) {}
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') Notification.requestPermission();
    initialLoad();
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        paletteOpen = true;
      }
    };
    window.addEventListener('keydown', onKey);
    connectEvents();
    const sessionTimer = setInterval(poll, 4000);
    const tunnelTimer = setInterval(loadTunnels, 5000);
    const hostTimer = setInterval(loadServerStatus, 60000);
    return () => {
      window.removeEventListener('keydown', onKey);
      clearInterval(sessionTimer);
      clearInterval(tunnelTimer);
      clearInterval(hostTimer);
      clearTimeout(hostFollowupTimer);
      eventsStopped = true;
      clearTimeout(eventsReconnectTimer);
      try { eventsWs && eventsWs.close(); } catch (e) {}
    };
  });
</script>

<div class="shell">
  <Titlebar crumb={crumbView} {running}
            back={returnTo ? { label: returnTo.label || base(returnTo.cwd) } : null}
            onBack={() => { const t = returnTo; returnTo = null; selected = t; }}
            onHome={() => { returnTo = null; selected = null; }} onRunning={goRunning}
            onPush={() => (pushOpen = true)} onPhone={() => (remoteOpen = true)} />
  <div class="app">
    <main class="main">
      {#if selected}
        {#key mainKey}
          {#if selected.kind === 'chat'}
            <Chat
              session={selected}
              onOpenFiles={openSessionFiles}
              onOpenTunnels={openSessionTunnels}
              onOpenTerminal={openSessionTerminal}
              onResume={openChat}
              onclose={() => { selected = null; poll(); }}
            />
          {:else if selected.kind === 'files'}
            <Files host={selected.host} path={selected.path} onNewChat={newChat} />
          {:else if selected.kind === 'term'}
            <Terminal host={selected.host} target={selected.target} cwd={selected.cwd} />
          {:else if selected.kind === 'history'}
            <History {sessions} onOpenSession={openChat} onNewChat={newChat} />
          {:else if selected.kind === 'sessions'}
            <Sessions
              {sessions}
              filterRequest={dashboardFilterRequest}
              onNewChat={newChat}
              onOpenFiles={openFiles}
              onOpenSessionFiles={openSessionFiles}
              onOpenSessionTunnels={openSessionTunnels}
              onOpenSessionChanges={openSessionChanges}
              onInspectChat={pickChat}
              onOpenChat={openChat}
              onKillSession={stopSession}
              onRemoveSession={clearSession}
            />
          {:else if selected.kind === 'fleet'}
            <FleetGrid {sessions} onInspectChat={pickChat} onNewChat={newChat} />
          {:else if selected.kind === 'hosts'}
            <Hosts
              {groups}
              {sessions}
              {hostStatuses}
              onNewChat={newChat}
              onOpenFiles={openFiles}
              onOpenTunnels={openTunnels}
              onOpenTerminal={openTerminal}
              onOpenSessionFiles={openSessionFiles}
              onRefresh={refreshAll}
            />
          {:else}
            <Tunnels host={selected.host} />
          {/if}
        {/key}
      {:else}
        <Dashboard
          {sessions}
          {queueJobs}
          {groups}
          {tunnels}
          {recentRoots}
          {hostStatuses}
          {running}
          {syncIssues}
          onReviewJob={reviewQueueJob}
          onKeepJob={keepQueueJob}
          onBounceJob={bounceQueueJob}
          onNewChat={newChat}
          onOpenFiles={openFiles}
          onOpenTunnels={openTunnels}
          onOpenSessionFiles={openSessionFiles}
          onOpenSessionTunnels={openSessionTunnels}
          onOpenSessionChanges={openSessionChanges}
          onInspectChat={pickChat}
          onOpenChat={openChat}
          onOpenHistory={openHistory}
          onOpenSessions={openSessions}
          onOpenHosts={openHosts}
          onOpenFleet={openFleet}
          onRefresh={refreshAll}
        />
      {/if}
    </main>
  </div>
</div>

{#if picker}
  <DirPicker host={picker.host} start={picker.start} recentRoots={pickerRoots} launchError={picker.launchError || ''} onpick={startSession} oncancel={() => (picker = null)} />
{/if}

{#if paletteOpen}
  <CommandPalette items={commandItems} onclose={() => (paletteOpen = false)} onselect={runCommand} />
{/if}

{#if pushOpen}
  <PushSettings onclose={() => (pushOpen = false)} />
{/if}

{#if remoteOpen}
  <RemoteAccess onclose={() => (remoteOpen = false)} />
{/if}

<Toasts />

<style>
  .shell { display: flex; flex-direction: column; height: 100vh; }
  .app { flex: 1; min-height: 0; display: grid; grid-template-rows: minmax(0, 1fr); background: var(--bg); }

  .main { position: relative; min-width: 0; min-height: 0; overflow: hidden; }
</style>
