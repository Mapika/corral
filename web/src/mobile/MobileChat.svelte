<script>
  // Full-screen chat: the same wire protocol as the desktop view (lib/chatStream.mjs), reshaped
  // for a thumb — sticky composer, and permission prompts docked as a decision sheet above it.
  import { untrack } from 'svelte';
  import { chatSocket, gitDiff, killSession, removeSession, resumeSession, setSessionLabel, uploadFile } from '../lib/api.js';
  import { createChatState, handleChatEvent, openPermissions } from '../lib/chatStream.mjs';
  import { uploadMessage } from '../lib/fileUploads.mjs';
  import { highlightCode, renderMarkdown } from '../lib/markdown.js';
  import { prettyModel } from '../lib/format.js';
  import { agentLabel, canSubmitMessage, composerPlaceholder, composerSubmitState, sessionHostLabel, sessionPathParts, sessionStatusView } from '../lib/sessionView.mjs';
  import Icon from '../lib/Icon.svelte';
  import Sheet from './Sheet.svelte';
  import { pushOverlay, showToast } from './nav.svelte.js';

  let { session, onclose, onchanged } = $props();

  let cs = $state(createChatState());
  let draft = $state('');
  let disconnected = $state(false);
  let menuOpen = $state(false);
  let changes = $state(null);            // null | { loading } | { isRepo, diff, untracked }
  // svelte-ignore state_referenced_locally
  let label = $state(session?.label || null);    // operator-assigned name (roster-persisted)
  let renaming = $state(false);
  let labelDraft = $state('');
  let scrollEl = $state(null);
  let composerEl = $state(null);
  let fileEl = $state(null);
  let atts = $state([]);                 // { name, pct, done, error, message } — same shape as desktop Chat
  let ws = null;

  let statusKey = $derived(cs.status || session?.status || '');
  let ended = $derived(statusKey === 'error' || statusKey === 'exited');
  let parts = $derived(sessionPathParts(session?.cwd));
  let statusView = $derived(sessionStatusView(statusKey));
  let perms = $derived(openPermissions(cs));
  let perm = $derived(perms[0] || null);
  let canSend = $derived(composerSubmitState({ status: statusKey, ended, draft, attachments: atts }).canSend);
  let resumable = $derived((statusKey === 'exited' || statusKey === 'error' || statusKey === 'dormant') && !!session?.sessionId);

  const scrollDown = () => { if (scrollEl) queueMicrotask(() => { scrollEl.scrollTop = scrollEl.scrollHeight; }); };
  const hlDiff = (t) => highlightCode(t, 'diff');

  function send() {
    if (!canSend || !canSubmitMessage({ status: statusKey, ended })) return;
    if (!ws || ws.readyState !== 1) return;
    const t = draft.trim();
    const refs = atts.filter((a) => a.done).map((a) => 'Attached file: ./' + a.name).join('\n');
    const text = refs ? refs + (t ? '\n\n' + t : '') : t;
    if (!text) return;
    ws.send(JSON.stringify({ type: 'input', text }));
    draft = ''; atts = [];
    if (composerEl) composerEl.style.height = 'auto';
  }

  // Camera/photo attachments: upload into the session cwd (same PUT /api/upload as desktop paste),
  // then reference by relative path on send so the agent can Read the file where it runs.
  async function addFiles(fileList) {
    for (const f of [...fileList]) {
      let name = f.name || 'photo.jpg';
      if (!f.name || atts.some((a) => a.name === name)) {     // uniquify nameless captures / collisions
        const dot = name.lastIndexOf('.'), ext = dot > 0 ? name.slice(dot) : '', stem = dot > 0 ? name.slice(0, dot) : name;
        name = stem + '-' + Date.now().toString(36).slice(-4) + ext;
      }
      atts.push({ name, pct: 0, done: false, error: false, message: '' });
      const rec = atts[atts.length - 1];   // the $state proxy — mutating the raw object is invisible to the UI
      try {
        const r = await uploadFile(session.host, session.cwd, f, (p) => (rec.pct = p), name);
        if (r && r.ok) rec.done = true; else { rec.error = true; rec.message = uploadMessage(r); }
      } catch (e) { rec.error = true; rec.message = uploadMessage(e); }
    }
  }
  function onPick(e) {
    const fs = e.target.files;
    if (fs && fs.length) addFiles(fs);
    e.target.value = '';                   // re-picking the same photo must fire change again
  }
  const removeAtt = (rec) => { atts = atts.filter((a) => a !== rec); };
  function stop() { if (ws && ws.readyState === 1) { ws.send(JSON.stringify({ type: 'interrupt' })); cs.stopped = true; } }
  function primary() { if (statusKey === 'busy') stop(); else send(); }
  function respondPerm(item, decision) {
    if (!item || item.resolved || !ws || ws.readyState !== 1) return;
    try { navigator.vibrate?.(12); } catch (e) {}
    item.resolved = decision;              // optimistic; the server echoes _permission_resolved
    ws.send(JSON.stringify({ type: 'permission', requestId: item.id, decision }));
  }
  function grow(e) {
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }

  function startRename() {
    labelDraft = label || parts.project;
    renaming = true;
  }
  async function saveRename() {
    if (!renaming) return;
    renaming = false; menuOpen = false;
    const next = labelDraft.trim().slice(0, 60);
    const effective = next && next !== parts.project ? next : null;   // folder name = no label
    if (effective === label) return;
    try { await setSessionLabel(session.id, effective || ''); label = effective; onchanged?.(); }
    catch (e) { showToast('Rename failed — try again.'); }
  }
  async function revive() {
    menuOpen = false;
    try { await resumeSession(session.id); cs.status = 'starting'; onchanged?.(); }
    catch (e) { showToast('Could not resume this session.'); }
  }
  async function end() {
    menuOpen = false;
    try { await killSession(session.id); onchanged?.(); }
    catch (e) { showToast('Could not end the session.'); }
  }
  async function removeIt() {
    menuOpen = false;
    try { await removeSession(session.id); onchanged?.(); onclose?.(); }
    catch (e) { showToast('Could not remove the session.'); }
  }
  async function openChanges() {
    menuOpen = false;
    changes = { loading: true };
    try { changes = await gitDiff(session.host, session.cwd); } catch (e) { changes = { isRepo: false }; }
  }
  // The diff subview is its own layer — hardware back closes it before the chat.
  $effect(() => {
    if (!changes) return;
    return pushOverlay(() => (changes = null));
  });

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
      sock.onmessage = (e) => {
        let ev; try { ev = JSON.parse(e.data); } catch (x) { return; }
        if (handleChatEvent(cs, ev, renderMarkdown)) scrollDown();
      };
      sock.onclose = () => {
        if (gone) return;
        disconnected = true;
        if (cs.status !== 'error' && cs.status !== 'exited') cs.status = '';
        retries += 1;
        retryTimer = setTimeout(connect, Math.min(8000, 500 * 2 ** Math.min(retries, 4)));
      };
    };
    // untracked: connect() reassigns/reads `cs`; the effect must key on the session id alone.
    untrack(() => connect());
    // Wake-from-lock: skip the reconnect backoff and reattach immediately.
    const onVis = () => {
      if (document.visibilityState !== 'visible' || gone) return;
      if (!sock || sock.readyState > 1) { clearTimeout(retryTimer); untrack(() => connect()); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { gone = true; document.removeEventListener('visibilitychange', onVis); clearTimeout(retryTimer); try { sock && sock.close(); } catch (x) {} };
  });
