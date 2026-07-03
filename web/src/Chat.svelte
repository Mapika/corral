<script>
  import { chatSocket, killSession, removeSession, gitDiff, setSessionLabel, uploadFile } from './lib/api.js';
  import { apiErrorMessage } from './lib/apiRequest.mjs';
  import { createChatState, handleChatEvent } from './lib/chatStream.mjs';
  import { renderMarkdown, highlightCode } from './lib/markdown.js';
  import { prettyModel } from './lib/format.js';
  import { buildChangeCopyText, buildChangeReviewPrompt, changeSummaryLabel, copyChangeSummaryText } from './lib/changeSummary.mjs';
  import { uploadMessage } from './lib/fileUploads.mjs';
  import { chatHandoffs } from './lib/sessionHandoffs.mjs';
  import { agentLabel, canSubmitMessage, composerPlaceholder, composerSubmitState, sessionEndAction, sessionHostLabel, sessionPathParts, sessionResumeAction, sessionStatusView } from './lib/sessionView.mjs';
  import { toast } from './lib/toast.svelte.js';
  import Files from './Files.svelte';
  import Terminal from './Terminal.svelte';
  import Icon from './lib/Icon.svelte';

  import { untrack } from 'svelte';

  let { session, onOpenFiles, onOpenTunnels, onOpenTerminal, onResume, onclose } = $props();   // session: { id, host, cwd, model, status }; onclose() when removed

  let cs = $state(createChatState());    // transcript + stream state (lib/chatStream.mjs)
  let draft = $state('');
  let atts = $state([]);                 // composer attachments: { name, pct, done, error }
  let dragOver = $state(false);
  let scrollEl;
  let composerEl;
  let ws = null;
  let disconnected = $state(false);      // stream dropped; reconnect loop is running
  let changes = $state(null);            // git-diff drawer: null = closed, else { loading } | { isRepo, diff, untracked }
  let filesOpen = $state(false);         // files drawer — browse the session cwd without leaving the chat
  let termOpen = $state(false);          // terminal drawer — a shell in the session cwd over the chat
  let lastChangeRequest = $state(null);
  // svelte-ignore state_referenced_locally
  let label = $state(session?.label || null);    // operator-assigned session name (roster-persisted)
  let editingLabel = $state(false);
  let labelDraft = $state('');

  let statusKey = $derived(cs.status || session?.status || '');
  let model = $derived(cs.model);
  let usage = $derived(cs.usage);
  let ended = $derived(statusKey === 'error' || statusKey === 'exited');
  let pathParts = $derived(sessionPathParts(session?.cwd));
  let hostLabel = $derived(sessionHostLabel(session?.host));
  let statusView = $derived(sessionStatusView(statusKey));
  let resumeAction = $derived(onResume ? sessionResumeAction({ ...(session || {}), status: statusKey }) : null);
  let endAction = $derived(sessionEndAction({ ...(session || {}), status: statusKey }));
  let changeLabel = $derived(changes ? changeSummaryLabel(changes) : '');
  let changeCopyText = $derived(changes ? buildChangeCopyText(changes) : '');
  let changeReviewPrompt = $derived(changes ? buildChangeReviewPrompt(changes, session?.cwd) : '');
  let canDraftReview = $derived(!!changeReviewPrompt && canSubmitMessage({ status: statusKey, ended }));
  let handoffs = $derived(chatHandoffs(session));

  const hlDiff = (t) => highlightCode(t, 'diff');
  async function openChanges() {
    const target = { host: session?.host, cwd: session?.cwd };
    filesOpen = false; termOpen = false; // one drawer at a time
    changes = { loading: true };
    try {
      const next = await gitDiff(target.host, target.cwd);
      if (session?.host === target.host && session?.cwd === target.cwd) changes = next;
    } catch (e) {
      if (session?.host === target.host && session?.cwd === target.cwd) changes = { isRepo: false };
    }
  }
  async function copyChanges() {
    if (!changeCopyText) return;
    await copyChangeSummaryText(changeCopyText, { toast });
  }
  function draftReviewPrompt() {
    if (!changeReviewPrompt) return;
    draft = changeReviewPrompt;
    changes = null;
    queueMicrotask(() => {
      composerEl?.focus();
      fitComposer(composerEl);
    });
  }

  const scrollDown = () => { if (scrollEl) queueMicrotask(() => { scrollEl.scrollTop = scrollEl.scrollHeight; }); };

  // The transcript state machine lives in lib/chatStream.mjs (shared with the mobile console);
  // it returns true whenever the view should follow the new content down.
  function handle(ev) {
    if (handleChatEvent(cs, ev, renderMarkdown)) scrollDown();
  }

  // --- usage readout (#5) ---
  const fmtTok = (n) => n == null ? '' : n < 1000 ? String(n) : (n / 1000).toFixed(n < 10000 ? 1 : 0) + 'k';
  const fmtCost = (c) => c == null ? '' : '$' + (c < 1 ? c.toFixed(3) : c.toFixed(2));

  // --- composer attachments (#2): paste/drop a file -> upload into the session cwd, reference it by
  // path on send so the agent (running in that cwd) can Read it. ponytail: dropped files land in the
  // session's working dir as-is; add an uploads/ subdir if cluttering the repo becomes a problem.
  async function addFiles(fileList) {
    for (const f of [...fileList]) {
      let name = f.name || 'pasted.png';
      if (!f.name || atts.some((a) => a.name === name)) {     // uniquify nameless pastes / collisions
        const dot = name.lastIndexOf('.'), ext = dot > 0 ? name.slice(dot) : '', stem = dot > 0 ? name.slice(0, dot) : name;
        name = stem + '-' + Date.now().toString(36).slice(-4) + ext;
      }
      atts.push({ name, pct: 0, done: false, error: false, message: '' });
      const rec = atts[atts.length - 1];   // the $state proxy — mutating the raw object is invisible to the UI
      try {
        const r = await uploadFile(session.host, session.cwd, f, (p) => (rec.pct = p), name);
        if (r && r.ok) rec.done = true; else { rec.error = true; rec.message = uploadMessage(r); toast('Upload failed: ' + name); }
      } catch (e) { rec.error = true; rec.message = uploadMessage(e); toast('Upload failed: ' + name); }
    }
  }
  const removeAtt = (rec) => { atts = atts.filter((a) => a !== rec); };
  function onPaste(e) { const fs = e.clipboardData?.files; if (fs && fs.length) { e.preventDefault(); addFiles(fs); } }
  function onDrop(e) { e.preventDefault(); dragOver = false; if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); }

  let submitState = $derived(composerSubmitState({ status: statusKey, ended, draft, attachments: atts }));
  let canSend = $derived(submitState.canSend);
  let composerHint = $derived(submitState.hint || 'Enter to send / Shift+Enter for a new line / paste or drop a file to attach');

  function send() {
    const t = draft.trim();
    const ready = atts.filter((a) => a.done);
    if (!canSubmitMessage({ status: statusKey, ended })) return;
    if (!canSend || !ws || ws.readyState !== 1) return;
    const refs = ready.map((a) => 'Attached file: ./' + a.name).join('\n');
    const text = refs ? refs + (t ? '\n\n' + t : '') : t;
    ws.send(JSON.stringify({ type: 'input', text }));
    draft = ''; atts = [];
  }
  function stop() { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'interrupt' })); cs.stopped = true; } }
  function startLabelEdit() { labelDraft = label || pathParts.project; editingLabel = true; }
  async function saveLabel() {
    if (!editingLabel) return;
    editingLabel = false;
    const next = labelDraft.trim().slice(0, 60);
    const effective = next && next !== pathParts.project ? next : null;   // folder name = no label
    if (effective === label) return;
    try {
      await setSessionLabel(session.id, effective || '');
      label = effective;
    } catch (e) { toast('Rename failed: ' + apiErrorMessage(e, 'unknown')); }
  }
  function respondPerm(item, decision) {
    if (item.resolved || !ws || ws.readyState !== 1) return;
    item.resolved = decision;              // optimistic; the server echoes _permission_resolved
    ws.send(JSON.stringify({ type: 'permission', requestId: item.id, decision }));
  }
  function primary() { if (statusKey === 'busy') stop(); else send(); }
  function runHandoff(action) {
    if (action.kind === 'files') { filesOpen = !filesOpen; if (filesOpen) { changes = null; termOpen = false; } }
    else if (action.kind === 'terminal') { termOpen = !termOpen; if (termOpen) { changes = null; filesOpen = false; } }
    else if (action.kind === 'tunnels') onOpenTunnels?.(session);
  }
  function onKey(e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }
  function fitComposer(ta = composerEl) {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
  }
  function grow(e) { fitComposer(e.target); }

  async function endOrRemove() {
    if (!endAction) return;
    if (endAction.kind === 'remove') {
      try {
        await removeSession(session.id);
        onclose && onclose();
      } catch (e) {
        toast('Remove failed: ' + apiErrorMessage(e, 'unknown'));
      }
    } else if (endAction.kind === 'kill') {
      try { await killSession(session.id); }
      catch (e) { toast('End failed: ' + apiErrorMessage(e, 'unknown')); }
    }
  }

  // (Re)connect whenever the selected session changes; if the stream drops, reconnect with
  // backoff. The server replays scrollback on every attach, so transcript state resets per
  // connection — the draft and attachments survive a reconnect untouched.
  $effect(() => {
    const id = session?.id;
    if (!id) return;
    let sock = null, retryTimer = null, retries = 0, gone = false;
    const connect = () => {
      cs = createChatState();
      cs.status = session.status || ''; cs.model = session.model || null;
      sock = chatSocket(id);
      ws = sock;
      sock.onopen = () => { retries = 0; disconnected = false; };
      sock.onmessage = (e) => { let ev; try { ev = JSON.parse(e.data); } catch (x) { return; } handle(ev); };
      sock.onclose = () => {
        if (gone) return;
        disconnected = true;
        if (cs.status !== 'error' && cs.status !== 'exited') cs.status = '';
        retries += 1;
        retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(retries, 4)));
      };
    };
    atts = []; dragOver = false; disconnected = false; filesOpen = false; termOpen = false;
    // untracked: connect() reassigns/reads `cs`, which must not become a dependency of this
    // effect — the effect keys on the session id alone, or it would loop on its own writes.
    untrack(() => connect());
    return () => { gone = true; clearTimeout(retryTimer); try { sock && sock.close(); } catch (x) {} };
  });

  $effect(() => {
    const token = session?.reviewChangesToken;
    if (!token || token === lastChangeRequest) return;
    lastChangeRequest = token;
    openChanges();
  });
