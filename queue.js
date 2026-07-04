// queue.js — the overnight ranch: a persistent job queue drained one at a time. Each job runs
// as a normal agent session in its own git worktree (branch corral/<slug>-<ts>, checked out
// next to the repo); the queue advances on the session's turn-end `result` event via
// chat.onSessionEvent — no polling, no resident anything. A finished run with a diff "lands"
// at the review gate: Keep commits the branch and merges it into whatever the origin repo has
// checked out (a refused merge degrades to `conflict` — branch kept for the desktop); Bounce
// deletes worktree and branch (the transcript survives in the session roster, commits in
// reflog). Worktrees are local-only today, so jobs are too — each ranch backend runs its own
// queue and the phone's merged view is the herd's queue.
//
// State lives in <data-dir>/queue.json (same atomic tmp+rename + ~/.codapp fallback as
// chat.js). Everything decision-shaped is a pure exported function so the selftest can pin it
// without touching git or disk.
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const chat = require('./chat');
const push = require('./push');

const DATA_DIR = fs.existsSync(path.join(os.homedir(), '.codapp')) && !fs.existsSync(path.join(os.homedir(), '.corral'))
  ? path.join(os.homedir(), '.codapp')
  : path.join(os.homedir(), '.corral');
const STORE = path.join(DATA_DIR, 'queue.json');

// --- job state machine (pure — selftested) ---
// queued -> running -> landed (diff ready) | empty (nothing produced, auto-cleaned)
//                      | failed (session died / worktree refused; worktree kept for autopsy)
// landed|conflict --keep--> kept | conflict (merge refused; branch stays for the desktop)
// landed|conflict|failed --bounce--> bounced
const STATUSES = ['queued', 'running', 'landed', 'empty', 'failed', 'kept', 'bounced', 'conflict'];
const REVIEWABLE = new Set(['landed', 'conflict']);
const canKeep = st => REVIEWABLE.has(st);
const canBounce = st => REVIEWABLE.has(st) || st === 'failed';
// Removing from the queue: anything not mid-flight and not still owed a review decision.
// (failed is removable — remove() runs the same best-effort cleanup bounce would.)
const canRemove = st => st === 'queued' || st === 'failed' || st === 'kept' || st === 'bounced' || st === 'empty';
// Should the runner start another job right now? (hold = epoch ms pause-until)
const shouldStart = ({ hold, running, queued, now = Date.now() } = {}) => !running && queued > 0 && !(hold && now < hold);
// A `running` job found at boot means the backend died mid-drain. The turn's true fate is
// unknowable, so judge the evidence on disk: work in the tree -> land it for review; a missing
// or untouched worktree -> failed (nothing to review; bounce cleans it up).
const reconcileVerdict = ({ worktreeExists, diffEmpty }) => (worktreeExists && !diffEmpty) ? 'landed' : 'failed';
// Roster-sized display label: first line of the prompt, control chars stripped, 60-char cap.
const jobLabel = prompt => chat.cleanLabel(String(prompt ?? '').split('\n')[0]);

// --- git argv builders (pure — selftested; argv arrays only, nothing touches a shell) ---
// Worktree add moved here from server.js (the launch route imports it back): an isolated
// corral/<slug>-<ts36> branch checked out NEXT TO the repo, so the operator's tree stays clean.
function buildWorktreeArgs({ dir, repoRoot, now = Date.now() } = {}) {
  const slug = path.basename(String(dir)).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '') || 'work';
  const ts = now.toString(36);
  const branch = `corral/${slug}-${ts}`;
  const target = path.join(path.dirname(repoRoot), path.basename(repoRoot) + '-corral-' + ts);
  return { args: ['-C', dir, 'worktree', 'add', '-b', branch, target], target, branch };
}
const buildWorktreeRemoveArgs = ({ repoRoot, target, force = false } = {}) =>
  ['-C', repoRoot, 'worktree', 'remove', ...(force ? ['--force'] : []), target];
const buildBranchDeleteArgs = ({ repoRoot, branch, force = false } = {}) =>
  ['-C', repoRoot, 'branch', force ? '-D' : '-d', branch];
// --no-ff so a kept run is always one visible merge commit — "the herd did this" stays legible
// in history even when the merge could fast-forward.
const buildMergeArgs = ({ repoRoot, branch, label } = {}) =>
  ['-C', repoRoot, 'merge', '--no-ff', branch, '-m', `corral: ${label || branch} (kept)`];
const buildCommitArgs = ({ dir, label } = {}) =>
  ['-C', dir, 'commit', '-m', `corral: ${label || 'queued run'}`];

