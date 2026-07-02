import assert from 'node:assert/strict';
import { isLiveSession, isResumableSession, isStaleResumableSession, lastActiveLabel, operatorAttention, operatorBriefLines, operatorBriefText, operatorMetrics, operatorNextActions, operatorStatCards, operatorWatchItems, operatorWorkWatch, sessionAction, sessionInspectAction, sessionSidebarView, sessionStatusLabel, sessionTone, sessionUsageTotals, sortSessionsForOperator } from './operatorStatus.mjs';

const sessions = [
  { id: 'idle-old', status: 'idle', createdAt: 1, updatedAt: 10, model: '' },
  { id: 'failed', status: 'error', createdAt: 2, updatedAt: 20 },
  { id: 'ended-resumable', status: 'exited', sessionId: 'abc', createdAt: 6, updatedAt: 60 },
  { id: 'dormant', status: 'dormant', createdAt: 3, updatedAt: 30 },
  { id: 'starting', status: 'starting', createdAt: 7, updatedAt: 70 },
  { id: 'busy', status: 'busy', createdAt: 4, updatedAt: 40 },
  { id: 'idle-new', status: 'idle', createdAt: 5, updatedAt: 50, model: 'sonnet' },
];
const tunnels = [
  { status: 'up' },
  { status: 'up', http: true, serviceStatus: 'reachable' },
  { status: 'up', http: true, serviceStatus: 'service-down' },
  { status: 'error' },
];

function countsOperatorMetrics() {
  assert.deepEqual(operatorMetrics({ sessions, tunnels, hosts: ['a', 'b'], now: 14_500_000 }), {
    running: 2,
    dormant: 1,
    stale: 1,
    failed: 2,
    activeTunnels: 2,
    hosts: 3,
  });
}

function buildsFirstGlanceStatCards() {
  assert.deepEqual(operatorStatCards({ running: 1, dormant: 2, stale: 1, activeTunnels: 3, hosts: 4, failed: 5 }), [
    { id: 'running', tone: 'live', value: 1, label: 'running', action: { kind: 'filter', filter: 'running' } },
    { id: 'parked', tone: 'resume', value: 2, label: 'parked', action: { kind: 'filter', filter: 'resume' } },
    { id: 'stale', tone: 'alert', value: 1, label: 'stale', action: { kind: 'filter', filter: 'stale' } },
    { id: 'tunnels', tone: 'quiet', value: 3, label: 'tunnels up', action: { kind: 'tunnels' } },
    { id: 'hosts', tone: 'quiet', value: 4, label: 'hosts', action: { kind: 'refresh' } },
    { id: 'cleanup', tone: 'alert', value: 5, label: 'cleanup', action: { kind: 'filter', filter: 'cleanup' } },
  ]);
}

function sortsByOperatorAttention() {
  assert.deepEqual(sortSessionsForOperator(sessions).map((s) => s.id), [
    'starting',
    'busy',
    'failed',
    'ended-resumable',
    'dormant',
    'idle-new',
    'idle-old',
  ]);
}

function providesRowActions() {
  assert.deepEqual(sessionAction({ status: 'busy' }), { kind: 'kill', label: 'Stop' });
  assert.deepEqual(sessionAction({ status: 'starting' }), { kind: 'kill', label: 'Stop' });
  assert.deepEqual(sessionAction({ status: 'dormant' }), { kind: 'open', label: 'Resume' });
  assert.deepEqual(sessionAction({ status: 'exited', sessionId: 'abc' }), { kind: 'remove', label: 'Remove' });
  assert.deepEqual(sessionAction({ status: 'exited' }), { kind: 'remove', label: 'Remove' });
  assert.deepEqual(sessionAction({ status: 'error' }), { kind: 'remove', label: 'Remove' });
  assert.deepEqual(sessionAction({ status: 'idle' }), { kind: 'open', label: 'Open' });
}

function providesSafeInspectAction() {
  assert.deepEqual(sessionInspectAction({ status: 'dormant' }), {
    kind: 'inspect',
    label: 'Inspect',
    title: 'Inspect session without resuming it',
  });
  assert.deepEqual(sessionInspectAction({ status: 'busy' }), {
    kind: 'inspect',
    label: 'Inspect',
    title: 'Inspect running session',
  });
  assert.deepEqual(sessionInspectAction({ status: 'starting' }), {
    kind: 'inspect',
    label: 'Inspect',
    title: 'Inspect running session',
  });
}

