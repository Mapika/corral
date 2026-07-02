import assert from 'node:assert/strict';
import { buildCommandItems, filterCommandItems } from './commandItems.mjs';

const groups = [
  { host: 'local', label: 'This computer' },
  { host: 'gb300', label: 'gb300' },
];
const sessions = [
  { id: 's1', host: 'gb300', cwd: '/mnt/data/mark/projects/test', status: 'dormant', model: 'opus', updatedAt: 120_000 },
  { id: 's2', host: 'gb300', cwd: '/mnt/data/mark/projects/ended', status: 'exited', sessionId: 'abc', model: 'opus', updatedAt: 60_000 },
];
const tunnels = [
  { id: 't1', host: 'gb300', localPort: 5173, remoteHost: '127.0.0.1', remotePort: 8080, status: 'up', http: true, serviceStatus: 'reachable' },
  { id: 't2', host: 'gb300', localPort: 3000, remoteHost: '127.0.0.1', remotePort: 3000, status: 'up', http: true, serviceStatus: 'service-down' },
];
const hostStatuses = [
  { name: 'gb300', ok: true, tmux: [{ name: 'work', path: '/mnt/data/mark/work', attached: true, windows: 2 }] },
];
const recentRoots = [
  { host: 'local', dir: 'C:/D_Drive/projects/codapp', ts: 900 },
  { host: 'gb300', dir: '/mnt/data/mark/projects/test', ts: 850 },
];
const commandNow = 180_000;
const buildTestItems = (data = {}) => buildCommandItems({ groups, sessions, tunnels, now: commandNow, ...data });

function includesEssentialCommands() {
  const items = buildTestItems();
  assert.ok(items.some((x) => x.id === 'view:dashboard' && x.title === 'Open dashboard'));
  assert.ok(items.some((x) => x.id === 'operator:brief' && x.kind === 'operator-brief' && x.title === 'Copy operator brief'));
  assert.ok(items.some((x) => x.id === 'operator-session:resume:s1' && x.kind === 'session-inspect' && x.sessionId === 's1' && x.title === 'Inspect parked test'));
  assert.ok(items.some((x) => x.id === 'operator-filter:resume' && x.kind === 'operator-filter' && x.filter === 'resume'));
  assert.ok(items.some((x) => x.id === 'operator-filter:tunnels' && x.kind === 'tunnels' && x.host === 'gb300'));
  assert.ok(items.some((x) => x.id === 'new:gb300' && x.title === 'New chat on gb300'));
  assert.ok(items.some((x) => x.id === 'files:local' && x.title === 'Browse files on this computer'));
  assert.ok(items.some((x) => x.id === 'session:s1' && x.title === 'Resume test'));
  assert.ok(items.some((x) => x.id === 'session:s2' && x.title === 'Remove ended'));
  assert.ok(items.some((x) => x.id === 'session-files:s1' && x.title === 'Files for test'));
  assert.ok(items.some((x) => x.id === 'session-changes:s1' && x.title === 'Changes for test'));
  assert.ok(items.some((x) => x.id === 'session-tunnels:s1' && x.title === 'Tunnels for test'));
  assert.ok(items.some((x) => x.id === 'tunnel:t1' && x.title === 'Open 127.0.0.1:5173'));
  assert.ok(items.some((x) => x.id === 'tunnel:t1' && x.subtitle.endsWith('reachable')));
  assert.ok(items.some((x) => x.id === 'tunnel:t2' && x.title === 'Inspect 127.0.0.1:3000'));
}

function filtersByMultipleTokens() {
  const items = buildTestItems();
  const result = filterCommandItems(items, 'gb300 chat');
  assert.equal(result[0].id, 'new:gb300');
}

function ranksDirectSessionMatches() {
  const items = buildTestItems();
  const result = filterCommandItems(items, 'resume test');
  assert.equal(result[0].id, 'session:s1');
  assert.equal(result[0].subtitle, 'gb300 / dormant / opus / 1m ago');
}

function ranksSessionFileHandoffs() {
  const items = buildTestItems();
  const result = filterCommandItems(items, 'files test');
  assert.equal(result[0].id, 'session-files:s1');
  assert.equal(result[0].path, '/mnt/data/mark/projects/test');
}

function ranksSessionChangeHandoffs() {
  const items = buildTestItems();
  const result = filterCommandItems(items, 'changes test');
  assert.equal(result[0].id, 'session-changes:s1');
  assert.equal(result[0].sessionId, 's1');
}

function ranksSessionTunnelHandoffs() {
  const items = buildTestItems();
  const result = filterCommandItems(items, 'tunnels test');
  assert.equal(result[0].id, 'session-tunnels:s1');
  assert.equal(result[0].host, 'gb300');
}

function ranksOperatorCommands() {
  const items = buildTestItems();
  assert.equal(filterCommandItems(items, 'copy brief')[0].id, 'operator:brief');
  assert.equal(filterCommandItems(items, 'show parked')[0].id, 'operator-filter:resume');
  assert.equal(filterCommandItems(items, 'inspect parked test')[0].id, 'operator-session:resume:s1');
  const staleItems = buildTestItems({ now: 20_000_000 });
  assert.ok(staleItems.some((x) => x.id === 'operator-session:stale:s1' && x.kind === 'session-inspect' && x.sessionId === 's1' && x.title === 'Inspect stale test'));
  assert.ok(staleItems.some((x) => x.id === 'operator-filter:stale' && x.kind === 'operator-filter' && x.filter === 'stale'));
  assert.equal(filterCommandItems(staleItems, 'review stale')[0].id, 'operator-session:stale:s1');
  assert.equal(filterCommandItems(staleItems, 'show stale')[0].id, 'operator-filter:stale');
}