</script>

<div class="chat">
  <header class="chead">
    <div class="identity">
      <span class="hpip"></span>
      <span class="hostchip" title={hostLabel}>{hostLabel}</span>
      {#if session.agent && session.agent !== 'claude'}<span class="hostchip" title="Agent">{agentLabel(session.agent)}</span>{/if}
      <div class="pathstack">
        {#if editingLabel}
          <!-- svelte-ignore a11y_autofocus -->
          <input class="labelin" bind:value={labelDraft} autofocus aria-label="Session name"
                 onkeydown={(e) => { if (e.key === 'Enter') saveLabel(); else if (e.key === 'Escape') (editingLabel = false); }}
                 onblur={saveLabel} />
        {:else}
          <span class="project" title={pathParts.path}>{label || pathParts.project}</span>
        {/if}
        <span class="cwd" title={pathParts.path}>{pathParts.path}</span>
      </div>
      {#if !editingLabel}
        <button class="lblbtn" title="Rename session" aria-label="Rename session" onclick={startLabelEdit}><Icon name="pencil" size={12} /></button>
      {/if}
    </div>
    <div class="sessionmeta">
      {#if model}<span class="model">{prettyModel(model)}</span>{/if}
      {#if usage}<span class="usage" title="last turn tokens / session cost">{#if usage.in != null}{fmtTok(usage.in)} in {/if}{#if usage.out != null}{fmtTok(usage.out)} out{/if}{#if usage.cost != null} / {fmtCost(usage.cost)}{/if}</span>{/if}
    </div>
    <span class="sp"></span>
    <span class="stat {statusView.tone}" title={statusView.detail}><span class="lamp"></span>{statusView.label}</span>
    {#if resumeAction}
      <button class="headbtn resumebtn" onclick={() => onResume?.(session)} title={resumeAction.title} aria-label="{resumeAction.label} {pathParts.project}">
        <Icon name="up" size={14} />
        <span>{resumeAction.label}</span>
      </button>
    {/if}
    {#each handoffs as action (action.kind)}
      <button class="headbtn" onclick={() => runHandoff(action)} title={action.title}>
        <Icon name={action.kind === 'files' ? 'folder' : action.kind === 'terminal' ? 'terminal' : 'swap'} size={14} />
        <span>{action.label}</span>
      </button>
    {/each}
    <button class="headbtn changesbtn" onclick={openChanges} title="Review file changes in this directory">
      <Icon name="file" size={14} />
      <span>Changes</span>
    </button>
    {#if endAction}
      <button class="headbtn endbtn" class:danger={endAction.danger} onclick={endOrRemove} title={endAction.title}>
        <Icon name={endAction.icon} size={14} />
        <span>{endAction.label}</span>
      </button>
    {/if}
  </header>

  <div class="scroll" bind:this={scrollEl}>
    <div class="col">
      {#if cs.items.length === 0}
        <div class="emptyturn">
          <span class="estate {statusView.tone}"><span class="lamp"></span>{statusView.label}</span>
          <b>{pathParts.project}</b>
          <span>{hostLabel}{#if model} / {prettyModel(model)}{/if} / {statusView.detail}</span>
        </div>
      {/if}
      {#each cs.items as it (it)}
        {#if it.kind === 'op'}
          <div class="turn op">
            <div class="eyebrow"><span class="pip"></span>You</div>
            <div class="body">{it.text}</div>
          </div>
        {:else if it.kind === 'asst'}
          <div class="turn asst">
            <div class="eyebrow"><span class="pip"></span>{model ? prettyModel(model) : agentLabel(session.agent)}</div>
            {#each it.blocks as b}
              {#if b.type === 'text'}
                <div class="prose">{@html b.html}</div>
              {:else if b.type === 'thinking'}
                {#if b.text && b.text.trim()}
                  <details class="think" bind:open={b.open}>
                    <summary>Thinking</summary>
                    <div class="t">{b.text}</div>
                  </details>
                {/if}
              {:else if b.type === 'tool'}
                <div class="tool" class:open={b.open}>
                  <button class="thead" onclick={() => (b.open = !b.open)}>
                    <span class="glyph"><Icon name="chevron" size={13} /></span>
                    <span class="tname">{b.name}</span>
                    <span class="tsum">{b.summary}</span>
                  </button>
                  {#if b.open}
                    <div class="det">
                      <pre class="in">{typeof b.input === 'string' ? b.input : JSON.stringify(b.input, null, 2)}</pre>
                      {#if b.result != null}<pre class="res" class:err={b.isError}>{b.result.slice(0, 4000)}</pre>{/if}
                    </div>
                  {/if}
                </div>
              {/if}
            {/each}
          </div>
        {:else if it.kind === 'perm'}
          <div class="turn perm" class:resolved={!!it.resolved}>
            <div class="eyebrow"><span class="pip ask"></span>permission</div>
            <div class="permq">{agentLabel(session.agent)} wants to use <b>{it.tool}</b>{#if it.summary}<code>{it.summary}</code>{/if}</div>
            {#if it.resolved}
              <div class="permres">{it.resolved === 'deny' ? 'denied' : it.resolved === 'allow-always' ? 'always allowed' : 'allowed'}</div>
            {:else}
              <div class="permbtns">
                <button class="pallow" onclick={() => respondPerm(it, 'allow')}>Allow</button>
                <button class="pquiet" onclick={() => respondPerm(it, 'allow-always')}>Always</button>
                <button class="pdeny" onclick={() => respondPerm(it, 'deny')}>Deny</button>
              </div>
            {/if}
          </div>
        {:else if it.kind === 'pill'}
          <div class="pill" class:err={it.err}>{it.text}</div>
        {/if}
      {/each}
    </div>
  </div>

  {#if disconnected && !ended}
    <div class="reconnect" role="status"><span class="rdot"></span>stream disconnected — reconnecting</div>
  {/if}

  <div class="composer">
    <div class="wrap">
      <div class="field" class:drag={dragOver} role="group" aria-label="Message composer with file drop"
           ondragover={(e) => { e.preventDefault(); dragOver = true; }} ondragleave={() => (dragOver = false)} ondrop={onDrop}>
        {#if atts.length}
          <div class="atts">
            {#each atts as a (a.name)}
              <span class="chip" class:err={a.error} title={a.message || a.name}>
                <span class="cn">{a.name}</span>
                {#if a.error}<span class="cs msg">{a.message || 'failed'}</span>{:else if !a.done}<span class="cs">{Math.round(a.pct * 100)}%</span>{/if}
                <button class="cx" onclick={() => removeAtt(a)} aria-label="Remove attachment"><Icon name="close" size={11} /></button>
              </span>
            {/each}
          </div>
        {/if}
        <textarea bind:this={composerEl} bind:value={draft} oninput={grow} onkeydown={onKey} onpaste={onPaste} disabled={ended} rows="1" placeholder={composerPlaceholder({ status: statusKey, ended, project: pathParts.project, agent: session.agent })}></textarea>
        <button class="send" class:ready={canSend} class:busy={statusKey === 'busy'}
                disabled={statusKey !== 'busy' && !canSend} onclick={primary}
                title={statusKey === 'busy' ? 'Stop' : 'Send'} aria-label={statusKey === 'busy' ? 'Stop' : 'Send'}>
          {#if statusKey === 'busy'}<span class="stopsq"></span>{:else}<Icon name="up" size={17} />{/if}
        </button>
      </div>
      <div class="hint" class:warn={!!submitState.hint}>{composerHint}</div>
    </div>
  </div>

  {#if changes}
    <aside class="changes">
      <header class="chh">
        <span class="ttl">Changes</span>
        {#if changeLabel}<span class="csummary">{changeLabel}</span>{/if}
        <span class="cpath" title={session?.cwd}>{session?.cwd}</span>
        <span class="sp"></span>
        {#if canDraftReview}<button class="ctext" onclick={draftReviewPrompt}>Review</button>{/if}
        {#if changeCopyText}<button class="ctext" onclick={copyChanges}>Copy</button>{/if}
        <button class="cico" onclick={openChanges} title="Refresh"><Icon name="swap" size={14} /></button>
        <button class="cico" onclick={() => (changes = null)} title="Close" aria-label="Close"><Icon name="close" size={13} /></button>
      </header>
      <div class="cbody">
        {#if changes.loading}
          <div class="cph">loading...</div>
        {:else if !changes.isRepo}
          <div class="cph">Not a git repository.</div>
        {:else if !changes.diff && !(changes.untracked && changes.untracked.length)}
          <div class="cph">No changes - working tree clean.</div>
        {:else}
          {#if changes.untracked && changes.untracked.length}
            <div class="untracked"><span class="ulabel">Untracked</span>{#each changes.untracked as u}<span class="ufile">{u}</span>{/each}</div>
          {/if}
          {#if changes.diff}<pre class="diff"><code>{@html hlDiff(changes.diff)}</code></pre>{/if}
        {/if}
      </div>
    </aside>
  {/if}

  {#if filesOpen}
    <aside class="filesdrawer">
      <header class="chh">
        <span class="ttl">Files</span>
        <span class="cpath" title={session?.cwd}>{session?.cwd}</span>
        <span class="sp"></span>
        <button class="ctext" onclick={() => { filesOpen = false; onOpenFiles?.(session); }} title="Open the full file browser">Full view</button>
        <button class="cico" onclick={() => (filesOpen = false)} title="Close" aria-label="Close"><Icon name="close" size={13} /></button>
      </header>
      <div class="fdbody">
        <Files host={session.host} path={session.cwd} />
      </div>
    </aside>
  {/if}

  {#if termOpen}
    <aside class="filesdrawer termdrawer">
      <header class="chh">
        <span class="ttl">Terminal</span>
        <span class="cpath" title={session?.cwd}>{session?.cwd}</span>
        <span class="sp"></span>
        <button class="ctext" onclick={() => { termOpen = false; onOpenTerminal?.(session); }} title="Open the full terminal view (starts a fresh shell)">Full view</button>
        <button class="cico" onclick={() => (termOpen = false)} title="Close" aria-label="Close"><Icon name="close" size={13} /></button>
      </header>
      <div class="fdbody">
        <Terminal host={session.host} cwd={session.cwd} />
      </div>
    </aside>
  {/if}
</div>

<style>
  .chat { position: absolute; inset: 0; display: flex; flex-direction: column; min-height: 0; background: var(--bg); }

  .chead { flex: none; display: flex; align-items: center; gap: var(--s3); min-height: 64px; padding: 9px var(--s5); color: var(--text-dim); font-size: 12px; }
  .identity { display: grid; grid-template-columns: 6px auto minmax(0, 1fr); align-items: center; gap: 10px; min-width: 220px; max-width: min(48vw, 560px); }
  .hpip { width: 6px; height: 6px; background: var(--text); flex: none; }
  .hostchip { max-width: 132px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--chip); border-radius: var(--pill); padding: 4px 10px; color: var(--text-dim); font: 10.5px var(--mono); }
  .labelin { min-width: 0; width: 180px; background: var(--chip-hi); border: 0; color: var(--text); padding: 2px 9px; height: 24px; font: 13.5px var(--sans); outline: 0; box-shadow: inset 0 0 0 1px var(--text-faint); }
  .lblbtn { flex: none; display: grid; place-items: center; background: none; border: 0; color: var(--text-faint); cursor: pointer; padding: 5px; opacity: 0; transition: color .12s, opacity .12s; }
  .identity:hover .lblbtn, .lblbtn:focus-visible { opacity: 1; }
  .lblbtn:hover { color: var(--text); }
  .pathstack { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .project { color: var(--text); font-size: 15px; line-height: 1.15; font-weight: var(--w-med); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cwd { color: var(--text-faint); font-family: var(--mono); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sessionmeta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; color: var(--text-faint); }
  .model, .usage { font-family: var(--mono); font-size: 11px; white-space: nowrap; color: var(--text-dim); }
  .usage { color: var(--text-faint); }
  .sp { flex: 1; }
  .stat, .estate { display: inline-flex; align-items: center; gap: 7px; font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  .stat .lamp, .estate .lamp { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
  .stat.idle .lamp, .estate.idle .lamp { background: var(--text); }
  .stat.busy .lamp, .estate.busy .lamp { background: var(--mercury-flow); animation: pulse 2.2s ease-in-out infinite; }
  .stat.error .lamp, .estate.error .lamp { background: var(--text-dim); }
  .stat.dormant .lamp, .estate.dormant .lamp { border: 1.5px dashed var(--text-faint); background: transparent; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
  .headbtn { display: inline-flex; align-items: center; gap: 7px; flex: none; font-size: 11px; letter-spacing: .04em; background: var(--chip); border: 0; color: var(--text-dim); border-radius: var(--pill); padding: 7px 13px; cursor: pointer; transition: color .12s, background .12s; }
  .headbtn:hover { color: var(--text); background: var(--chip-hi); }
  .headbtn.danger:hover { background: var(--paper); color: var(--ink); }
  .headbtn.resumebtn { color: var(--text); background: var(--chip-hi); }

  /* git-diff drawer — slides over the right edge of the transcript */
  .changes { position: absolute; top: 0; right: 0; bottom: 0; width: min(640px, 66%); background: var(--surface); display: flex; flex-direction: column; z-index: 5; box-shadow: -20px 0 50px rgba(0,0,0,.4); animation: slidein .16s ease both; }
  .filesdrawer { position: absolute; top: 0; right: 0; bottom: 0; width: min(780px, 74%); background: var(--surface); display: flex; flex-direction: column; z-index: 5; box-shadow: -20px 0 50px rgba(0,0,0,.4); animation: slidein .16s ease both; }
  .fdbody { flex: 1; min-height: 0; position: relative; }
  @keyframes slidein { from { transform: translateX(14px); opacity: 0; } to { transform: none; opacity: 1; } }
  .chh { flex: none; display: flex; align-items: center; gap: 10px; height: 56px; padding: 0 var(--s4); }
  .chh .ttl { font-size: 11px; letter-spacing: .16em; text-transform: uppercase; color: var(--text); }
  .csummary { flex: none; max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--chip); border-radius: var(--pill); padding: 4px 10px; color: var(--text-dim); font-size: 10.5px; }
  .chh .cpath { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); font-size: 11px; color: var(--text-dim); }
  .chh .sp { flex: 1; }
  .ctext { flex: none; background: var(--chip); border: 0; border-radius: var(--pill); color: var(--text-dim); cursor: pointer; padding: 6px 13px; font: var(--w-reg) 11.5px var(--sans); transition: color .12s, background .12s; }
  .ctext:hover { color: var(--text); background: var(--chip-hi); }
  .cico { display: grid; place-items: center; width: 28px; height: 28px; background: var(--chip); border: 0; color: var(--text-dim); cursor: pointer; font-size: 12px; line-height: 1; transition: color .12s, background .12s; }
  .cico:hover { color: var(--text); background: var(--chip-hi); }
  .cbody { flex: 1; min-height: 0; overflow: auto; }
  .cph { color: var(--text-dim); padding: var(--s6); text-align: center; font-size: 13px; }
  .untracked { display: flex; flex-wrap: wrap; gap: 9px; align-items: baseline; padding: var(--s3) var(--s4); }
  .untracked .ulabel { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  .untracked .ufile { font-family: var(--mono); font-size: 11.5px; color: var(--text-dim); }
  .diff { margin: 0; padding: var(--s3) var(--s4); background: var(--frame); font: 12px/1.55 var(--mono); color: #d8d8d8; white-space: pre; overflow-x: auto; }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; }
  .col { max-width: 728px; margin: 0 auto; padding: var(--s7) var(--s5) 132px; }
  .emptyturn { min-height: 42vh; display: flex; flex-direction: column; justify-content: center; gap: 12px; color: var(--text-faint); }
  .emptyturn b { display: block; color: var(--text); font-size: clamp(38px, 7vw, 82px); line-height: .92; font-weight: var(--w-light); letter-spacing: 0; overflow-wrap: anywhere; }
  .emptyturn > span:last-child { color: var(--text-dim); font: 12px/1.5 var(--mono); overflow-wrap: anywhere; }

  .turn { margin: 0 0 var(--s6); animation: rise .3s ease both; }
  @keyframes rise { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
  .eyebrow { font-size: 10px; letter-spacing: .2em; text-transform: uppercase; color: var(--text-faint); margin-bottom: 12px; display: flex; align-items: center; gap: 9px; }
  .eyebrow .pip { width: 5px; height: 5px; border-radius: 50%; background: var(--text); }

  /* operator turn — a quiet left rule, set apart from the agent's editorial column */
  .op .body { color: var(--text-dim); border-left: 2px solid var(--text); padding-left: 17px; font: var(--w-reg) 15px/1.6 var(--sans); white-space: pre-wrap; word-break: break-word; }

  .think { margin: 0 0 16px; border-left: 1px solid var(--seam); padding-left: 17px; }
  .think summary { cursor: pointer; font-size: 10px; letter-spacing: .18em; text-transform: uppercase; color: var(--text-faint); list-style: none; }
  .think summary::-webkit-details-marker { display: none; }
  .think summary::before { content: '>'; display: inline-block; margin-right: 8px; transition: transform .15s; }
  .think[open] summary::before { transform: rotate(90deg); }
  .think[open] summary { margin-bottom: 9px; }
  .think .t { font-style: italic; color: var(--text-dim); font-size: 14.5px; line-height: 1.62; white-space: pre-wrap; }

  /* tool call — a sharp hairline frame; its payload opens as a pure-black immersive inset */
  .tool { margin: 12px 0; background: var(--surface); }
  .tool .thead { display: flex; align-items: center; gap: 9px; width: 100%; padding: 10px 13px; cursor: pointer; font-size: 12.5px; background: none; border: 0; color: inherit; text-align: left; font-family: inherit; }
  .tool .glyph { color: var(--text-dim); transition: transform .15s; display: grid; place-items: center; }
  .tool.open .glyph { transform: rotate(90deg); }
  .tool .tname { font-weight: var(--w-semi); color: var(--text); }
  .tool .tsum { flex: 1; min-width: 0; color: var(--text-dim); font-family: var(--mono); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool .det { border-top: 1px solid var(--seam); }
  .tool pre { margin: 0; padding: 12px 14px; font: 11.5px/1.55 var(--mono); background: var(--frame); color: #d8d8d8; white-space: pre-wrap; word-break: break-word; max-height: 340px; overflow: auto; }
  .tool .res { border-top: 1px solid var(--seam); color: #a8a8a8; }
  .tool .res.err { color: #e6e6e6; }

  /* status tag — pill, the only curved element; achromatic */
  .pill { display: inline-flex; align-items: center; gap: 7px; font-size: 10.5px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); background: var(--chip); padding: 6px 14px; border-radius: var(--pill); margin: 2px 0 18px; }
  .pill.err { color: var(--text); background: var(--chip-hi); }

  /* in-chat permission card: the one moment the console asks before acting */
  .turn.perm { padding: 14px 0 16px; border-top: 1px solid var(--seam); border-bottom: 1px solid var(--seam); }
  .turn.perm .pip.ask { background: var(--alert); }
  .turn.perm.resolved { opacity: .55; }
  .permq { font-size: 13.5px; color: var(--text); }
  .permq b { font-weight: var(--w-med); }
  .permq code { display: block; margin-top: 8px; font: 12px var(--mono); color: var(--text-dim); overflow-wrap: anywhere; }
  .permbtns { display: flex; align-items: center; gap: 8px; margin-top: 14px; }
  .permbtns button { border: 0; cursor: pointer; font: var(--w-med) 12px var(--sans); border-radius: var(--pill); padding: 8px 16px; transition: color .12s, background .12s; }
  .pallow { background: var(--paper); color: var(--ink); }
  .pallow:hover { background: #fff; }
  .pquiet { background: var(--chip); color: var(--text-dim); }
  .pquiet:hover { background: var(--chip-hi); color: var(--text); }
  .pdeny { background: none; color: var(--text-dim); font-size: 10px; letter-spacing: .14em; text-transform: uppercase; padding: 8px 6px; }
  .pdeny:hover { color: var(--alert); }
  .permres { margin-top: 12px; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); }

  .reconnect { display: flex; align-items: center; gap: 8px; justify-content: center; padding: 7px 0; font-size: 10px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); border-top: 1px solid var(--seam); }
  .rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--alert); animation: pulse 2.2s ease-in-out infinite; }
  @media (prefers-reduced-motion: reduce) { .rdot { animation: none; } }

  /* floating composer — hovers over the transcript; the column fades out behind it */
  .composer { position: absolute; left: 0; right: 0; bottom: 0; pointer-events: none; padding-bottom: var(--s4); }
  .composer::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 132px; background: linear-gradient(to top, var(--bg) 42%, transparent); pointer-events: none; }
  .composer .wrap { position: relative; max-width: 728px; margin: 0 auto; padding: 0 var(--s5); pointer-events: auto; }
  /* sharp 0px field with the send tucked inside it, bottom-right */
  .field { position: relative; background: var(--surface-2); padding: 14px 52px 14px 16px; transition: box-shadow .14s; }
  .field:focus-within { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .field.drag { outline: 1.5px dashed var(--text); outline-offset: -3px; }

  /* attachment chips — a row above the textarea; reuse the pill language */
  .atts { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 10px; }
  .chip { display: inline-flex; align-items: center; gap: 7px; max-width: 100%; padding: 5px 5px 5px 11px; background: var(--chip); border-radius: var(--pill); font-size: 11.5px; color: var(--text-dim); }
  .chip.err { background: var(--chip-hi); color: var(--text); }
  .chip .cn { font-family: var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
  .chip .cs { color: var(--text-faint); font-variant-numeric: tabular-nums; }
  .chip .msg { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chip .cx { display: grid; place-items: center; width: 18px; height: 18px; border: 0; border-radius: 50%; background: var(--surface-2); color: var(--text-dim); font-size: 10px; line-height: 1; cursor: pointer; }
  .chip .cx:hover { color: var(--text); }
  textarea { display: block; width: 100%; resize: none; border: 0; outline: 0; background: none; color: var(--text); font: var(--w-reg) 15px/1.5 var(--sans); max-height: 200px; }
  textarea:disabled { opacity: .5; }
  textarea::placeholder { color: var(--text-faint); }
  /* send = a little up-arrow inside the box; lights up when there's something to send */
  .send { position: absolute; right: 8px; bottom: 8px; width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: var(--pill); background: var(--surface-2); color: var(--text-faint); cursor: pointer; transition: background .14s, color .14s, opacity .14s; }
  .send.ready, .send.busy { background: var(--paper); color: var(--ink); }
  .send:disabled { opacity: .4; pointer-events: none; }
  .send .stopsq { width: 11px; height: 11px; background: currentColor; }
  .headbtn:focus-visible, .ctext:focus-visible, .cico:focus-visible, .tool .thead:focus-visible, .send:focus-visible, .chip .cx:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }
  .hint { margin: 9px auto 0; padding: 0 var(--s5); color: var(--text-faint); font-size: 11px; text-align: center; }
  .hint.warn { color: var(--text); }

  @media (max-width: 900px) {
    .chead { align-items: flex-start; flex-wrap: wrap; padding: 10px var(--s3); gap: 9px; }
    .identity { width: 100%; max-width: none; min-width: 0; }
    .sessionmeta { order: 3; width: 100%; gap: 6px; }
    .model, .usage { border-left: 0; padding-left: 0; }
    .sp { display: none; }
    .stat { margin-left: auto; }
    .headbtn span { display: none; }
    .headbtn { width: 32px; height: 32px; padding: 0; justify-content: center; }
    .changes { width: 100%; border-left: 0; }
    .filesdrawer { width: 100%; }
    .col { padding-inline: var(--s3); }
    .composer .wrap { padding-inline: var(--s3); }
    .hint { padding-inline: var(--s2); }
  }

  @media (prefers-reduced-motion: reduce) {
    .turn, .changes, .filesdrawer { animation: none; }
    .stat.busy .lamp, .estate.busy .lamp { animation: none; }
  }
</style>
