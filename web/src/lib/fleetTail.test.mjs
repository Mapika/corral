import assert from 'node:assert/strict';
import { applyTailEvent, createTailState, TAIL_CAP, TEXT_CAP } from './fleetTail.mjs';

function streamsTextDeltasIntoOneGrowingBlock() {
  const st = createTailState();
  applyTailEvent(st, { type: '_user', text: 'fix the login bug' });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking at **auth.js**\nThe bug is in ' } } });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '`validateToken`' } } });

  assert.equal(st.lines.length, 2);                       // one user marker + ONE text block
  assert.equal(st.lines[0].text, '> fix the login bug');
  assert.equal(st.lines[1].text, 'Looking at **auth.js**\nThe bug is in `validateToken`');

  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  assert.equal(st.lines.length, 2);                       // stop keeps the block, adds nothing
}

function showsToolUseWithSummary() {
  const st = createTailState();
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Bash' } } });
  assert.equal(st.lines[0].text, 'Bash');
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"npm test"}' } } });
  assert.equal(st.lines[0].text, 'Bash  npm test');
  assert.equal(st.lines[0].kind, 'tool');
}

function cumulativeAssistantEventsReplaceNotAppend() {
  const st = createTailState();
  // the CLI re-emits the same message id as content grows
  applyTailEvent(st, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Plan:' }] } });
  applyTailEvent(st, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Plan:\n- step one' }] } });
  applyTailEvent(st, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Plan:\n- step one\n- step two' }, { type: 'tool_use', name: 'Write', input: { file_path: 'x.md' } }] } });

  assert.deepEqual(st.lines.map((l) => [l.kind, l.text]), [
    ['text', 'Plan:\n- step one\n- step two'],
    ['tool', 'Write  x.md'],
  ]);

  // a NEW message id appends after the previous one
  applyTailEvent(st, { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'Done.' }] } });
  assert.equal(st.lines.length, 3);
  assert.equal(st.lines[2].text, 'Done.');
}

function assistantEventsAreSkippedWhenDeltasAlreadyDrew() {
  const st = createTailState();
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
  applyTailEvent(st, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } } });
  const before = st.lines.length;
  assert.equal(applyTailEvent(st, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] } }), false);
  assert.equal(st.lines.length, before);
}

function longTextKeepsItsFreshTail() {
  const st = createTailState();
  const long = Array.from({ length: 200 }, (_, i) => 'line number ' + i).join('\n');
  applyTailEvent(st, { type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: long }] } });
  assert.ok(st.lines[0].text.length <= TEXT_CAP + 1);
  assert.ok(st.lines[0].text.startsWith('…'));
  assert.ok(st.lines[0].text.endsWith('line number 199'));
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
  assert.equal(st.streamed, false);
  assert.equal(st.msgKey, null);   // result resets message tracking for the next turn
}

function capsTheTail() {
  const st = createTailState();
  for (let i = 0; i < TAIL_CAP + 9; i += 1) applyTailEvent(st, { type: '_user', text: 'msg ' + i });
  assert.equal(st.lines.length, TAIL_CAP);
  assert.equal(st.lines[TAIL_CAP - 1].text, '> msg ' + (TAIL_CAP + 8));
}

streamsTextDeltasIntoOneGrowingBlock();
showsToolUseWithSummary();
cumulativeAssistantEventsReplaceNotAppend();
assistantEventsAreSkippedWhenDeltasAlreadyDrew();
longTextKeepsItsFreshTail();
marksResultsPermissionsAndEndings();
capsTheTail();

console.log('fleetTail tests ok');