// `git diff HEAD --shortstat` -> {files, add, del}. Empty/HEADless output parses to zeros.
function parseShortstat(text) {
  const m = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/.exec(String(text || ''));
  return { files: m ? +m[1] : 0, add: m && m[2] ? +m[2] : 0, del: m && m[3] ? +m[3] : 0 };
}
const diffstatEmpty = d => !d || (!d.files && !d.untracked);

// --- git execution (argv only; stderr captured for error surfacing) ---
const git = args => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
const gitErr = e => String((e && (e.stderr || e.message)) || e).trim();
function captureDiffstat(dir) {
  const st = parseShortstat(git(['-C', dir, 'diff', 'HEAD', '--shortstat']));
  const untracked = git(['-C', dir, 'ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean).length;
  return { ...st, untracked };
}

// --- store (same debounced-atomic pattern as chat.js) ---
let jobs = [];
let hold = null;                 // epoch ms: don't start anything before this ("tonight at 01:00")
let onChangeCb = null;
function onChange(cb) { onChangeCb = cb; }
const changed = () => { if (onChangeCb) try { onChangeCb(); } catch (e) {} };

const storeJson = () => JSON.stringify({ hold, jobs: jobs.slice(-200) });
let persistTimer = null;
function persist() {
  changed();
  if (persistTimer) return;
  persistTimer = setTimeout(async () => {
    persistTimer = null;
    try {
      await fs.promises.mkdir(DATA_DIR, { recursive: true });
      await fs.promises.writeFile(STORE + '.tmp', storeJson());
      await fs.promises.rename(STORE + '.tmp', STORE);
    } catch (e) {}
  }, 500);
  persistTimer.unref?.();
}
function flush() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(STORE + '.tmp', storeJson());
    fs.renameSync(STORE + '.tmp', STORE);
  } catch (e) {}
}
function loadStore() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    jobs = Array.isArray(parsed.jobs) ? parsed.jobs.filter(j => j && j.id && STATUSES.includes(j.status)) : [];
    hold = typeof parsed.hold === 'number' && parsed.hold > 0 ? parsed.hold : null;
  } catch (e) { jobs = []; hold = null; }
}

// --- the runner ---
// Sequential on purpose (0.7): one agent at a time keeps the machine usable overnight and the
// review pile ordered. Parallel/placement arrives with 0.8. A job whose session stops to ask
// permission simply stays `running` — the existing "needs you" push already summons the human,
// and the stuck-busy watchdog in chat.js keeps a dead process from wedging the drain forever.
let holdTimer = null;
function armHold() {
  if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
  if (!hold) return;
  const delay = hold - Date.now();
  if (delay <= 0) { hold = null; return; }
  holdTimer = setTimeout(() => { holdTimer = null; hold = null; persist(); pump(); }, Math.min(delay, 0x7fffffff));
  holdTimer.unref?.();
}

// Per-drain tally for the "herd done" summary buzz: one buzz for a multi-job night, none for a
// single job (its own `landed` push already fired).
let drain = { landed: 0, failed: 0, empty: 0 };
function finishJob(job, status, extra = {}) {
  job.status = status;
  job.finishedAt = Date.now();
  Object.assign(job, extra);
  if (status === 'landed' || status === 'conflict') drain.landed++;
  else if (status === 'empty') drain.empty++;
  else if (status === 'failed') drain.failed++;
  persist();
  pump();
}

function pump() {
  if (hold && Date.now() < hold) return armHold();
  while (true) {
    if (jobs.some(j => j.status === 'running')) return;
    const job = jobs.find(j => j.status === 'queued');
    if (!job) {
      const total = drain.landed + drain.failed + drain.empty;
      if (total >= 2) push.notifyQueue(drain);
      if (total) drain = { landed: 0, failed: 0, empty: 0 };
      return;
    }
    if (startJob(job)) return;                     // launched — the result/exit hook advances us
    // startJob failed synchronously (bad repo, worktree refused) — loop on to the next job
  }
}

