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

remembersAndNormalizesRoots();
dedupesByHostAndPath();
cleansExistingListWhenNewRootInvalid();
separatesHosts();
blendsStoredAndSessionRoots();
keepsRecentSourceOnTimestampTie();
parsesStorageDefensively();

console.log('recentRoots tests ok');
