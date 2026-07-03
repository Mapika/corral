<script>
  // Ranch a new agent from the phone: host, project, agent, permission mode — recents first, and
  // every project remembers the combo it was last launched with, so the common case is two taps.
  import { launchSession } from '../lib/api.js';
  import { apiErrorMessage } from '../lib/apiRequest.mjs';
  import { LAUNCH_DEFAULTS_KEY, launchDefaultsFor, parseLaunchDefaults, rememberLaunchDefaults, serializeLaunchDefaults } from '../lib/launchDefaults.mjs';
  import { AGENTS, MODELS, PERMS } from '../lib/launchOptions.mjs';
  import { recentRootsForHost } from '../lib/recentRoots.mjs';
  import Sheet from './Sheet.svelte';

  let { data, onclose, onLaunched, initialDir = '', initialBrief = '' } = $props();

  let host = $state('local');
  // svelte-ignore state_referenced_locally
  let dir = $state(initialDir);
  // optional first instruction — the agent starts on it immediately. Seeded by Share -> Corral.
  // svelte-ignore state_referenced_locally
  let brief = $state(initialBrief);
  let agent = $state('claude');
  let model = $state(null);
  let perm = $state('auto');
  let worktree = $state(false);
  let busy = $state(false);
  let error = $state('');

  let hosts = $derived(['local', ...data.d.hosts]);
  let roots = $derived(recentRootsForHost({ host, roots: data.d.recentRoots, sessions: data.d.sessions }));
  let models = $derived(MODELS[agent] || MODELS.claude);

  let defaults = {};
  try { defaults = parseLaunchDefaults(localStorage.getItem(LAUNCH_DEFAULTS_KEY)); } catch (e) {}

  const setAgent = (v) => { agent = v; model = null; };
  function pickHost(h) {
    if (host !== h) { host = h; dir = ''; }
  }
  function pickDir(d) {
    dir = d;
    const known = launchDefaultsFor(defaults, host, d);
    if (!known) return;
    agent = known.agent; perm = known.perm; worktree = known.worktree;
    model = (MODELS[known.agent] || []).some((m) => m.v === known.model) ? known.model : null;
  }
  async function go() {
    const target = dir.trim() || (host === 'local' ? data.d.localHome : '~');
    busy = true; error = '';
    try {
      const r = await launchSession({ host, dir: target, agent, model: model || undefined, perm, worktree: worktree && host === 'local', prompt: brief.trim() || undefined });
      if (r?.ok === false) throw new Error(r.error || 'launch failed');
      data.rememberRoot(host, target);
      defaults = rememberLaunchDefaults(defaults, { host, dir: target, agent, perm, model, worktree: worktree && host === 'local' });
      try { localStorage.setItem(LAUNCH_DEFAULTS_KEY, serializeLaunchDefaults(defaults)); } catch (e) {}
      await data.poll();
      onLaunched?.({ kind: 'chat', id: r.id, agent, host, cwd: target, model: model || null, status: 'starting', sessionId: null });
    } catch (e) {
      error = apiErrorMessage(e, 'Launch failed.');
    } finally {
      busy = false;
    }
  }
</script>