function describesSidebarView() {
  assert.deepEqual(sessionSidebarView({ status: 'dormant', model: 'claude-opus-4-20250514' }, () => 'Opus 4'), {
    inspect: {
      kind: 'inspect',
      label: 'Inspect',
      title: 'Inspect session without resuming it',
    },
    action: { kind: 'open', label: 'Resume' },
    meta: 'parked',
  });
  assert.deepEqual(sessionSidebarView({ status: 'busy', model: 'claude-opus-4-20250514' }, () => 'Opus 4'), {
    inspect: {
      kind: 'inspect',
      label: 'Inspect',
      title: 'Inspect running session',
    },
    action: null,
    meta: 'Opus 4',
  });
  assert.deepEqual(sessionSidebarView({ status: 'starting', model: 'claude-opus-4-20250514' }, () => 'Opus 4'), {
    inspect: {
      kind: 'inspect',
      label: 'Inspect',
      title: 'Inspect running session',
    },
    action: null,
    meta: 'Opus 4',
  });
}

function labelsStatusForOperators() {
  assert.equal(sessionStatusLabel({ status: 'busy' }), 'running');
  assert.equal(sessionStatusLabel({ status: 'starting' }), 'starting');
  assert.equal(sessionStatusLabel({ status: 'dormant' }), 'to resume');
  assert.equal(sessionStatusLabel({ status: 'exited', sessionId: 'abc' }), 'ended');
  assert.equal(sessionStatusLabel({ status: 'idle', model: 'sonnet' }), 'sonnet');
  assert.equal(sessionStatusLabel({ status: 'exited' }), 'ended');
  assert.equal(sessionStatusLabel({ status: 'error' }), 'error');
  assert.equal(sessionTone({ status: 'exited', sessionId: 'abc' }), 'off');
  assert.equal(sessionTone({ status: 'exited' }), 'off');
}

function sortsEqualAttentionByLastActivity() {
  const sameStatus = [
    { id: 'older', status: 'idle', createdAt: 100, updatedAt: 200 },
    { id: 'newer', status: 'idle', createdAt: 1, updatedAt: 500 },
  ];
  assert.deepEqual(sortSessionsForOperator(sameStatus).map((s) => s.id), ['newer', 'older']);
}

function buildsNextOperatorActions() {
  const actions = operatorNextActions({
    sessions,
    tunnels,
    now: 14_500_000,
    hostCards: [
      { host: 'local', tone: 'local', label: 'This computer' },
      { host: 'gb300', tone: 'offline', label: 'gb300' },
    ],
  });
  assert.deepEqual(actions.map((action) => action.id), ['cleanup', 'stale', 'running', 'tunnels']);
  assert.deepEqual(actions[0], {
    id: 'cleanup',
    tone: 'alert',
    title: 'Clean up 2 sessions',
    detail: 'Review ended or failed work before starting more.',
    action: { kind: 'session-inspect', label: 'Review first', sessionId: 'failed', filter: 'cleanup' },
  });
  assert.deepEqual(actions[1], {
    id: 'stale',
    tone: 'alert',
    title: 'Review 1 stale parked session',
    detail: 'Parked for 4h+; inspect context before resuming.',
    action: { kind: 'session-inspect', label: 'Inspect first', sessionId: 'dormant', filter: 'stale' },
  });
  assert.deepEqual(actions[2], {
    id: 'running',
    tone: 'live',
    title: 'Watch 2 running turns',
    detail: 'Keep an eye on active agents before context drifts.',
    action: { kind: 'session-inspect', label: 'Open first', sessionId: 'starting', filter: 'running' },
  });
  assert.deepEqual(operatorNextActions({
    sessions: [{ id: 'fresh', status: 'dormant', cwd: '/work/fresh', updatedAt: 19_900_000 }],
    tunnels: [],
    now: 20_000_000,
    hostCards: [],
  })[0].action, { kind: 'session-inspect', label: 'Inspect first', sessionId: 'fresh', filter: 'resume' });
  assert.deepEqual(operatorNextActions({ sessions: [], tunnels: [], hostCards: [] }), [
    {
      id: 'start',
      tone: 'quiet',
      title: 'Start a focused session',
      detail: 'Launch locally, or pick a recent project when you are ready.',
      action: { kind: 'new-local', label: 'New local' },
    },
  ]);
}