function ranksExitedSessionsAsCleanup() {
  const items = buildTestItems();
  const result = filterCommandItems(items, 'remove ended');
  assert.equal(result[0].id, 'session:s2');
  assert.equal(result[0].kind, 'session-remove');
}

function includesWorkWatchCommands() {
  const items = buildTestItems();
  const watch = items.find((x) => x.id === 'operator-watch:s1');
  assert.equal(watch.kind, 'session-inspect');
  assert.equal(watch.sessionId, 's1');
  assert.equal(watch.title, 'Inspect watched test');
  assert.equal(watch.subtitle, 'parked / gb300 / 1m ago');
  assert.equal(filterCommandItems(items, 'work watch test')[0].id, 'operator-watch:s1');
}

function ranksStaleSessionInspectionBeforeResume() {
  const items = buildTestItems({ now: 20_000_000 });
  const inspect = items.find((x) => x.id === 'session-inspect:s1');
  assert.equal(inspect.kind, 'session-inspect');
  assert.equal(inspect.title, 'Inspect stale test');
  assert.equal(inspect.subtitle, 'gb300 / parked 5h ago / review before resuming');
  assert.equal(filterCommandItems(items, 'stale test')[0].id, 'operator-session:stale:s1');
}

function marksOpenableLiveTunnels() {
  const items = buildTestItems();
  const reachable = items.find((x) => x.id === 'tunnel:t1');
  const down = items.find((x) => x.id === 'tunnel:t2');
  assert.equal(reachable.url, 'http://127.0.0.1:5173');
  assert.equal(reachable.canOpen, true);
  assert.equal(down.url, '');
  assert.equal(down.canOpen, false);
}

function includesRecentProjectLaunchers() {
  const items = buildTestItems({ tunnels: [], recentRoots });
  const result = filterCommandItems(items, 'recent codapp');
  assert.equal(result[0].id, 'recent-project:local:C:/D_Drive/projects/codapp');
  assert.equal(result[0].kind, 'recent-project');
  assert.equal(result[0].host, 'local');
  assert.equal(result[0].path, 'C:/D_Drive/projects/codapp');
}

function includesTmuxContextLaunchers() {
  const items = buildTestItems({ tunnels: [], hostStatuses });
  assert.ok(items.some((x) => x.id === 'tmux-chat:gb300:work' && x.title === 'New chat in tmux work'));
  assert.ok(items.some((x) => x.id === 'tmux-files:gb300:work' && x.title === 'Files for tmux work'));
  const result = filterCommandItems(items, 'tmux work chat');
  assert.equal(result[0].id, 'tmux-chat:gb300:work');
  assert.equal(result[0].path, '/mnt/data/mark/work');
}

function suppressesOfflineRemoteLaunchers() {
  const items = buildTestItems({
    tunnels: [],
    recentRoots,
    hostStatuses: [{ name: 'gb300', ok: false, error: 'Command failed: ssh gb300' }],
  });

  assert.equal(items.some((x) => x.id === 'new:gb300'), false);
  assert.equal(items.some((x) => x.id === 'recent-project:gb300:/mnt/data/mark/projects/test'), false);
  assert.equal(items.some((x) => x.id === 'files:gb300'), true);
  assert.equal(items.some((x) => x.id === 'tunnels:gb300'), true);
  assert.equal(items.some((x) => x.id === 'new:local'), true);
}

function returnsTopCommandsForBlankQuery() {
  const items = buildTestItems();
  const result = filterCommandItems(items, '');
  assert.deepEqual(result.slice(0, 4).map((x) => x.id), ['view:dashboard', 'operator:brief', 'operator-session:cleanup:s2', 'operator-watch:s2']);
}

function stripsControlFragmentsFromSubtitles() {
  const items = buildTestItems({
    sessions: [{ ...sessions[0], model: 'claude-opus-4-8[1m]' }],
    tunnels: [],
  });
  const session = items.find((x) => x.id === 'session:s1');
  assert.equal(session.subtitle.includes('['), false);
  assert.equal(session.subtitle.includes(']'), false);
  assert.equal(session.subtitle.includes('claude-opus-4-8'), true);
}

includesEssentialCommands();
filtersByMultipleTokens();
ranksDirectSessionMatches();
ranksSessionFileHandoffs();
ranksSessionChangeHandoffs();
ranksSessionTunnelHandoffs();
ranksOperatorCommands();
ranksExitedSessionsAsCleanup();
includesWorkWatchCommands();
ranksStaleSessionInspectionBeforeResume();
marksOpenableLiveTunnels();
includesRecentProjectLaunchers();
includesTmuxContextLaunchers();
suppressesOfflineRemoteLaunchers();
returnsTopCommandsForBlankQuery();
stripsControlFragmentsFromSubtitles();

console.log('commandItems tests ok');
