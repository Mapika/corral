import assert from 'node:assert/strict';
import { buildHostCards, hostTone, needsHostStatusFollowUp } from './hostHealth.mjs';

const groups = [
  { host: 'local', label: 'This computer' },
  { host: 'gb300', label: 'gb300' },
  { host: 'tars', label: 'tars' },
  { host: 'idlebox', label: 'idlebox' },
  { host: 'noisy', label: 'noisy' },
  { host: 'checking', label: 'checking' },
];

const sessions = [
  { host: 'local', status: 'busy' },
  { host: 'gb300', status: 'dormant' },
  { host: 'gb300', status: 'idle' },
];

const statuses = [
  { name: 'gb300', ok: true, tmux: [{ name: 'work', path: '/tmp', attached: true, windows: 2 }, { name: 'api', path: '/srv/api', attached: false, windows: 1 }], cc: [{ status: 'busy' }] },
  { name: 'tars', ok: false, error: 'ssh: connect to host tars port 22: Connection timed out' },
  { name: 'idlebox', ok: false, error: 'Command failed: C:\\Windows\\System32\\OpenSSH\\ssh.exe -o BatchMode=yes -o ConnectTimeout=8 idlebox tmux\nTimed out waiting for handshake' },
  { name: 'noisy', ok: false, error: 'Command failed: C:\\Windows\\System32\\OpenSSH\\ssh.exe -o BatchMode=yes -o ConnectTimeout=8 noisy tmux list-sessions' },
  { name: 'checking', ok: null, stale: true },
];

function mergesGroupsWithStatus() {
  const cards = buildHostCards({ groups, sessions, statuses });
  assert.deepEqual(cards.map((c) => [c.host, c.tone, c.statusLabel, c.detail, c.sessions]), [
    ['local', 'local', 'local', 'this computer', 1],
    ['gb300', 'online', 'online', '2 tmux / 1 agent', 2],
    ['tars', 'offline', 'offline', 'Connection timed out', 0],
    ['idlebox', 'offline', 'offline', 'Connection timed out', 0],
    ['noisy', 'offline', 'offline', 'SSH probe failed', 0],
    ['checking', 'unknown', 'checking', 'probe in progress', 0],
  ]);
}

function classifiesHostTone() {
  assert.equal(hostTone({ host: 'local' }), 'local');
  assert.equal(hostTone({ host: 'x', ok: true }), 'online');
  assert.equal(hostTone({ host: 'x', ok: false }), 'offline');
  assert.equal(hostTone({ host: 'x' }), 'unknown');
}

function exposesTmuxTargets() {
  const cards = buildHostCards({ groups, sessions, statuses });
  assert.deepEqual(cards.find((c) => c.host === 'gb300').tmuxTargets, [
    { name: 'work', path: '/tmp', attached: true, windows: 2, views: 1 },
    { name: 'api', path: '/srv/api', attached: false, windows: 1, views: 1 },
  ]);
  assert.deepEqual(cards.find((c) => c.host === 'local').tmuxTargets, []);
}

function collapsesGroupedTmuxViews() {
  const cards = buildHostCards({
    groups: [{ host: 'local', label: 'This computer' }, { host: 'gb300', label: 'gb300' }],
    sessions: [],
    statuses: [{
      name: 'gb300', ok: true, cc: [],
      tmux: [
        { name: '1', group: '1', path: '/a', attached: false, windows: 5 },
        { name: '1-48', group: '1', path: '/b', attached: true, windows: 5 },
        { name: 'solo', path: '/c', attached: false, windows: 1 },
      ],
    }],
  });
  const card = cards.find((c) => c.host === 'gb300');
  assert.deepEqual(card.tmuxTargets, [
    { name: '1', path: '/b', attached: true, windows: 5, views: 2 },   // the attached view's path wins
    { name: 'solo', path: '/c', attached: false, windows: 1, views: 1 },
  ]);
  assert.equal(card.detail, '2 tmux / 0 agents');                      // collapsed count matches the rows
}
collapsesGroupedTmuxViews();

function marksLaunchAvailability() {
  const cards = buildHostCards({ groups, sessions, statuses });
  assert.deepEqual(cards.map((c) => [c.host, c.canLaunch, c.launchBlockedLabel]), [
    ['local', true, ''],
    ['gb300', true, ''],
    ['tars', false, 'tars is offline: Connection timed out'],
    ['idlebox', false, 'idlebox is offline: Connection timed out'],
    ['noisy', false, 'noisy is offline: SSH probe failed'],
    ['checking', false, 'checking is still checking'],
  ]);
  assert.equal(buildHostCards({ groups: [{ host: 'unprobed', label: 'unprobed' }], sessions: [], statuses: [] })[0].canLaunch, true);
}

function detectsFollowUpNeeds() {
  assert.equal(needsHostStatusFollowUp([{ name: 'checking', ok: null, stale: true }]), true);
  assert.equal(needsHostStatusFollowUp([{ name: 'gb300', ok: true, stale: true }]), false);
  assert.equal(needsHostStatusFollowUp([{ name: 'gb300', ok: true }]), false);
  assert.equal(needsHostStatusFollowUp([]), false);
}

function classifiesWindowsShellError() {
  const cards = buildHostCards({
    groups: [{ host: 'winbox', label: 'winbox' }],
    sessions: [],
    statuses: [{ name: 'winbox', ok: false, error: "'bash' is not recognized as an internal or external command,\noperable program or batch file." }],
  });
  assert.equal(cards[0].detail, 'Incompatible shell — needs a POSIX/bash host');
  assert.equal(cards[0].launchBlockedLabel, 'winbox is offline: Incompatible shell — needs a POSIX/bash host');
}

mergesGroupsWithStatus();
classifiesHostTone();
classifiesWindowsShellError();
exposesTmuxTargets();
marksLaunchAvailability();
detectsFollowUpNeeds();

console.log('hostHealth tests ok');