function formatsCopyableOperatorBrief() {
  const hostCards = [
    { host: 'local', tone: 'local', label: 'This computer' },
    { host: 'gb300', tone: 'offline', label: 'gb300' },
  ];
  assert.deepEqual(operatorBriefLines({
    sessions,
    tunnels,
    now: 14_500_000,
    hostCards,
  }), [
    { id: 'sessions', label: 'sessions', value: '2 running / 1 parked / 1 stale / 2 cleanup' },
    { id: 'work-watch', label: 'work watch', value: 'cleanup ended-resumable / this computer / 4h ago; cleanup failed / this computer / 4h ago; stale dormant / this computer / 4h ago' },
    { id: 'network', label: 'network', value: '2 tunnels up / 1 offline host' },
    { id: 'host-watch', label: 'host watch', value: 'gb300 offline' },
    { id: 'next', label: 'next', value: 'Clean up 2 sessions; Review 1 stale parked session; Watch 2 running turns; Check 2 live tunnels' },
  ]);
  assert.equal(operatorBriefText({
    sessions,
    tunnels,
    now: 14_500_000,
    hostCards,
  }), [
    'corral operator brief',
    'sessions: 2 running / 1 parked / 1 stale / 2 cleanup',
    'work watch: cleanup ended-resumable / this computer / 4h ago; cleanup failed / this computer / 4h ago; stale dormant / this computer / 4h ago',
    'network: 2 tunnels up / 1 offline host',
    'host watch: gb300 offline',
    'next: Clean up 2 sessions; Review 1 stale parked session; Watch 2 running turns; Check 2 live tunnels',
  ].join('\n'));
}

function summarizesWatchedWork() {
  const watchSessions = [
    { id: 'stale-ui', status: 'dormant', host: 'gb300', cwd: '/work/ui', createdAt: 1, updatedAt: 5_000_000 },
    { id: 'busy-api', status: 'busy', host: 'local', cwd: 'C:/work/api', createdAt: 2, updatedAt: 19_998_000 },
    { id: 'failed-docs', status: 'error', host: 'local', cwd: 'C:/work/docs', createdAt: 3, updatedAt: 19_000_000 },
    { id: 'idle-notes', status: 'idle', host: 'local', cwd: 'C:/work/notes', createdAt: 4, updatedAt: 19_900_000 },
  ];

  assert.equal(operatorWorkWatch({ sessions: watchSessions, now: 20_000_000 }), 'cleanup docs / this computer / 16m ago; stale ui / gb300 / 4h ago; running api / this computer / now');
  assert.equal(operatorWorkWatch({ sessions: [], now: 20_000_000 }), 'no watched sessions');
}

function buildsStructuredWatchItems() {
  const watchSessions = [
    { id: 'stale-ui', status: 'dormant', host: 'gb300', cwd: '/work/ui', createdAt: 1, updatedAt: 5_000_000 },
    { id: 'busy-api', status: 'busy', host: 'local', cwd: 'C:/work/api', createdAt: 2, updatedAt: 19_998_000 },
    { id: 'failed-docs', status: 'error', host: 'local', cwd: 'C:/work/docs', createdAt: 3, updatedAt: 19_000_000 },
    { id: 'idle-notes', status: 'idle', host: 'local', cwd: 'C:/work/notes', createdAt: 4, updatedAt: 19_900_000 },
  ];

  assert.deepEqual(operatorWatchItems({
    sessions: watchSessions,
    now: 20_000_000,
    hostCards: [{ host: 'gb300', label: 'GPU desk' }],
  }), [
    { id: 'failed-docs', sessionId: 'failed-docs', tone: 'alert', label: 'cleanup', title: 'docs', detail: 'this computer / 16m ago', actionLabel: 'Review' },
    { id: 'stale-ui', sessionId: 'stale-ui', tone: 'alert', label: 'stale', title: 'ui', detail: 'GPU desk / 4h ago', actionLabel: 'Inspect' },
    { id: 'busy-api', sessionId: 'busy-api', tone: 'live', label: 'running', title: 'api', detail: 'this computer / now', actionLabel: 'Open' },
  ]);
}

