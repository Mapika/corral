import assert from 'node:assert/strict';
import { defaultRanchName, mergeSessions, parseRanches, removeRanch, renameRanch, serializeRanches, sessionKey, upsertRanch } from './ranches.mjs';

// parse/serialize round-trip; junk in = empty roster out
{
  const { list } = upsertRanch([], { base: 'http://10.0.0.2:7879', token: 'aabbccddeeff0011', name: 'homelab', now: 5 });
  const back = parseRanches(serializeRanches(list));
  assert.equal(back.length, 1);
  assert.deepEqual(back[0], list[0]);
}
assert.deepEqual(parseRanches(''), []);
assert.deepEqual(parseRanches('{"nope":1}'), []);
assert.deepEqual(parseRanches('[{"base":"http://x"}]'), []);            // no token/id = not a pairing
assert.deepEqual(parseRanches('not json'), []);

// upsert: new base appends with a fresh stable id; same base refreshes the token in place
{
  let { list } = upsertRanch([], { base: 'http://10.0.0.2:7879', token: 't1', name: 'desktop', now: 1 });
  const firstId = list[0].id;
  assert.ok(firstId);
  const again = upsertRanch(list, { base: 'http://10.0.0.2:7879', token: 't2', name: 'ignored', now: 2 });
  assert.equal(again.refreshed, true);
  assert.equal(again.list.length, 1);
  assert.equal(again.list[0].id, firstId);                              // identity survives re-pairing
  assert.equal(again.list[0].name, 'desktop');                          // so does the operator's name
  assert.equal(again.list[0].token, 't2');
  const other = upsertRanch(again.list, { base: 'http://10.0.0.3:7879', token: 't3', name: 'office', now: 3 });
  assert.equal(other.refreshed, false);
  assert.equal(other.list.length, 2);
  assert.notEqual(other.list[1].id, firstId);
}

// name collisions get suffixed instead of shadowing each other
{
  let { list } = upsertRanch([], { base: 'http://a:7879', token: 't', name: 'desktop' });
  ({ list } = upsertRanch(list, { base: 'http://b:7879', token: 't', name: 'desktop' }));
  ({ list } = upsertRanch(list, { base: 'http://c:7879', token: 't', name: 'Desktop' }));
  assert.deepEqual(list.map((r) => r.name), ['desktop', 'desktop 2', 'Desktop 3']);
}

// names living outside the persisted list (origin/pocket ranches) count as taken too
{
  const { ranch } = upsertRanch([], { base: 'http://b:7879', token: 't', name: 'demo-ranch', taken: ['demo-ranch'] });
  assert.equal(ranch.name, 'demo-ranch 2');
}

// rename: trims, caps, keeps uniqueness, ignores empties
{
  let { list } = upsertRanch([], { base: 'http://a:7879', token: 't', name: 'one' });
  ({ list } = upsertRanch(list, { base: 'http://b:7879', token: 't', name: 'two' }));
  list = renameRanch(list, list[1].id, '  the office  ');
  assert.equal(list[1].name, 'the office');
  list = renameRanch(list, list[1].id, 'one');
  assert.equal(list[1].name, 'one 2');                                  // collision suffixed
  list = renameRanch(list, list[1].id, '   ');
  assert.equal(list[1].name, 'one 2');                                  // empty rename is a no-op
  assert.equal(removeRanch(list, list[0].id).length, 1);
}

// default names: hostname from the server wins, else the base's host
assert.equal(defaultRanchName('http://10.0.0.2:7879', 'workbench'), 'workbench');
assert.equal(defaultRanchName('http://10.0.0.2:7879', ''), '10.0.0.2');
assert.equal(defaultRanchName('https://corral.tail1234.ts.net:7879'), 'corral.tail1234.ts.net');

// merged herd: roster order, ranch tags, cross-server key uniqueness
{
  const ranches = [{ id: 'r1', name: 'desktop' }, { id: 'r2', name: 'homelab' }];
  const merged = mergeSessions(ranches, { r2: [{ id: 's1' }], r1: [{ id: 's1' }, { id: 's2' }] });
  assert.deepEqual(merged.map(sessionKey), ['r1:s1', 'r1:s2', 'r2:s1']);
  assert.equal(merged[0].ranchName, 'desktop');
  assert.equal(merged[2].ranchName, 'homelab');
}

console.log('ranches tests ok');
