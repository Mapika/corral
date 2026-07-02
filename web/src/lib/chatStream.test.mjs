import assert from 'node:assert/strict';
import { createChatState, handleChatEvent, openPermissions, summarize, toText } from './chatStream.mjs';

const md = (s) => '<md>' + s + '</md>';

// A full streamed turn: user -> deltas -> tool + result -> permission -> resolve -> result
{
  const st = createChatState();
  assert.equal(handleChatEvent(st, { type: '_user', text: 'ship it' }, md), true);
  assert.equal(st.status, 'busy');
  assert.deepEqual(st.items[0], { kind: 'op', text: 'ship it' });

  handleChatEvent(st, { type: 'stream_event', event: { type: 'message_start' } }, md);
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }, md);
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'On <it>' } } }, md);
  const turn = st.items[1];
  assert.equal(turn.kind, 'asst');
  assert.ok(turn.blocks[0].html.includes('&lt;it&gt;'));            // live deltas render escaped, not raw
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } }, md);
  assert.equal(turn.blocks[0].html, '<md>On <it></md>');            // snaps to full markdown on stop

  // tool block streams its input json, then picks up its result by id
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'Bash' } } }, md);
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } } }, md);
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_stop', index: 1 } }, md);
  assert.equal(turn.blocks[1].summary, 'npm test');
  handleChatEvent(st, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok', is_error: false }] } }, md);
  assert.equal(turn.blocks[1].result, 'ok');

  // permission prompt appears, resolves in place
  handleChatEvent(st, { type: '_permission_request', id: 'p1', tool: 'Edit', input: { file_path: '/x.js' } }, md);
  assert.equal(openPermissions(st).length, 1);
  assert.equal(openPermissions(st)[0].summary, '/x.js');
  handleChatEvent(st, { type: '_permission_resolved', id: 'p1', decision: 'allow' }, md);
  assert.equal(openPermissions(st).length, 0);
  assert.equal(st.items.find((i) => i.kind === 'perm').resolved, 'allow');

  handleChatEvent(st, { type: 'result', total_cost_usd: 0.12, usage: { input_tokens: 900, output_tokens: 40 } }, md);
  assert.equal(st.status, 'idle');
  assert.deepEqual(st.usage, { cost: 0.12, in: 900, out: 40 });
}

// Non-streamed (reattach) path: complete assistant messages append blocks once
{
  const st = createChatState();
  handleChatEvent(st, { type: 'assistant', message: { content: [
    { type: 'thinking', thinking: 'hmm' },
    { type: 'text', text: 'done' },
    { type: 'tool_use', id: 't2', name: 'Read', input: { file_path: 'a.md' } },
  ] } }, md);
  const turn = st.items[0];
  assert.deepEqual(turn.blocks.map((b) => b.type), ['thinking', 'text', 'tool']);
  assert.equal(turn.blocks[2].summary, 'a.md');
  // a second cumulative assistant event while streaming is live must not duplicate
  handleChatEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } }, md);
  handleChatEvent(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'dup?' }] } }, md);
  assert.equal(st.items.length, 1);
}

// Terminal events flip status and pill the transcript
{
  const st = createChatState();
  handleChatEvent(st, { type: '_error', message: 'boom' }, md);
  assert.equal(st.status, 'error');
  assert.equal(st.items[0].err, true);
  const st2 = createChatState();
  handleChatEvent(st2, { type: '_exit', code: 1 }, md);
  assert.equal(st2.status, 'exited');
  assert.ok(st2.items[0].text.includes('code 1'));
  const st3 = createChatState();
  st3.stopped = true;
  handleChatEvent(st3, { type: 'result' }, md);
  assert.equal(st3.items[0].text, 'Stopped');
  assert.equal(st3.stopped, false);
}

// helpers
assert.equal(summarize({ command: 'ls -la' }), 'ls -la');
assert.equal(summarize({ weird: 1 }), '{"weird":1}');
assert.equal(toText([{ type: 'text', text: 'a' }, 'b']), 'a\nb');

console.log('chatStream tests ok');