</script>

<div class="mchat">
  <header>
    <button class="back" onclick={() => onclose?.()} aria-label="Back"><Icon name="chevron-left" size={22} /></button>
    <div class="who">
      <b>{label || parts.project}</b>
      <span>{sessionHostLabel(session.host)} · {agentLabel(session.agent)}{#if cs.model} · {prettyModel(cs.model)}{/if}</span>
    </div>
    <span class="stat {statusView.tone}" title={statusView.detail}><span class="lamp"></span>{statusView.label}</span>
    <button class="kebab" onclick={() => (menuOpen = true)} aria-label="Session actions"><Icon name="kebab" size={17} stroke={2.75} /></button>
  </header>

  <div class="scroll" bind:this={scrollEl}>
    <div class="col">
      {#if cs.items.length === 0}
        <div class="emptyturn">
          <b>{parts.project}</b>
          <span>{sessionHostLabel(session.host)} · {statusView.detail}</span>
        </div>
      {/if}
      {#each cs.items as it (it)}
        {#if it.kind === 'op'}
          <div class="turn op"><div class="body">{it.text}</div></div>
        {:else if it.kind === 'asst'}
          <div class="turn asst">
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
                    <span class="glyph" class:done={b.result != null} class:terr={b.isError}></span>
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
          {#if it.resolved}
            <div class="pill">{it.tool} — {it.resolved === 'deny' ? 'denied' : it.resolved === 'allow-always' ? 'always allowed' : 'allowed'}</div>
          {/if}
        {:else if it.kind === 'pill'}
          <div class="pill" class:err={it.err}>{it.text}</div>
        {/if}
      {/each}
    </div>
  </div>

  {#if disconnected && !ended}
    <div class="reconnect" role="status"><span class="rdot"></span>reconnecting</div>
  {/if}

  {#if perm}
    <div class="permsheet" role="alertdialog" aria-label="Permission request">
      <div class="pq">{agentLabel(session.agent)} wants to use <b>{perm.tool}</b>{#if perms.length > 1}<span class="more">+{perms.length - 1} queued</span>{/if}</div>
      {#if perm.summary}<code>{perm.summary}</code>{/if}
      <div class="pbtns">
        <button class="pdeny" onclick={() => respondPerm(perm, 'deny')}>Deny</button>
        <span class="sp"></span>
        <button class="pquiet" onclick={() => respondPerm(perm, 'allow-always')}>Always</button>
        <button class="pallow" onclick={() => respondPerm(perm, 'allow')}>Allow</button>
      </div>
    </div>
  {/if}

  <div class="composer">
    {#if resumable}
      <button class="resume" onclick={revive}>Resume this session</button>
    {:else}
      {#if atts.length}
        <div class="atts">
          {#each atts as a (a)}
            <button class="att" class:err={a.error} onclick={() => removeAtt(a)}
                    aria-label={'Remove attachment ' + a.name} title={a.message || a.name}>
              <span class="an">{a.name}</span>
              <span class="ax">{a.error ? 'failed' : !a.done ? Math.round(a.pct * 100) + '%' : '×'}</span>
            </button>
          {/each}
        </div>
      {/if}
      <div class="field">
        <input class="filein" bind:this={fileEl} type="file" accept="image/*" multiple onchange={onPick} />
        <button class="attach" disabled={ended} onclick={() => fileEl?.click()} aria-label="Attach a photo">+</button>
        <textarea bind:this={composerEl} bind:value={draft} oninput={grow} rows="1" disabled={ended}
                  placeholder={composerPlaceholder({ status: statusKey, ended, project: parts.project, agent: session.agent })}></textarea>
        <button class="go" class:ready={canSend} class:busy={statusKey === 'busy'}
                disabled={statusKey !== 'busy' && !canSend} onclick={primary}
                aria-label={statusKey === 'busy' ? 'Stop' : 'Send'}>
          {#if statusKey === 'busy'}<span class="stopsq"></span>{:else}<Icon name="up" size={17} stroke={1.8} />{/if}
        </button>
      </div>
    {/if}
  </div>

  {#if menuOpen}
    <Sheet onclose={() => { menuOpen = false; renaming = false; }} label="Session actions">
      <div class="menu">
        {#if renaming}
          <div class="renamerow">
            <!-- svelte-ignore a11y_autofocus -->
            <input bind:value={labelDraft} autofocus placeholder={parts.project} maxlength="60"
                   onkeydown={(e) => { if (e.key === 'Enter') saveRename(); }} />
            <button class="savebtn" onclick={saveRename}>Save</button>
          </div>
        {:else}
          <button onclick={startRename}>Rename{#if label}&nbsp;<span class="curlabel">({label})</span>{/if}</button>
        {/if}
        <button onclick={openChanges}>Review changes</button>
        {#if resumable}<button onclick={revive}>Resume</button>{/if}
        {#if !ended}<button onclick={end}>End session</button>{/if}
        <button class="danger" onclick={removeIt}>Remove from herd</button>
      </div>
    </Sheet>
  {/if}

  {#if changes}
    <div class="diffview">
      <header>
        <button class="back" onclick={() => (changes = null)} aria-label="Close changes"><Icon name="chevron-left" size={22} /></button>
        <div class="who"><b>Changes</b><span>{session.cwd}</span></div>
      </header>
      <div class="diffbody">
        {#if changes.loading}
          <div class="cph">loading…</div>
        {:else if !changes.isRepo}
          <div class="cph">Not a git repository.</div>
        {:else if !changes.diff && !(changes.untracked && changes.untracked.length)}
          <div class="cph">No changes — working tree clean.</div>
        {:else}
          {#if changes.untracked && changes.untracked.length}
            <div class="untracked"><span>Untracked</span>{#each changes.untracked as u}<code>{u}</code>{/each}</div>
          {/if}
          {#if changes.diff}<pre class="diff"><code>{@html hlDiff(changes.diff)}</code></pre>{/if}
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .mchat { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column; background: var(--bg); }

  header { flex: none; display: flex; align-items: center; gap: 10px; min-height: 54px; padding: 0 6px 0 0; padding-top: env(safe-area-inset-top, 0px); border-bottom: 1px solid var(--seam); }
  .back { flex: none; width: 46px; height: 46px; background: none; border: 0; color: var(--text-dim); cursor: pointer; display: grid; place-items: center; }
  .who { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .who b { color: var(--text); font-size: 15px; font-weight: var(--w-med); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who span { color: var(--text-faint); font: 10.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .stat { flex: none; display: inline-flex; align-items: center; gap: 6px; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-faint); }
  .stat .lamp { width: 7px; height: 7px; border-radius: 50%; background: var(--text-faint); }
  .stat.idle .lamp { background: var(--text); }
  .stat.busy .lamp { background: var(--mercury); animation: pulse 2.2s ease-in-out infinite; }
  .stat.error .lamp { background: var(--alert); }
  .stat.dormant .lamp { border: 1.5px dashed var(--text-faint); background: transparent; }
  .kebab { flex: none; width: 44px; height: 46px; background: none; border: 0; color: var(--text-dim); cursor: pointer; display: grid; place-items: center; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

  .scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; -webkit-overflow-scrolling: touch; }
  .col { padding: var(--s4) var(--s4) var(--s5); }
  .emptyturn { min-height: 40dvh; display: flex; flex-direction: column; justify-content: center; gap: 10px; }
  .emptyturn b { color: var(--text); font-size: clamp(30px, 9vw, 44px); line-height: 1; font-weight: var(--w-light); overflow-wrap: anywhere; }
  .emptyturn span { color: var(--text-dim); font: 11.5px var(--mono); overflow-wrap: anywhere; }

  .turn { margin: 0 0 var(--s4); }
  .op .body { color: var(--text-dim); border-left: 2px solid var(--text); padding-left: 13px; font: var(--w-reg) 14.5px/1.55 var(--sans); white-space: pre-wrap; word-break: break-word; }

  .think { margin: 0 0 12px; border-left: 1px solid var(--seam); padding-left: 13px; }
  .think summary { cursor: pointer; font-size: 10px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); list-style: none; padding: 6px 0; }
  .think summary::-webkit-details-marker { display: none; }
  .think[open] summary { margin-bottom: 4px; }
  .think .t { font-style: italic; color: var(--text-dim); font-size: 13.5px; line-height: 1.55; white-space: pre-wrap; }

  .tool { margin: 10px 0; background: var(--surface); }
  .tool .thead { display: flex; align-items: center; gap: 9px; width: 100%; min-height: 44px; padding: 8px 12px; cursor: pointer; font-size: 12.5px; background: none; border: 0; color: inherit; text-align: left; font-family: inherit; }
  .tool .glyph { flex: none; width: 6px; height: 6px; background: var(--text-faint); }
  .tool .glyph.done { background: var(--text-dim); }
  .tool .glyph.terr { background: var(--alert); }
  .tool .tname { flex: none; font-weight: var(--w-semi); color: var(--text); }
  .tool .tsum { flex: 1; min-width: 0; color: var(--text-dim); font: 11px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tool .det { border-top: 1px solid var(--seam); }
  .tool pre { margin: 0; padding: 10px 12px; font: 11px/1.5 var(--mono); background: var(--frame); color: #d8d8d8; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow: auto; }
  .tool .res { border-top: 1px solid var(--seam); color: #a8a8a8; }
  .tool .res.err { color: #e6e6e6; }

  .pill { display: inline-flex; font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-dim); background: var(--chip); padding: 6px 13px; border-radius: var(--pill); margin: 0 0 14px; }
  .pill.err { color: var(--text); background: var(--chip-hi); }

  .reconnect { flex: none; display: flex; align-items: center; gap: 8px; justify-content: center; padding: 6px 0; font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; color: var(--text-dim); border-top: 1px solid var(--seam); }
  .rdot { width: 7px; height: 7px; border-radius: 50%; background: var(--alert); animation: pulse 2.2s ease-in-out infinite; }

  /* the decision sheet — docked above the composer, impossible to miss, one thumb to answer */
  .permsheet { flex: none; background: var(--surface); border-top: 1px solid var(--seam); padding: var(--s3) var(--s4); }
  .pq { color: var(--text); font-size: 14px; }
  .pq b { font-weight: var(--w-semi); }
  .pq .more { margin-left: 10px; font-size: 10px; letter-spacing: .12em; text-transform: uppercase; color: var(--text-faint); }
  .permsheet code { display: block; margin-top: 8px; font: 12px/1.5 var(--mono); color: var(--text-dim); overflow-wrap: anywhere; max-height: 88px; overflow: hidden; }
  .pbtns { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
  .pbtns .sp { flex: 1; }
  .pallow { background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); min-height: 46px; padding: 0 28px; font: var(--w-med) 14px var(--sans); cursor: pointer; }
  .pquiet { background: var(--chip); color: var(--text-dim); border: 0; border-radius: var(--pill); min-height: 46px; padding: 0 18px; font: var(--w-reg) 13px var(--sans); cursor: pointer; }
  .pdeny { background: none; border: 0; color: var(--text-dim); font-size: 11px; letter-spacing: .14em; text-transform: uppercase; padding: 12px 2px; cursor: pointer; }
  .pdeny:active { color: var(--alert); }

  .composer { flex: none; padding: var(--s2) var(--s3) calc(var(--s2) + env(safe-area-inset-bottom, 0px)); background: var(--bg); }
  .atts { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 2px 8px; }
  .att { display: inline-flex; align-items: center; gap: 9px; max-width: 100%; background: var(--chip); border: 0; border-radius: var(--pill); padding: 8px 14px; color: var(--text-dim); font: 11px var(--mono); cursor: pointer; }
  .att .an { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .att .ax { flex: none; color: var(--text-faint); }
  .att.err { color: var(--text); background: var(--chip-hi); }
  .att.err .ax { color: var(--text); }
  .field { position: relative; background: var(--surface-2); padding: 12px 56px 12px 50px; }
  .filein { display: none; }
  .attach { position: absolute; left: 6px; bottom: 6px; width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: var(--pill); background: none; color: var(--text-faint); font-size: 24px; font-weight: var(--w-light); line-height: 1; cursor: pointer; }
  .attach:active { color: var(--text); }
  .attach:disabled { opacity: .4; pointer-events: none; }
  .field:focus-within { box-shadow: inset 0 0 0 1px var(--text-dim); }
  textarea { display: block; width: 100%; resize: none; border: 0; outline: 0; background: none; color: var(--text); font: var(--w-reg) 16px/1.45 var(--sans); max-height: 132px; }
  textarea::placeholder { color: var(--text-faint); }
  textarea:disabled { opacity: .5; }
  .go { position: absolute; right: 6px; bottom: 6px; width: 40px; height: 40px; display: grid; place-items: center; border: 0; border-radius: var(--pill); background: var(--surface-2); color: var(--text-faint); font-size: 19px; cursor: pointer; transition: background .14s, color .14s; }
  .go.ready, .go.busy { background: var(--paper); color: var(--ink); }
  .go:disabled { opacity: .4; pointer-events: none; }
  .go .stopsq { width: 12px; height: 12px; background: currentColor; }
  .resume { width: 100%; min-height: 50px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); font: var(--w-med) 14px var(--sans); cursor: pointer; }

  .menu { display: flex; flex-direction: column; }
  .menu button { min-height: 54px; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--seam); color: var(--text); font: var(--w-reg) 15px var(--sans); cursor: pointer; padding: 0 4px; }
  .menu button:last-child { border-bottom: 0; }
  .menu .danger { color: var(--alert); }
  .menu .curlabel { color: var(--text-faint); font-size: 13px; }
  .renamerow { display: flex; gap: 10px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--seam); }
  .renamerow input { flex: 1; min-width: 0; background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: 16px var(--sans); padding: 12px 13px; }
  .renamerow input:focus { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .menu .savebtn { flex: none; min-height: 44px; border: 0; border-bottom: 0; background: var(--paper); color: var(--ink); border-radius: var(--pill); padding: 0 20px; font: var(--w-med) 13px var(--sans); }

  .diffview { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; background: var(--bg); }
  .diffbody { flex: 1; min-height: 0; overflow: auto; }
  .cph { color: var(--text-dim); padding: var(--s6); text-align: center; font-size: 13px; }
  .untracked { display: flex; flex-wrap: wrap; gap: 8px; align-items: baseline; padding: var(--s3) var(--s4); }
  .untracked span { font-size: 9.5px; letter-spacing: .16em; text-transform: uppercase; color: var(--text-faint); }
  .untracked code { font: 11.5px var(--mono); color: var(--text-dim); }
  .diff { margin: 0; padding: var(--s3) var(--s4) calc(var(--s3) + env(safe-area-inset-bottom, 0px)); background: var(--frame); font: 11px/1.55 var(--mono); color: #d8d8d8; white-space: pre; overflow-x: auto; }

  @media (prefers-reduced-motion: reduce) { .stat.busy .lamp, .rdot { animation: none; } }
</style>