<Sheet {onclose} label="Ranch an agent">
  <div class="launch">
    <h2>Where</h2>
    <div class="chips">
      {#each hosts as h (h)}
        <button class="chip" class:on={host === h} onclick={() => pickHost(h)}>{h === 'local' ? 'this computer' : h}</button>
      {/each}
    </div>

    <h2>Project</h2>
    {#if roots.length}
      <div class="roots">
        {#each roots.slice(0, 5) as r (r.dir)}
          <button class="root" class:on={dir === r.dir} onclick={() => pickDir(r.dir)}>
            <b>{r.dir.split(/[\\/]/).filter(Boolean).pop()}</b>
            <span>{r.dir}</span>
          </button>
        {/each}
      </div>
    {/if}
    <input class="dirin" bind:value={dir} placeholder={host === 'local' ? data.d.localHome : '~/project'} autocapitalize="off" autocorrect="off" spellcheck="false" />

    <h2>First instruction</h2>
    <textarea class="brief" bind:value={brief} rows="2"
              placeholder="What should it do? (optional — without one, the agent waits for your first message)"></textarea>

    <h2>Agent</h2>
    <div class="chips">
      {#each AGENTS as a (a.v)}
        <button class="chip" class:on={agent === a.v} onclick={() => setAgent(a.v)}>{a.l}</button>
      {/each}
    </div>

    {#if models.length > 1}
      <h2>Model</h2>
      <div class="chips">
        {#each models as m (m.v ?? 'default')}
          <button class="chip" class:on={model === m.v} onclick={() => (model = m.v)}>{m.l}</button>
        {/each}
      </div>
    {/if}

    <h2>Permissions</h2>
    <div class="chips">
      {#each PERMS as p (p.v)}
        <button class="chip" class:on={perm === p.v} onclick={() => (perm = p.v)}>{p.l}</button>
      {/each}
      {#if host === 'local'}
        <button class="chip" class:on={worktree} onclick={() => (worktree = !worktree)}>Worktree</button>
      {/if}
    </div>
    {#if perm === 'default'}<p class="note">Ask pings your phone whenever the agent needs permission.</p>{/if}
    {#if worktree && host === 'local'}<p class="note">Runs in a fresh git worktree — your tree stays untouched.</p>{/if}

    {#if error}<p class="err">{error}</p>{/if}
    <button class="go" onclick={go} disabled={busy}>{busy ? 'Ranching…' : 'Ranch'}</button>
  </div>
</Sheet>

<style>
  .launch { display: flex; flex-direction: column; padding-bottom: var(--s2); }
  h2 { margin: var(--s4) 0 var(--s2); font-size: 10px; letter-spacing: .16em; text-transform: uppercase; font-weight: var(--w-reg); color: var(--text-faint); }
  h2:first-child { margin-top: 0; }

  .chips { display: flex; flex-wrap: wrap; gap: 8px; }
  .chip { background: var(--chip); border: 0; border-radius: var(--pill); color: var(--text-dim); min-height: 40px; padding: 0 16px; font: var(--w-reg) 13px var(--sans); cursor: pointer; }
  .chip.on { background: var(--paper); color: var(--ink); font-weight: var(--w-med); }

  .roots { display: flex; flex-direction: column; margin-bottom: var(--s2); }
  .root { display: flex; flex-direction: column; gap: 2px; text-align: left; background: none; border: 0; border-bottom: 1px solid var(--seam); min-height: 52px; justify-content: center; padding: 8px 2px; cursor: pointer; }
  .root b { color: var(--text); font-size: 14px; font-weight: var(--w-med); }
  .root span { color: var(--text-faint); font: 10.5px var(--mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .root.on b { color: var(--text); }
  .root.on { background: var(--chip); }

  .dirin { width: 100%; background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: 16px var(--mono); padding: 13px 14px; }
  .dirin:focus { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .dirin::placeholder { color: var(--text-faint); }

  .brief { width: 100%; resize: none; background: var(--surface-2); border: 0; outline: 0; color: var(--text); font: var(--w-reg) 16px/1.45 var(--sans); padding: 13px 14px; }
  .brief:focus { box-shadow: inset 0 0 0 1px var(--text-dim); }
  .brief::placeholder { color: var(--text-faint); }

  .note { margin: 10px 0 0; color: var(--text-faint); font-size: 12px; }
  .err { margin: 12px 0 0; color: var(--alert); font-size: 12.5px; }
  .go { margin-top: var(--s4); min-height: 52px; background: var(--paper); color: var(--ink); border: 0; border-radius: var(--pill); font: var(--w-med) 15px var(--sans); cursor: pointer; }
  .go:disabled { opacity: .5; }
</style>
