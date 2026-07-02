import assert from 'node:assert/strict';
import { copyOperatorBriefText, dashboardHomeAction, runOperatorRequest, shellHostGroups, syncIssueItems } from './appShell.mjs';

function describesDashboardHomeAction() {
  assert.deepEqual(dashboardHomeAction(null), {
    title: 'Dashboard',
    current: true,
  });
  assert.deepEqual(dashboardHomeAction({ kind: 'chat' }), {
    title: 'Open dashboard',
    current: false,
  });
}

function appliesHostLaunchStateToSidebarGroups() {
  const groups = [
    { host: 'local', label: 'This computer' },
    { host: 'gb300', label: 'gb300' },
    { host: 'unprobed', label: 'unprobed' },
  ];
  const hostCards = [
    { host: 'local', canLaunch: true, launchBlockedLabel: '' },
    { host: 'gb300', canLaunch: false, launchBlockedLabel: 'gb300 is offline: SSH probe failed' },
  ];

  assert.deepEqual(shellHostGroups(groups, hostCards), [
    { host: 'local', label: 'This computer', canLaunch: true, launchBlockedLabel: '' },
    { host: 'gb300', label: 'gb300', canLaunch: false, launchBlockedLabel: 'gb300 is offline: SSH probe failed' },
    { host: 'unprobed', label: 'unprobed', canLaunch: true, launchBlockedLabel: '' },
  ]);
}

function buildsSyncIssueRows() {
  assert.deepEqual(syncIssueItems({
    sessions: new Error('sessions failed: 503'),
    hosts: '',
    tunnels: 'offline',
    hostStatus: null,
  }), [
    { id: 'sessions', label: 'sessions', detail: 'sessions failed: 503' },
    { id: 'tunnels', label: 'tunnels', detail: 'offline' },
  ]);
  assert.deepEqual(syncIssueItems({}), []);
  assert.deepEqual(syncIssueItems({ hosts: { code: 500 } }), [
    { id: 'hosts', label: 'hosts', detail: 'sync failed' },
  ]);
}

async function reportsOperatorRequestFailures() {
  const toasts = [];
  const thrown = await runOperatorRequest({
    label: 'Resume',
    request: async () => { throw new Error('/api/chat/resume?id=s1 failed: cannot resume'); },
    toast: (msg) => toasts.push(msg),
  });
  assert.deepEqual(thrown, { ok: false, error: 'cannot resume' });

  const rejected = await runOperatorRequest({
    label: 'Launch',
    request: async () => ({ ok: false, error: 'bad dir' }),
    toast: (msg) => toasts.push(msg),
  });
  assert.deepEqual(rejected, { ok: false, error: 'bad dir' });
  assert.deepEqual(toasts, ['Resume failed: cannot resume', 'Launch failed: bad dir']);
}

async function treatsFalsyResultsAsSuccess() {
  const toasts = [];
  const empty = await runOperatorRequest({
    label: 'Refresh',
    request: async () => '',
    toast: (msg) => toasts.push(msg),
  });
  assert.deepEqual(empty, { ok: true, result: '' });

  const zero = await runOperatorRequest({
    label: 'Refresh',
    request: async () => 0,
    toast: (msg) => toasts.push(msg),
  });
  assert.deepEqual(zero, { ok: true, result: 0 });

  const nullish = await runOperatorRequest({
    label: 'Refresh',
    request: async () => null,
    toast: (msg) => toasts.push(msg),
  });
  assert.deepEqual(nullish, { ok: true, result: null });
  assert.deepEqual(toasts, []);
}

async function copiesOperatorBriefWithClipboardFallback() {
  const calls = [];
  const toasts = [];
  const result = await copyOperatorBriefText('daily brief', {
    writeClipboard: async (text, opts) => {
      calls.push({ text, opts });
      return { ok: true };
    },
    toast: (msg, kind, ms) => toasts.push({ msg, kind, ms }),
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{ text: 'daily brief', opts: undefined }]);
  assert.deepEqual(toasts, [{ msg: 'Operator brief copied', kind: 'ok', ms: 2200 }]);
}

async function reportsOperatorBriefCopyFailures() {
  const toasts = [];
  const result = await copyOperatorBriefText('daily brief', {
    writeClipboard: async () => ({ ok: false, error: 'clipboard unavailable' }),
    toast: (msg, kind, ms) => toasts.push({ msg, kind, ms }),
  });

  assert.deepEqual(result, { ok: false, error: 'clipboard unavailable' });
  assert.deepEqual(toasts, [{ msg: 'Copy failed: clipboard unavailable', kind: 'error', ms: 5000 }]);
}

describesDashboardHomeAction();
appliesHostLaunchStateToSidebarGroups();
buildsSyncIssueRows();
await reportsOperatorRequestFailures();
await treatsFalsyResultsAsSuccess();
await copiesOperatorBriefWithClipboardFallback();
await reportsOperatorBriefCopyFailures();

console.log('appShell tests ok');