function startJob(job) {
  const fail = msg => { job.status = 'failed'; job.error = msg; job.finishedAt = Date.now(); drain.failed++; persist(); return false; };
  if (!fs.existsSync(job.dir) || !fs.statSync(job.dir).isDirectory()) return fail('directory is gone: ' + job.dir);
  let repoRoot;
  try { repoRoot = git(['-C', job.dir, 'rev-parse', '--show-toplevel']).trim(); }
  catch (e) { return fail(gitErr(e) || 'not a git repository'); }
  const wt = buildWorktreeArgs({ dir: job.dir, repoRoot });
  if (fs.existsSync(wt.target)) return fail('worktree target already exists: ' + wt.target);
  try { git(wt.args); } catch (e) { return fail(gitErr(e) || 'git worktree add failed'); }
  job.repoRoot = repoRoot; job.branch = wt.branch; job.worktreeDir = wt.target;
  let s;
  try {
    s = chat.launch({ agent: job.agent, host: 'local', cwd: wt.target, model: job.model || undefined,
      permissionMode: job.perm, prompt: job.prompt, worktree: true });
  } catch (e) {
    cleanupWorktree(job);                          // launch never happened — don't leave the checkout behind
    return fail(String((e && e.message) || e));
  }
  job.sessionId = s.id;
  job.status = 'running';
  job.startedAt = Date.now();
  try { chat.setLabel(s.id, job.label); } catch (e) {}
  persist();
  return true;
}

// Turn-end hook (registered in init). Returning true for a landing turn suppresses chat.js's
// generic "is ready" push — the queue's own `landed` buzz (with the diffstat) replaces it.
// Later turns in the same session (operator opened it and kept chatting) push normally again.
function onSessionEvent(kind, s, ev) {
  const job = jobs.find(j => j.status === 'running' && j.sessionId === s.id);
  if (!job) return false;
  if (kind === 'result') { land(job, s); return true; }
  if (kind === 'exit' || kind === 'fail') {
    finishJob(job, 'failed', { error: kind === 'exit' ? 'session exited' + (ev && ev.code != null ? ' (code ' + ev.code + ')' : '') : String((ev && ev.message) || 'session error') });
  }
  return false;                                    // the existing fail push still fires
}

function land(job, s) {
  let stat;
  try { stat = captureDiffstat(job.worktreeDir); }
  catch (e) { return finishJob(job, 'failed', { error: 'diff capture failed: ' + gitErr(e) }); }
  if (diffstatEmpty(stat)) {
    // Nothing produced — nothing to review. Clean up quietly; the transcript stays resumable.
    finishJob(job, 'empty', { diffstat: stat });
    endSessionAndClean(job).catch(() => {});
    return;
  }
  finishJob(job, 'landed', { diffstat: stat });
  push.notifySession('landed', s, { diffstat: stat, jobId: job.id });
}

// A landed session's process idles alive in the worktree (so "open and continue" works from
// review). Before any git surgery the process must die — on Windows a live cwd locks the
// directory and `worktree remove` would fail.
const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });
async function endSession(job, timeoutMs = 4000) {
  const s = job.sessionId && chat.get(job.sessionId);
  if (!s || !s.proc) return;
  try { chat.kill(job.sessionId); } catch (e) {}
  const t0 = Date.now();
  while (s.proc && Date.now() - t0 < timeoutMs) await sleep(150);
}
function cleanupWorktree(job) {
  if (job.worktreeDir && job.repoRoot) {
    try { git(buildWorktreeRemoveArgs({ repoRoot: job.repoRoot, target: job.worktreeDir, force: true })); }
    catch (e) { try { git(['-C', job.repoRoot, 'worktree', 'prune']); } catch (x) {} }
  }
  if (job.branch && job.repoRoot) {
    try { git(buildBranchDeleteArgs({ repoRoot: job.repoRoot, branch: job.branch, force: true })); } catch (e) {}
  }
}
async function endSessionAndClean(job) { await endSession(job); cleanupWorktree(job); }

// --- the review gate ---
// Keep = commit the run on its corral/ branch, merge --no-ff into whatever the origin repo has
// checked out, then clean up. git itself is the safety check: a refused merge (conflict, dirty
// overlap, mid-rebase repo) aborts and degrades the job to `conflict` — worktree and branch
// stay put, ready for a manual merge at the desk.
async function keep(id) {
  const job = jobs.find(j => j.id === id);
  if (!job || !canKeep(job.status)) return { ok: false, error: 'job not reviewable' };
  await endSession(job);
  try {
    if (git(['-C', job.worktreeDir, 'status', '--porcelain']).trim()) {
      git(['-C', job.worktreeDir, 'add', '-A']);
      git(buildCommitArgs({ dir: job.worktreeDir, label: job.label }));
    }
  } catch (e) { return { ok: false, error: 'commit failed: ' + gitErr(e) }; }
  try { git(buildMergeArgs({ repoRoot: job.repoRoot, branch: job.branch, label: job.label })); }
  catch (e) {
    try { git(['-C', job.repoRoot, 'merge', '--abort']); } catch (x) {}   // no-op when the merge never started
    job.status = 'conflict'; job.error = gitErr(e) || 'merge refused';
    persist();
    return { ok: false, error: job.error, conflict: true };
  }
  try { git(buildWorktreeRemoveArgs({ repoRoot: job.repoRoot, target: job.worktreeDir })); }
  catch (e) { try { git(buildWorktreeRemoveArgs({ repoRoot: job.repoRoot, target: job.worktreeDir, force: true })); } catch (x) {} }
  try { git(buildBranchDeleteArgs({ repoRoot: job.repoRoot, branch: job.branch })); } catch (e) {}   // merged, so -d; a refusal just leaves a stale branch
  job.status = 'kept'; job.error = null; job.reviewedAt = Date.now();
  persist();
  return { ok: true };
}

