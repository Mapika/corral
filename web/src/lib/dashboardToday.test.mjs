import assert from 'node:assert/strict';
import { dashboardSummaryStats, dashboardToday } from './dashboardToday.mjs';

const now = Date.UTC(2026, 5, 29, 10, 0, 0);

function buildsFourSummaryStats() {
  const stats = dashboardSummaryStats({ running: 2, dormant: 3, activeTunnels: 1, hosts: 4, stale: 1, failed: 1 });

  assert.deepEqual(stats.map((stat) => stat.id), ['running', 'parked', 'hosts', 'tunnels']);
  assert.equal(stats[0].value, 2);
  assert.equal(stats[1].detail, '1 stale');
  assert.deepEqual(stats[3].action, { kind: 'tunnels' });
}

function prioritizesAttentionSessionsBeforeRecentProjects() {
  const view = dashboardToday({
    now,
    recentProjects: [{ host: 'local', dir: 'C:/work/calm', name: 'calm', hostLabel: 'This computer' }],
    hostCards: [{ host: 'local', label: 'This computer' }],
    sessions: [
      { id: 'idle-1', host: 'local', cwd: 'C:/work/idle', status: 'idle', updatedAt: now - 60_000 },
      { id: 'stale-1', host: 'gb300', cwd: '/srv/test', status: 'dormant', sessionId: 'abc', updatedAt: now - 5 * 60 * 60 * 1000 },
    ],
  });

  assert.equal(view.title, 'Needs attention');
  assert.equal(view.items[0].id, 'session:stale-1');
  assert.equal(view.items[0].primaryLabel, 'Inspect');
  assert.equal(view.items[0].tone, 'alert');
}

function fallsBackToContinueWork() {
  const view = dashboardToday({
    now,
    sessions: [],
    hostCards: [],
    recentProjects: [{ host: 'local', dir: 'C:/work/calm', name: 'calm', hostLabel: 'This computer', canLaunch: true }],
  });

  assert.equal(view.title, 'Continue work');
  assert.equal(view.items[0].id, 'project:local:C:/work/calm');
  assert.equal(view.items[0].primaryLabel, 'New chat');
}

function offlineHostsAreAFootnoteNotAlarms() {
  const view = dashboardToday({
    now,
    sessions: [],
    recentProjects: [],
    hostCards: [
      { host: 'alpha', label: 'alpha', tone: 'offline' },
      { host: 'bravo', label: 'bravo', tone: 'unknown' },
      { host: 'charlie', label: 'charlie', tone: 'online' },
    ],
  });

  assert.equal(view.items.length, 0);                       // no attention rows from host state
  assert.equal(view.note.label, 'alpha is unreachable');    // probes in flight don't count
  assert.deepEqual(view.note.hosts, ['alpha']);

  const two = dashboardToday({
    now,
    hostCards: [
      { host: 'alpha', tone: 'offline' },
      { host: 'bravo', tone: 'offline' },
    ],
  });
  assert.equal(two.note.label, '2 hosts unreachable');
}

function firstRunGetsOnboardingEmptyState() {
  const fresh = dashboardToday({ now, sessions: [], recentProjects: [], hostCards: [] });
  assert.equal(fresh.empty.title, 'No agents in the corral yet.');
  assert.ok(fresh.empty.hint.includes('ssh config'));

  const quiet = dashboardToday({
    now,
    sessions: [{ id: 'b1', host: 'local', cwd: 'C:/work/x', status: 'busy', updatedAt: now }],
    recentProjects: [],
    hostCards: [],
  });
  assert.equal(quiet.title, 'Needs attention');             // busy session is live -> attention list
}

buildsFourSummaryStats();
prioritizesAttentionSessionsBeforeRecentProjects();
fallsBackToContinueWork();
offlineHostsAreAFootnoteNotAlarms();
firstRunGetsOnboardingEmptyState();

console.log('dashboardToday tests ok');
