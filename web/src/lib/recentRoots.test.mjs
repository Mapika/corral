import assert from 'node:assert/strict';
import { parseRecentRoots, recentRootsForHost, rememberLaunchRoot, serializeRecentRoots } from './recentRoots.mjs';

function remembersAndNormalizesRoots() {
  const roots = rememberLaunchRoot([], { host: 'local', dir: 'C:\\D_Drive\\projects\\codapp\\', ts: 100 });
  assert.deepEqual(roots, [{ host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 100 }]);
}

function dedupesByHostAndPath() {
  const roots = rememberLaunchRoot(
    [{ host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 100 }],
    { host: 'local', dir: 'C:/D_Drive/projects/codapp/', ts: 200 },
  );
  assert.deepEqual(roots, [{ host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 200 }]);
}

function cleansExistingListWhenNewRootInvalid() {
  const roots = rememberLaunchRoot(
    [
      { host: 'local', dir: 'C:\\D_Drive\\projects\\codapp\\', ts: 200 },
      { host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 100 },
      { host: '', dir: '', ts: 'bad' },
    ],
    { host: 'local', dir: '' },
  );
  assert.deepEqual(roots, [{ host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 200 }]);
}

function separatesHosts() {
  const roots = rememberLaunchRoot(
    [{ host: 'local', dir: '/work/app', ts: 100 }],
    { host: 'gb300', dir: '/work/app', ts: 200 },
  );
  assert.deepEqual(roots.map((r) => r.host + ':' + r.dir), ['gb300:/work/app', 'local:/work/app']);
}

function blendsStoredAndSessionRoots() {
  const roots = recentRootsForHost({
    host: 'local',
    roots: [{ host: 'local', dir: '/older/app', ts: 100 }],
    sessions: [
      { host: 'local', cwd: '/active/api', updatedAt: 500 },
      { host: 'local', cwd: '/older/app', updatedAt: 300 },
      { host: 'gb300', cwd: '/remote/app', updatedAt: 900 },
    ],
    limit: 3,
  });
  assert.deepEqual(roots.map((r) => [r.dir, r.source, r.ts]), [
    ['/active/api', 'session', 500],
    ['/older/app', 'session', 300],
  ]);
}

function keepsRecentSourceOnTimestampTie() {
  const roots = recentRootsForHost({
    host: 'local',
    roots: [{ host: 'local', dir: '/shared/app', ts: 400 }],
    sessions: [{ host: 'local', cwd: '/shared/app', updatedAt: 400 }],
    limit: 5,
  });
  assert.deepEqual(roots.map((r) => [r.dir, r.source, r.ts]), [
    ['/shared/app', 'recent', 400],
  ]);
}

function parsesStorageDefensively() {
  assert.deepEqual(parseRecentRoots('not json'), []);
  assert.deepEqual(parseRecentRoots(JSON.stringify([{ host: 'local', dir: '/x', ts: 10 }, { host: '', dir: '', ts: 'bad' }])), [
    { host: 'local', dir: '/x', ts: 10 },
  ]);
  assert.equal(serializeRecentRoots([{ host: 'local', dir: '/x', ts: 10 }]), '[{"host":"local","dir":"/x","ts":10}]');
}

function separatesRanchesButLetsUntaggedMatchAnywhere() {
  // Same dir on two ranches = two stored entries; an untagged (pre-0.6) entry is a third.
  let roots = rememberLaunchRoot([], { ranch: 'r1', host: 'local', dir: '/work/app', ts: 100 });
  roots = rememberLaunchRoot(roots, { ranch: 'r2', host: 'local', dir: '/work/app', ts: 200 });
  roots = rememberLaunchRoot(roots, { host: 'local', dir: '/legacy/app', ts: 50 });
  assert.equal(roots.length, 3);
  assert.deepEqual(parseRecentRoots(serializeRecentRoots(roots)), roots);   // ranch tag survives storage

  // Filtering for r1: its own entry + the untagged one; r2's stays out.
  const forR1 = recentRootsForHost({ ranch: 'r1', host: 'local', roots, sessions: [] });
  assert.deepEqual(forR1.map((r) => r.dir), ['/work/app', '/legacy/app']);

  // Ranch-tagged sessions filter the same way, and same-dir rows collapse across tag styles.
  const merged = recentRootsForHost({
    ranch: 'r1', host: 'local',
    roots: [{ host: 'local', dir: '/work/app', ts: 100 }],
    sessions: [{ ranch: 'r1', host: 'local', cwd: '/work/app', updatedAt: 300 }, { ranch: 'r2', host: 'local', cwd: '/other', updatedAt: 900 }],
  });
  assert.deepEqual(merged.map((r) => [r.dir, r.source]), [['/work/app', 'session']]);
}

remembersAndNormalizesRoots();
dedupesByHostAndPath();
cleansExistingListWhenNewRootInvalid();
separatesHosts();
blendsStoredAndSessionRoots();
keepsRecentSourceOnTimestampTie();
parsesStorageDefensively();
separatesRanchesButLetsUntaggedMatchAnywhere();

console.log('recentRoots tests ok');