async function bounce(id) {
  const job = jobs.find(j => j.id === id);
  if (!job || !canBounce(job.status)) return { ok: false, error: 'job not bounceable' };
  await endSessionAndClean(job);
  job.status = 'bounced'; job.reviewedAt = Date.now();
  persist();
  return { ok: true };
}

// --- queue operations ---
function add({ dir, prompt, agent = 'claude', model = null, perm = 'auto' } = {}) {
  if (!prompt || !String(prompt).trim()) throw new Error('empty prompt');
  if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error('bad dir');
  if (!chat.AGENTS.has(agent)) throw new Error('unknown agent: ' + agent);
  if (!chat.PERM_MODES.has(perm)) perm = 'auto';
  if (model != null && model !== '' && !chat.SAFE_ARG.test(model)) throw new Error('invalid model: ' + model);
  const job = { id: crypto.randomUUID(), dir, prompt: String(prompt), label: jobLabel(prompt),
    agent, model: model || null, perm, status: 'queued', createdAt: Date.now() };
  jobs.push(job);
  persist();
  pump();
  return job;
}

async function remove(id) {
  const job = jobs.find(j => j.id === id);
  if (!job || !canRemove(job.status)) return false;
  if (job.status === 'failed') await endSessionAndClean(job);   // autopsy over — reclaim the worktree
  jobs = jobs.filter(j => j.id !== id);
  persist();
  return true;
}

// Reorder within the queued segment only — running/finished jobs keep their history order.
function move(id, to) {
  const queued = jobs.filter(j => j.status === 'queued');
  const from = queued.findIndex(j => j.id === id);
  const dest = Math.max(0, Math.min(queued.length - 1, +to));
  if (from < 0 || !Number.isFinite(dest) || from === dest) return false;
  const rest = jobs.filter(j => j.status !== 'queued');
  queued.splice(dest, 0, queued.splice(from, 1)[0]);
  jobs = [...rest, ...queued];
  persist();
  return true;
}

function setHold(untilMs) {
  const t = Math.floor(+untilMs);
  if (!Number.isFinite(t) || t <= Date.now()) return false;
  hold = t;
  persist();
  armHold();
  return true;
}
function release() { hold = null; persist(); armHold(); pump(); return true; }

function list() {
  return { hold, jobs: jobs.map(j => ({ id: j.id, dir: j.dir, prompt: j.prompt, label: j.label, agent: j.agent,
    model: j.model, perm: j.perm, status: j.status, sessionId: j.sessionId || null, branch: j.branch || null,
    worktreeDir: j.worktreeDir || null, repoRoot: j.repoRoot || null, diffstat: j.diffstat || null, error: j.error || null,
    createdAt: j.createdAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null, reviewedAt: j.reviewedAt || null })) };
}

// Boot: load, reconcile what the last run left behind, hook the turn-end signal, drain.
// Never called by the selftest (which only touches the pure exports) or the demo backend.
function init() {
  loadStore();
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    let diffEmpty = true;
    const worktreeExists = !!(job.worktreeDir && fs.existsSync(job.worktreeDir));
    if (worktreeExists) { try { diffEmpty = diffstatEmpty(job.diffstat = captureDiffstat(job.worktreeDir)); } catch (e) {} }
    const verdict = reconcileVerdict({ worktreeExists, diffEmpty });
    job.status = verdict;
    job.finishedAt = job.finishedAt || Date.now();
    if (verdict === 'failed') job.error = job.error || 'backend restarted mid-run';
    else job.error = 'landed on restart — the turn may have been cut short';
  }
  persist();
  chat.onSessionEvent(onSessionEvent);
  armHold();
  pump();
}

module.exports = { init, list, add, remove, move, setHold, release, keep, bounce, flush, onChange,
  // pure — selftested
  buildWorktreeArgs, buildWorktreeRemoveArgs, buildBranchDeleteArgs, buildMergeArgs, buildCommitArgs,
  parseShortstat, diffstatEmpty, shouldStart, reconcileVerdict, canKeep, canBounce, canRemove, jobLabel,
  _jobs: () => jobs };
