import assert from 'node:assert/strict';
import { buildRows, clip, diffTone, fmtAge, rowActions, rowView, selectable, tailReduce } from './tuiView.mjs';

// buildRows: needs-you first, then review pile, queue, herd; empty sections vanish
{
  const rows = buildRows({
    sessions: [
      { id: 'a', label: 'corral release', status: 'busy', pendingPerm: { tool: 'Edit', summary: 'README.md' } },
      { id: 'b', label: 'market feed', status: 'busy', agent: 'codex' },
    ],
    jobs: [
      { id: 'j1', status: 'landed', label: 'tighten readme', dir: '/x/corral', diffstat: { add: 14, del: 6, files: 2, untracked: 1 } },
      { id: 'j2', status: 'queued', label: 'flaky test', dir: '/x/corral' },
      { id: 'j3', status: 'kept', label: 'done already', dir: '/x/corral' },
    ],
  });
  assert.deepEqual(rows.map((r) => r.kind), ['head', 'perm', 'head', 'job', 'head', 'job', 'head', 'session']);
  assert.deepEqual(rows.filter((r) => r.kind === 'head').map((r) => r.label), ['NEEDS YOU', 'FRESH DIFFS', 'QUEUE', 'HERD']);
  assert.equal(rows.filter(selectable).length, 4);        // kept job never shows
}
assert.deepEqual(buildRows({}), []);

// rowView: operator words, diffstat only when reviewable, ages
{
  const perm = rowView({ kind: 'perm', s: { label: 'rel', agent: 'claude', pendingPerm: { tool: 'Edit', summary: 'README.md' } } });
  assert.equal(perm.left, 'rel  wants Edit README.md');
  assert.equal(perm.tone, 'ask');
  const job = rowView({ kind: 'job', j: { label: 'x', dir: '/p/corral', status: 'landed', diffstat: { add: 1, del: 2, files: 1 } } });
  assert.ok(job.left.includes('diff ready') && job.left.includes('+1 −2'));
  const queued = rowView({ kind: 'job', j: { label: 'x', dir: '/p/corral', status: 'queued', diffstat: { add: 9 } } });
  assert.ok(!queued.left.includes('+9'));                 // no diffstat until it lands
  const sess = rowView({ kind: 'session', s: { label: 's', status: 'busy', agent: 'codex', host: 'gpu-box', updatedAt: 1000 } }, 61_000 + 1000);
  assert.equal(sess.left, 's  busy · 1m');
  assert.equal(sess.right, 'codex · gpu-box');
}

// rowActions: only what the row can actually do
assert.deepEqual(rowActions({ kind: 'job', j: { status: 'landed' } }), ['enter diff', 'k keep', 'b bounce']);
assert.deepEqual(rowActions({ kind: 'job', j: { status: 'failed' } }), ['b bounce']);
assert.deepEqual(rowActions({ kind: 'job', j: { status: 'queued' } }), ['x remove']);
assert.deepEqual(rowActions({ kind: 'job', j: { status: 'running' } }), []);
assert.deepEqual(rowActions({ kind: 'perm', s: {} }), ['a allow', 'd deny', 'enter open']);
assert.deepEqual(rowActions(null), []);

// fmtAge / clip / diffTone
assert.equal(fmtAge(30_000), 'now');
assert.equal(fmtAge(5 * 60_000), '5m');
assert.equal(fmtAge(3 * 3600_000), '3h');
assert.equal(fmtAge(49 * 3600_000), '2d');
assert.equal(clip('abcdef', 4), 'abc…');
assert.equal(clip('ab', 4), 'ab');
assert.equal(diffTone('+new line'), 'add');
assert.equal(diffTone('-gone'), 'del');
assert.equal(diffTone('+++ b/x'), 'meta');
assert.equal(diffTone('@@ -1 +1 @@'), 'hunk');
assert.equal(diffTone(' ctx'), 'ctx');

// tailReduce: deltas stream into one line, tools and asks punctuate, permission round-trips
{
  let st = tailReduce(null, { type: '_user', text: 'go' });
  st = tailReduce(st, { type: 'stream_event', event: { type: 'content_block_start', content_block: { type: 'tool_use', name: 'Bash' } } });
  st = tailReduce(st, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'hel' } } });
  st = tailReduce(st, { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'lo\nworld' } } });
  st = tailReduce(st, { type: '_permission_request', id: 'p1', tool: 'Edit' });
  assert.deepEqual(st.lines.map((l) => l.text), ['you: go', '▸ Bash', 'hello', 'world', '? wants Edit  [a]llow [d]eny']);
  assert.equal(st.ask.id, 'p1');
  st = tailReduce(st, { type: '_permission_resolved', decision: 'allow' });
  assert.equal(st.ask, null);
  st = tailReduce(st, { type: 'result' });
  assert.equal(st.lines.at(-1).text, '— turn done —');
}
// bounded scrollback
{
  let st = { lines: [], open: false, ask: null };
  for (let i = 0; i < 600; i++) st = tailReduce(st, { type: '_user', text: 'm' + i });
  assert.equal(st.lines.length, 500);
  assert.equal(st.lines[0].text, 'you: m100');
}

console.log('tuiView tests ok');
