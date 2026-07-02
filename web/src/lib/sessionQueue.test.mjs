import assert from 'node:assert/strict';
import { filterSessionsForQueue, queueFilterCount, SESSION_QUEUE_FILTERS } from './sessionQueue.mjs';

const sessions = [
  { id: 'busy-api', host: 'gb300', cwd: '/work/api', status: 'busy', updatedAt: 20_000_000, model: 'opus' },
  { id: 'starting-ui', host: 'local', cwd: 'C:/work/ui', status: 'starting', updatedAt: 19_000_000, model: 'sonnet' },
  { id: 'dormant-core', host: 'gb300', cwd: '/work/core', status: 'dormant', updatedAt: 18_000_000 },
  { id: 'ended-resumable', host: 'gb300', cwd: '/work/agent', status: 'exited', sessionId: 'abc', updatedAt: 1_000_000 },
  { id: 'failed-docs', host: 'local', cwd: 'C:/work/docs', status: 'error', updatedAt: 400 },
  { id: 'ended-dead', host: 'local', cwd: 'C:/work/old', status: 'exited', updatedAt: 300 },
  { id: 'idle-tools', host: 'kept', cwd: '/srv/tools', status: 'idle', updatedAt: 200, model: 'haiku' },
];
const now = 20_000_000;

function exposesFilterLabels() {
  assert.deepEqual(SESSION_QUEUE_FILTERS.map((f) => f.id), ['all', 'running', 'resume', 'stale', 'cleanup']);
}

function filtersByOperatorMode() {
  assert.deepEqual(filterSessionsForQueue(sessions, { mode: 'running', now }).map((s) => s.id), ['busy-api', 'starting-ui']);
  assert.deepEqual(filterSessionsForQueue(sessions, { mode: 'resume', now }).map((s) => s.id), ['dormant-core']);
  assert.deepEqual(filterSessionsForQueue(sessions, { mode: 'stale', now }).map((s) => s.id), []);
  assert.deepEqual(filterSessionsForQueue(sessions, { mode: 'cleanup', now }).map((s) => s.id), ['failed-docs', 'ended-resumable', 'ended-dead']);
}

function scopesQueueByHost() {
  assert.deepEqual(filterSessionsForQueue(sessions, { host: 'gb300', now }).map((s) => s.id), ['busy-api', 'ended-resumable', 'dormant-core']);
  assert.deepEqual(filterSessionsForQueue(sessions, { mode: 'cleanup', host: 'local', now }).map((s) => s.id), ['failed-docs', 'ended-dead']);
  assert.deepEqual(filterSessionsForQueue(sessions, { host: 'missing', now }).map((s) => s.id), []);
}

function searchesAcrossProjectHostAndModel() {
  assert.deepEqual(filterSessionsForQueue(sessions, { query: 'gb api' }).map((s) => s.id), ['busy-api']);
  assert.deepEqual(filterSessionsForQueue(sessions, { query: 'kept haiku' }).map((s) => s.id), ['idle-tools']);
  assert.deepEqual(filterSessionsForQueue(sessions, { mode: 'cleanup', query: 'agent' }).map((s) => s.id), ['ended-resumable']);
}

function countsModeBuckets() {
  assert.equal(queueFilterCount(sessions, 'all'), 7);
  assert.equal(queueFilterCount(sessions, 'running'), 2);
  assert.equal(queueFilterCount(sessions, 'resume'), 1);
  assert.equal(queueFilterCount(sessions, 'stale', now), 0);
  assert.equal(queueFilterCount(sessions, 'cleanup'), 3);
  assert.equal(queueFilterCount(sessions, 'resume', now, 'gb300'), 1);
  assert.equal(queueFilterCount(sessions, 'all', now, 'local'), 3);
}

exposesFilterLabels();
filtersByOperatorMode();
scopesQueueByHost();
searchesAcrossProjectHostAndModel();
countsModeBuckets();

console.log('sessionQueue tests ok');
