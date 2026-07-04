import assert from 'node:assert/strict';
import { launchDefaultsFor, parseLaunchDefaults, rememberLaunchDefaults, serializeLaunchDefaults } from './launchDefaults.mjs';

// round trip: remember -> serialize -> parse -> lookup
{
  let map = rememberLaunchDefaults({}, { host: 'gpu-box', dir: '/srv/app', agent: 'codex', perm: 'plan', model: 'gpt-5.3-codex', now: 5 });
  map = parseLaunchDefaults(serializeLaunchDefaults(map));
  assert.deepEqual(launchDefaultsFor(map, 'gpu-box', '/srv/app'), { agent: 'codex', perm: 'plan', model: 'gpt-5.3-codex', worktree: false });
  assert.equal(launchDefaultsFor(map, 'gpu-box', '/srv/other'), null);       // per-directory, not per-host
  assert.equal(launchDefaultsFor(map, 'local', '/srv/app'), null);
}

// defaults fill in; worktree round-trips
{
  const map = rememberLaunchDefaults({}, { host: 'local', dir: 'C:/x', worktree: true, now: 1 });
  assert.deepEqual(launchDefaultsFor(map, 'local', 'C:/x'), { agent: 'claude', perm: 'auto', model: null, worktree: true });
}

// cap: oldest entries fall off
{
  let map = {};
  for (let i = 0; i < 45; i += 1) map = rememberLaunchDefaults(map, { host: 'local', dir: '/p' + i, now: i });
  assert.equal(Object.keys(map).length, 40);
  assert.equal(launchDefaultsFor(map, 'local', '/p0'), null);                // evicted
  assert.ok(launchDefaultsFor(map, 'local', '/p44'));                        // newest kept
}

// ranch scoping: same dir on two ranches remembers different combos; pre-0.6 unscoped entries
// still resolve as the fallback when a ranch-scoped one doesn't exist yet
{
  let map = rememberLaunchDefaults({}, { host: 'local', dir: '/app', agent: 'codex', now: 1 });          // legacy
  map = rememberLaunchDefaults(map, { ranch: 'r1', host: 'local', dir: '/app', agent: 'claude', perm: 'plan', now: 2 });
  assert.equal(launchDefaultsFor(map, 'local', '/app', 'r1').perm, 'plan');
  assert.equal(launchDefaultsFor(map, 'local', '/app', 'r2').agent, 'codex');  // falls back to legacy
  assert.equal(launchDefaultsFor(map, 'local', '/app').agent, 'codex');        // unscoped lookup unaffected
}

// 0.8 identity keys: the combo follows the project to a checkout never launched from here,
// but any dir-scoped memory (ranch-scoped or legacy) still beats the project-wide default
{
  let map = rememberLaunchDefaults({}, { ranch: 'r1', host: 'local', dir: 'E:/corral', project: 'github.com/mapika/corral', agent: 'codex', perm: 'acceptEdits', now: 1 });
  assert.equal(launchDefaultsFor(map, 'local', '/home/m/corral', 'r2', 'github.com/mapika/corral').perm, 'acceptEdits');   // travels
  assert.equal(launchDefaultsFor(map, 'local', '/home/m/corral', 'r2'), null);                                             // no identity, no match
  assert.equal(launchDefaultsFor(map, 'local', '/home/m/corral', 'r2', 'github.com/other/repo'), null);
  map = rememberLaunchDefaults(map, { ranch: 'r2', host: 'local', dir: '/home/m/corral', agent: 'claude', perm: 'plan', now: 2 });
  assert.equal(launchDefaultsFor(map, 'local', '/home/m/corral', 'r2', 'github.com/mapika/corral').perm, 'plan');          // specific place wins
}

// hostile storage shapes
assert.deepEqual(parseLaunchDefaults('not json'), {});
assert.deepEqual(parseLaunchDefaults('[1,2]'), {});
assert.deepEqual(parseLaunchDefaults(null), {});
assert.equal(launchDefaultsFor({ 'local\0/x': 'garbage' }, 'local', '/x'), null);

console.log('launchDefaults tests ok');
