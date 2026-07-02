import assert from 'node:assert/strict';
import { dashboardRecentProjects } from './dashboardRecentProjects.mjs';

const groups = [
  { host: 'local', label: 'This computer' },
  { host: 'gb300', label: 'gb300' },
  { host: 'kept', label: 'kept' },
];

function blendsRecentRootsAndSessions() {
  const projects = dashboardRecentProjects({
    groups,
    roots: [
      { host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 100 },
      { host: 'gb300', dir: '/mnt/data/mark/projects/test', ts: 200 },
      { host: 'unknown', dir: '/skip/me', ts: 900 },
    ],
    sessions: [
      { host: 'gb300', cwd: '/mnt/data/mark/projects/test', updatedAt: 800 },
      { host: 'kept', cwd: '/srv/tools', updatedAt: 700 },
      { host: 'local', cwd: 'C:/D_Drive/projects/codapp', updatedAt: 300 },
    ],
    hostCards: [
      { host: 'local', canLaunch: true, launchBlockedLabel: '' },
      { host: 'gb300', canLaunch: false, launchBlockedLabel: 'gb300 is offline: SSH probe failed' },
      { host: 'kept', canLaunch: true, launchBlockedLabel: '' },
    ],
    limit: 4,
  });

  assert.deepEqual(projects.map((p) => [p.host, p.hostLabel, p.name, p.dir, p.source, p.canLaunch, p.launchBlockedLabel]), [
    ['gb300', 'gb300', 'test', '/mnt/data/mark/projects/test', 'session', false, 'gb300 is offline: SSH probe failed'],
    ['kept', 'kept', 'tools', '/srv/tools', 'session', true, ''],
    ['local', 'this computer', 'codapp', 'C:/D_Drive/projects/codapp', 'session', true, ''],
  ]);
}

function respectsLimitAfterGlobalSort() {
  const projects = dashboardRecentProjects({
    groups,
    roots: [
      { host: 'local', dir: '/older', ts: 10 },
      { host: 'gb300', dir: '/newer', ts: 40 },
      { host: 'kept', dir: '/middle', ts: 30 },
    ],
    sessions: [],
    limit: 2,
  });

  assert.deepEqual(projects.map((p) => p.dir), ['/newer', '/middle']);
}

blendsRecentRootsAndSessions();
respectsLimitAfterGlobalSort();

console.log('dashboardRecentProjects tests ok');
