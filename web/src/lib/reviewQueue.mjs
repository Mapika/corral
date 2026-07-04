// The overnight ranch, client-side: merge per-ranch queues into one herd view, bucket jobs for
// the review gate, and render job status/diffstat labels. Pure — selftested in reviewQueue.test.mjs.

// Jobs needing a human: fresh diffs first, then merge conflicts, then failures.
const REVIEW_ORDER = { landed: 0, conflict: 1, failed: 2 };

// Mirror of ranches.mjs mergeSessions: tag every job with the ranch it lives on so actions
// route to the right server. byRanch: { ranchId: {hold, jobs} }.
export function mergeQueues(ranches = [], byRanch = {}) {
  const out = [];
  for (const r of ranches) {
    const q = byRanch[r.id];
    for (const j of (q && q.jobs) || []) out.push({ ...j, ranch: r.id, ranchName: r.name });
  }
  return out;
}

// The herd's review pile: everything owed a decision, most reviewable first, oldest landing first
// within a bucket (the morning reads top-down).
export function reviewJobs(jobs = []) {
  return jobs
    .filter((j) => j.status in REVIEW_ORDER)
    .sort((a, b) => (REVIEW_ORDER[a.status] - REVIEW_ORDER[b.status]) || ((a.finishedAt || 0) - (b.finishedAt || 0)));
}

export const pendingJobs = (jobs = []) => jobs.filter((j) => j.status === 'queued' || j.status === 'running');
export const closedJobs = (jobs = []) => jobs
  .filter((j) => j.status === 'kept' || j.status === 'bounced' || j.status === 'empty')
  .sort((a, b) => (b.reviewedAt || b.finishedAt || 0) - (a.reviewedAt || a.finishedAt || 0));

// Status -> operator words + dot tone (matches sessionStatusView's vocabulary).
const VIEWS = {
  queued: { label: 'queued', tone: 'dormant' },
  running: { label: 'running', tone: 'busy' },
  landed: { label: 'diff ready', tone: 'ask' },
  conflict: { label: 'merge conflict', tone: 'error' },
  failed: { label: 'failed', tone: 'error' },
  empty: { label: 'came back empty', tone: 'dormant' },
  kept: { label: 'kept', tone: 'idle' },
  bounced: { label: 'bounced', tone: 'dormant' },
};
export const jobStatusView = (status) => VIEWS[status] || { label: String(status || 'unknown'), tone: 'dormant' };

// "+120 −30 · 4 files" (the UI may use the real minus; push copy stays ASCII in push.js).
export function diffstatLabel(d) {
  if (!d) return '';
  const files = (d.files || 0) + (d.untracked || 0);
  return `+${d.add || 0} −${d.del || 0} · ${files} ${files === 1 ? 'file' : 'files'}${d.untracked ? ` (${d.untracked} new)` : ''}`;
}

// project name for a job card: label if the prompt gave one, else the dir's basename
export const jobProject = (j = {}) => String(j.dir || '').split(/[\\/]/).filter(Boolean).pop() || j.dir || '';
