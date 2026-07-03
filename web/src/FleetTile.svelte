<script>
  // One live tile in the fleet grid: a read-only tail of a session's event stream. The chat WS
  // fans out to any number of subscribers server-side, so this never disturbs an open Chat view.
  import { chatSocket } from './lib/api.js';
  import { applyTailEvent, createTailState } from './lib/fleetTail.mjs';
  import { renderMarkdown } from './lib/markdown.js';
  import { agentLabel, sessionHostLabel, sessionPathParts, sessionStatusView } from './lib/sessionView.mjs';

  // socket: (id) => WebSocket — the phone console passes a per-ranch factory; the desktop grid
  // (one server) uses the default client's.
  let { session, onOpen, socket = chatSocket, showRanch = false } = $props();
  let lines = $state([]);
  let bodyEl = $state(null);
  const tail = createTailState();

  let statusView = $derived(sessionStatusView(session?.status));
  let parts = $derived(sessionPathParts(session?.cwd));
  let busy = $derived(session?.status === 'busy' || session?.status === 'starting');

  // Key the socket to the session ID string, not the session object — roster snapshots recreate
  // the object on every event, and reconnecting would replay the scrollback into the tail again.
  let sid = $derived(session?.id);
  $effect(() => {
    const id = sid;
    if (!id) return;
    Object.assign(tail, createTailState());   // fresh tail per connection: replay lands exactly once
    lines = [];
    let raf = 0;
    const ws = socket(id);
    ws.onmessage = (m) => {
      let ev;
      try { ev = JSON.parse(m.data); } catch (e) { return; }
      if (applyTailEvent(tail, ev) && !raf) {
        raf = requestAnimationFrame(() => { raf = 0; lines = tail.lines.slice(); });
      }
    };
    return () => { if (raf) cancelAnimationFrame(raf); try { ws.close(); } catch (e) {} };
  });
  $effect(() => { lines; if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; });
</script>

<button class="tile" onclick={() => onOpen?.()} title="Open {parts.project}">
  <header>
    <span class="dot {statusView.tone}"></span>
    <b>{session?.label || parts.project}</b>
    <span class="host">{showRanch && session?.ranchName ? session.ranchName + ' · ' : ''}{sessionHostLabel(session?.host)}</span>
    <span class="agent">{agentLabel(session?.agent)} · {statusView.label}</span>
  </header>
  <div class="lines" bind:this={bodyEl}>
    {#each lines as line}
      {#if line.kind === 'text'}
        <div class="md">{@html renderMarkdown(line.text)}</div>
      {:else}
        <span class="ln {line.kind}">{line.text}</span>
      {/if}
    {/each}
    {#if busy}<span class="cursor" aria-hidden="true"></span>{/if}
  </div>
</button>

<style>
  .tile { display: grid; grid-template-rows: auto minmax(0, 1fr); min-width: 0; height: 100%; min-height: 340px; text-align: left; background: var(--frame, #000); border: 0; padding: 0; cursor: pointer; font: inherit; color: var(--text); }
  .tile:focus-visible { outline: 0; box-shadow: inset 0 0 0 1px var(--text-dim); }
  header { display: flex; align-items: baseline; gap: 10px; min-width: 0; padding: 12px 14px 9px; border-bottom: 1px solid var(--seam); }
  header b { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: 13px; font-weight: var(--w-med); }
  header .host { flex: none; color: var(--text-faint); font: 10.5px var(--mono); }
  header .agent { flex: none; margin-left: auto; color: var(--text-faint); font-size: 9.5px; letter-spacing: .14em; text-transform: uppercase; white-space: nowrap; }
  .dot { flex: none; align-self: center; width: 6px; height: 6px; border-radius: 50%; background: var(--text-faint); }
  .dot.busy { background: var(--mercury, #c8ccd2); animation: breathe 1.6s ease-in-out infinite; }
  .dot.idle { background: var(--text-dim); }
  .dot.error { background: var(--alert); }

  /* top-aligned flow; the scroll effect pins the view to the newest content once it overflows */
  .lines { min-height: 0; overflow-y: auto; scrollbar-width: none; display: flex; flex-direction: column; gap: 3px; padding: 10px 14px 12px; }
  .lines::-webkit-scrollbar { display: none; }
  .ln { flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: 11px/1.7 var(--mono); color: var(--text-dim); }
  .ln.user { color: var(--text); }
  .ln.tool { color: var(--text-faint); }
  .ln.think, .ln.pill { color: var(--text-faint); font-style: italic; }
  .ln.err, .ln.perm { color: var(--alert); }
  .cursor { flex: none; width: 7px; height: 13px; margin-top: 2px; background: var(--text-dim); animation: breathe 1.1s steps(2, start) infinite; }

  /* compact markdown: readable, quiet, never breaking the tile */
  .md { flex: none; min-width: 0; color: var(--text-dim); font-size: 12px; line-height: 1.55; overflow-wrap: anywhere; }
  .md :global(p), .md :global(ul), .md :global(ol) { margin: 0 0 4px; }
  .md :global(ul), .md :global(ol) { padding-left: 18px; }
  .md :global(:last-child) { margin-bottom: 0; }
  .md :global(h1), .md :global(h2), .md :global(h3), .md :global(h4) { margin: 4px 0 3px; color: var(--text); font-size: 12px; font-weight: var(--w-med); letter-spacing: .04em; }
  .md :global(strong) { color: var(--text); font-weight: var(--w-med); }
  .md :global(code) { font: 11px var(--mono); color: var(--text); background: rgba(255,255,255,.06); padding: 1px 4px; }
  .md :global(pre) { margin: 3px 0 4px; padding: 7px 9px; background: rgba(255,255,255,.04); overflow: hidden; }
  .md :global(pre code) { background: none; padding: 0; display: block; white-space: pre-wrap; overflow-wrap: anywhere; }
  .md :global(a) { color: var(--text-dim); text-decoration: underline; text-underline-offset: 2px; pointer-events: none; }
  .md :global(blockquote) { margin: 0 0 4px; padding-left: 10px; border-left: 2px solid var(--seam); }
  .md :global(table) { font-size: 11px; }

  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .dot.busy, .cursor { animation: none; } }
</style>