function identifiesStaleResumableSessions() {
  const now = 20_000_000;
  assert.equal(isStaleResumableSession({ status: 'dormant', updatedAt: now - 14_400_000 }, now), true);
  assert.equal(isStaleResumableSession({ status: 'dormant', updatedAt: now - 14_399_999 }, now), false);
  assert.equal(isStaleResumableSession({ status: 'exited', sessionId: 'abc', updatedAt: now - 20_000_000 }, now), false);
  assert.equal(isStaleResumableSession({ status: 'busy', updatedAt: now - 20_000_000 }, now), false);
}

function identifiesLiveSessions() {
  assert.equal(isLiveSession({ status: 'busy' }), true);
  assert.equal(isLiveSession({ status: 'starting' }), true);
  assert.equal(isLiveSession({ status: 'idle' }), false);
}

function identifiesOnlyParkedSessionsAsResumable() {
  assert.equal(isResumableSession({ status: 'dormant', sessionId: 'abc' }), true);
  assert.equal(isResumableSession({ status: 'exited', sessionId: 'abc' }), false);
  assert.equal(isResumableSession({ status: 'error', sessionId: 'abc' }), false);
}

function prioritizesAttentionCopy() {
  assert.deepEqual(operatorAttention({ failed: 1, stale: 1, dormant: 1, running: 1 }), {
    tone: 'alert',
    title: '1 session needs cleanup',
    detail: 'Remove ended or failed sessions when you are done inspecting them.',
  });
  assert.deepEqual(operatorAttention({ failed: 0, stale: 2, dormant: 2, running: 0 }), {
    tone: 'alert',
    title: '2 stale parked sessions',
    detail: 'Inspect context before resuming older work.',
  });
  assert.deepEqual(operatorAttention({ failed: 0, stale: 0, dormant: 1, running: 0 }), {
    tone: 'resume',
    title: '1 session ready to resume',
    detail: 'Pick up work exactly where the previous run stopped.',
  });
}

function formatsLastActivityForOperators() {
  assert.equal(lastActiveLabel(null, 60_000), 'no activity');
  assert.equal(lastActiveLabel(undefined, 60_000), 'no activity');
  assert.equal(lastActiveLabel(0, 60_000), '1m ago');
  assert.equal(lastActiveLabel(58_000, 60_000), 'now');
  assert.equal(lastActiveLabel(1_000, 60_000), '59s ago');
  assert.equal(lastActiveLabel(60_000, 180_000), '2m ago');
  assert.equal(lastActiveLabel(60_000, 3_660_000), '1h ago');
  assert.equal(lastActiveLabel(60_000, 176_460_000), '2d ago');
}

countsOperatorMetrics();
buildsFirstGlanceStatCards();
sortsByOperatorAttention();
providesRowActions();
providesSafeInspectAction();
describesSidebarView();
labelsStatusForOperators();
sortsEqualAttentionByLastActivity();
buildsNextOperatorActions();
formatsCopyableOperatorBrief();
summarizesWatchedWork();
buildsStructuredWatchItems();
identifiesStaleResumableSessions();
identifiesLiveSessions();
identifiesOnlyParkedSessionsAsResumable();
prioritizesAttentionCopy();
formatsLastActivityForOperators();

function sumsRosterUsage() {
  assert.deepEqual(sessionUsageTotals([
    { tokIn: 1000, tokOut: 200, costUsd: 0.5 },
    { tokIn: 0, tokOut: 0 },
    { tokIn: 50, tokOut: 5, costUsd: 0.25 },
  ]), { tokens: 1255, costUsd: 0.75 });
  assert.deepEqual(sessionUsageTotals([{ tokIn: 10, tokOut: 1 }]), { tokens: 11, costUsd: null });
  assert.deepEqual(sessionUsageTotals([]), { tokens: 0, costUsd: null });
}
sumsRosterUsage();

console.log('operatorStatus tests ok');
