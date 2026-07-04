import assert from 'node:assert/strict';
import { closedJobs, diffstatLabel, jobProject, jobStatusView, mergeQueues, pendingJobs, reviewJobs } from './reviewQueue.mjs';

// mergeQueues tags jobs with their ranch, preserves per-ranch order, tolerates gaps
{
  const ranches = [{ id: 'origin', name: 'desk' }, { id: 'r2', name: 'homelab' }, { id: 'r3', name: 'office' }];
  const merged = mergeQueues(ranches, {
    origin: { hold: null, jobs: [{ id: 'a', status: 'queued' }] },
    r2: { hold: 123, jobs: [{ id: 'b', status: 'landed' }, { id: 'c', status: 'kept' }] },
    // r3 never answered — no entry
  });
  assert.deepEqual(merged.map((j) => j.id), ['a', 'b', 'c']);
  assert.equal(merged[1].ranch, 'r2');
  assert.equal(merged[1].ranchName, 'homelab');
}
assert.deepEqual(mergeQueues([], {}), []);

// reviewJobs: landed before conflict before failed; oldest landing first within a bucket
{
  const jobs = [
    { id: 'f', status: 'failed', finishedAt: 1 },
    { id: 'l2', status: 'landed', finishedAt: 9 },
    { id: 'q', status: 'queued' },
    { id: 'c', status: 'conflict', finishedAt: 2 },
    { id: 'l1', status: 'landed', finishedAt: 3 },
    { id: 'k', status: 'kept', finishedAt: 1 },
  ];
  assert.deepEqual(reviewJobs(jobs).map((j) => j.id), ['l1', 'l2', 'c', 'f']);
  assert.deepEqual(pendingJobs(jobs).map((j) => j.id), ['q']);
}

// closedJobs: most recently reviewed first
assert.deepEqual(closedJobs([
  { id: 'k1', status: 'kept', reviewedAt: 5 },
  { id: 'b1', status: 'bounced', reviewedAt: 9 },
  { id: 'e1', status: 'empty', finishedAt: 7 },
  { id: 'r1', status: 'running' },
]).map((j) => j.id), ['b1', 'e1', 'k1']);

// status views: operator words, known tones
assert.equal(jobStatusView('landed').label, 'diff ready');
assert.equal(jobStatusView('landed').tone, 'ask');
assert.equal(jobStatusView('conflict').label, 'merge conflict');
assert.equal(jobStatusView('nope').label, 'nope');

// diffstat labels
assert.equal(diffstatLabel({ files: 3, add: 120, del: 30 }), '+120 −30 · 3 files');
assert.equal(diffstatLabel({ files: 0, add: 0, del: 0, untracked: 1 }), '+0 −0 · 1 file (1 new)');
assert.equal(diffstatLabel(null), '');

// job project fallback
assert.equal(jobProject({ dir: 'E:/Projects/terminal-rancher' }), 'terminal-rancher');
assert.equal(jobProject({ dir: '/srv/feed/' }), 'feed');

console.log('reviewQueue tests ok');
