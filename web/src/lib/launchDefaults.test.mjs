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

// hostile storage shapes
assert.deepEqual(parseLaunchDefaults('not json'), {});
assert.deepEqual(parseLaunchDefaults('[1,2]'), {});
assert.deepEqual(parseLaunchDefaults(null), {});
assert.equal(launchDefaultsFor({ 'local\0/x': 'garbage' }, 'local', '/x'), null);

console.log('launchDefaults tests ok');
