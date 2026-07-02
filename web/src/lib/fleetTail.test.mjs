import assert from 'node:assert/strict';
import { applyTailEvent, createTailState, TAIL_CAP } from './fleetTail.mjs';

function streamsTextDeltasAsALiveLastLine() {
  const st = createTailState();
  applyTailEvent(st, { type: '_user', text: 'fix the login bug' });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking at auth.js\nThe bug is in ' } } });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'validateToken' } } });

  assert.equal(st.lines[0].text, '> fix the login bug');
  assert.equal(st.lines[1].text, 'The bug is in validateToken');   // live line tracks the last line

  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  // finished multi-line block expands to its tail lines
  assert.deepEqual(st.lines.slice(1).map((l) => l.text), ['Looking at auth.js', 'The bug is in validateToken']);
}

function showsToolUseWithSummary() {
  const st = createTailState();
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } } });
  assert.equal(st.lines[0].text, 'Bash');
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } } });
  assert.equal(st.lines[0].text, 'Bash  npm test');
  assert.equal(st.lines[0].kind, 'tool');
}

function replaysCompleteAssistantEventsOnlyWhenNotStreamed() {
  const st = createTailState();
  applyTailEvent(st, { type: 'assistant', message: { content: [{ type: 'text', text: 'a\nb\nc\nd' }, { type: 'tool_use', name: 'Read', input: { file_path: '/x.js' } }] } });
  assert.deepEqual(st.lines.map((l) => l.text), ['b', 'c', 'd', 'Read  /x.js']);   // last 3 lines + tool

  const streamed = createTailState();
  applyTailEvent(streamed, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  applyTailEvent(streamed, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } });
  const before = streamed.lines.length;
  assert.equal(applyTailEvent(streamed, { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }), false);
  assert.equal(streamed.lines.length, before);   // no double-append after deltas drew it
}

function marksResultsPermissionsAndEndings() {
  const st = createTailState();
  applyTailEvent(st, { type: '_permission_request', tool: 'Bash', id: 'p1' });
  applyTailEvent(st, { type: 'result', total_cost_usd: 0.1234 });
  applyTailEvent(st, { type: '_exit', code: 0 });
  assert.deepEqual(st.lines.map((l) => [l.kind, l.text]), [
    ['perm', 'waiting for permission: Bash'],
    ['pill', 'turn complete · $0.12'],
    ['err', 'session ended (code 0)'],
  ]);
  assert.equal(st.streamed, false);   // result resets the stream flag so replayed assistants render
}

function capsTheTail() {
  const st = createTailState();
  for (let i = 0; i < TAIL_CAP + 9; i += 1) applyTailEvent(st, { type: '_user', text: 'msg ' + i });
  assert.equal(st.lines.length, TAIL_CAP);
  assert.equal(st.lines[TAIL_CAP - 1].text, '> msg ' + (TAIL_CAP + 8));
}

streamsTextDeltasAsALiveLastLine();
showsToolUseWithSummary();
replaysCompleteAssistantEventsOnlyWhenNotStreamed();
marksResultsPermissionsAndEndings();
capsTheTail();

console.log('fleetTail tests ok');
