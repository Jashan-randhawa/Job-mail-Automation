import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { extractConceptAndDraft as defaultExtractConceptAndDraft } from './services/openrouterService.js';
import { sendOutreachEmail as defaultSendOutreachEmail } from './services/emailService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
const PORT = process.env.PORT || 3000;

const REQUIRED_ENV_VARS = ['OPENROUTER_API_KEY', 'EMAIL_USER', 'EMAIL_APP_PASSWORD'];
const missingEnvVars = REQUIRED_ENV_VARS.filter((key) => !process.env[key] || !process.env[key].trim());
if (missingEnvVars.length) {
  console.warn(
    `[startup] Missing environment variable(s): ${missingEnvVars.join(', ')}. ` +
    'Every job will fail until these are set (see .env.example).'
  );
}

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TERMINAL_STATUSES = new Set(['sent', 'draft_failed', 'send_failed', 'send_unknown', 'rejected']);
const ACTIVE_STATUSES = new Set(['processing', 'drafting', 'waiting', 'sending']);
const FAILURE_STATUSES = new Set(['draft_failed', 'send_failed', 'send_unknown', 'rejected']);
const LEGAL_TRANSITIONS = new Map([
  ['queued', new Set(['processing', 'rejected'])],
  ['processing', new Set(['drafting', 'draft_failed'])],
  ['drafting', new Set(['waiting', 'draft_failed', 'rejected'])],
  ['waiting', new Set(['sending', 'send_failed'])],
  ['sending', new Set(['sent', 'send_failed', 'send_unknown'])],
  ['draft_failed', new Set(['queued'])],
  ['send_failed', new Set(['queued'])],
  ['send_unknown', new Set(['queued'])],
  ['rejected', new Set(['queued'])]
]);

export const queueConfig = {
  minSendIntervalMs: Number(process.env.MIN_SEND_INTERVAL_MS || 45_000),
  jitterMaxMs: Number(process.env.SEND_JITTER_MAX_MS || 20_000),
  jobEventLimit: Number(process.env.JOB_EVENT_LIMIT || 50),
  jobListLimit: Number(process.env.JOB_LIST_LIMIT || 100),
  draftTimeoutMs: Number(process.env.DRAFT_TIMEOUT_MS || 60_000),
  sendTimeoutMs: Number(process.env.SEND_TIMEOUT_MS || 60_000),
  waitTimeoutMs: Number(process.env.WAIT_TIMEOUT_MS || 10 * 60_000),
  jobProcessingTimeoutMs: Number(process.env.JOB_PROCESSING_TIMEOUT_MS || 5 * 60_000),
  estimatedDraftSeconds: Number(process.env.ESTIMATED_DRAFT_SECONDS || 20),
  estimatedSendSeconds: Number(process.env.ESTIMATED_SEND_SECONDS || 10),
  // Independent wall-clock sweep, decoupled from the drain loop (see
  // startStaleSweep below) — this is what actually guarantees stale-job
  // recovery even if the loop's own per-iteration call to
  // recoverStaleJobs() never gets a turn (e.g. the loop is itself stuck
  // awaiting something that isn't timeout-bounded).
  staleSweepIntervalMs: Number(process.env.STALE_SWEEP_INTERVAL_MS || 15_000),
  // The job store is an in-memory Map that otherwise grows forever for the
  // life of the process — every job ever submitted, sent or failed, stays
  // resident. Bound it so a long-running instance doesn't slowly leak
  // memory; only ever prunes TERMINAL jobs (never queued/active ones), and
  // only the oldest-completed ones once the store exceeds this size.
  jobRetentionLimit: Number(process.env.JOB_RETENTION_LIMIT || 1000)
};

const jobs = new Map();
const queuedJobIds = [];
let activeJobId = null;
let workerPromise = null;
let lastSendAt = 0;
let claimedSendSlotAt = 0;
let workerSeq = 0;
// FIFO position is derived in O(1) from these two monotonic counters instead
// of Array.indexOf(), which is O(n) per call. queuePosition() used to be
// called once per job on every /api/jobs poll (via estimateEtaSeconds),
// making that endpoint O(n^2) in the queue length. Every job is assigned a
// queueSeq when it enters 'queued' (in makeJob and on retry); dequeueSeq
// advances by one each time a job leaves the front of the queue. Because
// this queue only ever removes from the head, "how many jobs are still
// ahead of me" is just queueSeq - dequeueSeq, no scan required.
let nextQueueSeq = 0;
let dequeueSeq = 0;
// Index of the first still-queued element in queuedJobIds. Dequeuing used to
// be queuedJobIds.shift(), which is O(n) per call because every remaining
// element has to be reindexed — draining a burst of n jobs cost O(n^2)
// overall, the same shape of bug queuePosition() above was already fixed
// for. queueHead lets a dequeue just skip a slot (O(1)); advanceQueueHead()
// below periodically compacts the dead prefix away so memory stays bounded.
let queueHead = 0;
let services = { extractConceptAndDraft: defaultExtractConceptAndDraft, sendOutreachEmail: defaultSendOutreachEmail };

function now() { return Date.now(); }
function asIso(ts) { return ts ? new Date(ts).toISOString() : null; }
function normalizeError(err) { return err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err)); }
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))); }
async function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

function addJobEvent(job, phase, message) {
  const at = now();
  job.updatedAt = at;
  job.events.push({ at, phase, message });
  if (job.events.length > queueConfig.jobEventLimit) job.events.splice(0, job.events.length - queueConfig.jobEventLimit);
  console.log(`[job:${job.id}] ${phase} - ${message}`);
}

function logTransition(job, from, to) {
  console.log(`[queue] job=${job.id} ${from} -> ${to} queue=${queueLength()} active=${activeJobId || '-'} retry=${job.retryCount || 0} at=${new Date().toISOString()}`);
}

// Number of jobs actually still waiting (excludes the dead prefix before
// queueHead). O(1) — just pointer arithmetic, no scan.
function queueLength() { return queuedJobIds.length - queueHead; }

// Advances past the job just dequeued. O(1) amortized: normally just bumps
// two pointers; only occasionally (once the dead prefix is large) does it
// pay an O(k) splice to reclaim that dead space, and it amortizes that cost
// over the k dequeues that produced it.
function advanceQueueHead() {
  queueHead += 1;
  dequeueSeq += 1;
  if (queueHead > 64 && queueHead * 2 > queuedJobIds.length) {
    queuedJobIds.splice(0, queueHead);
    queueHead = 0;
  }
}

export function assertQueueInvariants({ allowStoppedWorker = false } = {}) {
  const problems = [];
  const seen = new Set();
  for (let i = queueHead; i < queuedJobIds.length; i += 1) {
    const id = queuedJobIds[i];
    if (seen.has(id)) problems.push(`duplicate job id in queue: ${id}`);
    seen.add(id);
    const job = jobs.get(id);
    if (!job) problems.push(`queue contains nonexistent job: ${id}`);
    else if (job.status !== 'queued') problems.push(`queue contains ${id} with status ${job.status}`);
  }
  const activeJobs = Array.from(jobs.values()).filter((job) => ACTIVE_STATUSES.has(job.status));
  if (activeJobs.length > 1) problems.push(`more than one active job: ${activeJobs.map((j) => j.id).join(',')}`);
  if (activeJobId && queuedJobIds.indexOf(activeJobId, queueHead) !== -1) problems.push(`active job is also queued: ${activeJobId}`);
  if (activeJobId && !jobs.has(activeJobId)) problems.push(`activeJobId ${activeJobId} references a nonexistent job`);
  if (activeJobs.length === 1 && activeJobs[0].id !== activeJobId) {
    problems.push(`job ${activeJobs[0].id} is in an active status but activeJobId is ${activeJobId || 'null'}`);
  }
  if (activeJobs.length === 0 && activeJobId) {
    problems.push(`activeJobId ${activeJobId} is set but no job is in an active status`);
  }
  for (const job of jobs.values()) {
    if (job.status === 'queued' && !seen.has(job.id)) problems.push(`queued job missing from queue: ${job.id}`);
    if (TERMINAL_STATUSES.has(job.status) && seen.has(job.id)) problems.push(`terminal job still queued: ${job.id}`);
  }
  if (!allowStoppedWorker && queueLength() > 0 && !workerPromise) problems.push(`worker stopped while queue has ${queueLength()} job(s)`);
  if (problems.length) console.error('[queue:invariant]', problems.join(' | '));
  return problems;
}

function transitionJob(job, nextStatus, metadata = {}) {
  const previousStatus = job.status;
  if (!LEGAL_TRANSITIONS.get(previousStatus)?.has(nextStatus)) throw new Error(`Illegal job transition ${previousStatus} -> ${nextStatus} for ${job.id}`);
  job.status = nextStatus;
  job.updatedAt = now();
  job.claimedBy = metadata.claimedBy ?? job.claimedBy;
  job.claimedAt = metadata.claimedAt ?? job.claimedAt;
  job.lockUntil = metadata.lockUntil ?? job.lockUntil;
  job.error = metadata.error ?? job.error;
  job.lastErrorAt = metadata.lastErrorAt ?? job.lastErrorAt;
  job.completedAt = metadata.completedAt ?? job.completedAt;
  if ('plannedSendAt' in metadata) job.plannedSendAt = metadata.plannedSendAt;
  if ('result' in metadata) job.result = metadata.result;
  logTransition(job, previousStatus, nextStatus);
  addJobEvent(job, nextStatus, metadata.message || `${previousStatus} -> ${nextStatus}`);
}

function makeJob(postText, recipientEmail) {
  const id = crypto.randomUUID();
  const ts = now();
  jobs.set(id, { id, status: 'queued', postText, recipientEmail, createdAt: ts, updatedAt: ts, startedAt: null, draftedAt: null, waitingAt: null, sendingAt: null, completedAt: null, plannedSendAt: null, result: null, error: null, lastErrorAt: null, retryCount: 0, claimedBy: null, claimedAt: null, lockUntil: null, sendAttemptStartedAt: null, queueSeq: nextQueueSeq++, events: [{ at: ts, phase: 'queued', message: 'Queued for processing.' }] });
  queuedJobIds.push(id);
  assertQueueInvariants({ allowStoppedWorker: true });
  return id;
}

// O(1): a job's place in line is just the gap between its own enqueue
// sequence number and how many jobs have been dequeued so far. Falls back to
// an indexOf scan only if a job is somehow missing its queueSeq (defensive;
// shouldn't happen for anything created via makeJob/requeueJob).
function queuePosition(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.status !== 'queued') return null;
  if (typeof job.queueSeq !== 'number') { const idx = queuedJobIds.indexOf(jobId, queueHead); return idx === -1 ? null : idx - queueHead + 1; }
  return job.queueSeq - dequeueSeq + 1;
}
function nextEligibleSendAt() { return Math.max(lastSendAt, claimedSendSlotAt) + queueConfig.minSendIntervalMs; }
function estimateEtaSeconds(job) {
  if (job.status === 'queued') {
    const position = queuePosition(job.id) || 1;
    const activePenalty = activeJobId ? queueConfig.estimatedDraftSeconds + queueConfig.estimatedSendSeconds : 0;
    const jobsAhead = position - 1;
    const sendWait = Math.max(0, nextEligibleSendAt() - now()) / 1000;
    return Math.min(24 * 60 * 60, Math.max(0, Math.round(activePenalty + sendWait + jobsAhead * (queueConfig.estimatedDraftSeconds + queueConfig.estimatedSendSeconds + queueConfig.minSendIntervalMs / 1000 + queueConfig.jitterMaxMs / 2000))));
  }
  if (job.status === 'waiting' && job.plannedSendAt) return Math.max(0, Math.round((job.plannedSendAt - now()) / 1000));
  if (job.status === 'sending') {
    const elapsedSeconds = job.sendAttemptStartedAt ? (now() - job.sendAttemptStartedAt) / 1000 : 0;
    return Math.max(0, Math.round(queueConfig.estimatedSendSeconds - elapsedSeconds));
  }
  // 'processing' / 'drafting' (and 'waiting' without a plannedSendAt yet)
  // are all active-but-not-yet-sending — count down the remaining draft
  // budget from when the worker actually claimed the job, rather than
  // showing a flat estimate that never moves until the phase changes.
  // Returning a number here (never `undefined`) still matters: JSON.stringify
  // silently drops undefined keys, which previously made these active jobs
  // report position:0 but no etaSeconds field at all, an inconsistent shape
  // for the same "this is the active job" case the queued/waiting branches
  // already handle.
  if (ACTIVE_STATUSES.has(job.status)) {
    const elapsedSeconds = job.startedAt ? (now() - job.startedAt) / 1000 : 0;
    return Math.max(0, Math.round(queueConfig.estimatedDraftSeconds - elapsedSeconds));
  }
  return 0; // terminal job — no meaningful ETA, but always a number
}

function serializeJob(job, { includeDraft = false } = {}) {
  const eta = estimateEtaSeconds(job);
  const body = { id: job.id, status: job.status, state: job.status, recipientEmail: job.recipientEmail, createdAt: asIso(job.createdAt), updatedAt: asIso(job.updatedAt), startedAt: asIso(job.startedAt), draftedAt: asIso(job.draftedAt), waitingAt: asIso(job.waitingAt), sendingAt: asIso(job.sendingAt), completedAt: asIso(job.completedAt), plannedSendAt: asIso(job.plannedSendAt), lastErrorAt: asIso(job.lastErrorAt), inFlight: activeJobId === job.id, active: activeJobId === job.id, position: activeJobId === job.id ? 0 : queuePosition(job.id), etaSeconds: eta, error: job.error, retryCount: job.retryCount || 0, canRetry: FAILURE_STATUSES.has(job.status), claimedBy: job.claimedBy, claimedAt: asIso(job.claimedAt), lockUntil: asIso(job.lockUntil), events: job.events.map((e) => ({ ...e, at: asIso(e.at) })) };
  if (job.result?.concept) body.concept = job.result.concept;
  if (job.result?.subject) body.subject = job.result.subject;
  if (includeDraft && job.result) body.draft = job.result;
  return body;
}

function failActiveJob(job, status, message, result) {
  transitionJob(job, status, { error: message, lastErrorAt: now(), completedAt: now(), plannedSendAt: null, result: result ?? job.result, message });
}

function recoverStaleJobs() {
  const cutoff = now();
  for (const job of jobs.values()) {
    if (ACTIVE_STATUSES.has(job.status) && job.lockUntil && job.lockUntil < cutoff) {
      const status = job.status === 'sending' ? 'send_unknown' : 'draft_failed';
      failActiveJob(job, status, `Recovered stale ${job.status} job after processing timeout.`);
      // A recovered job is done — it must not keep reporting worker
      // ownership metadata for a claim that no longer exists, or /api/status
      // would misleadingly show a terminal job as still "claimed".
      job.claimedBy = null;
      job.lockUntil = null;
      if (activeJobId === job.id) activeJobId = null;
    }
  }
}

// Runs recoverStaleJobs() on a real wall-clock timer, independent of
// drainQueue's own loop. drainQueue only calls recoverStaleJobs() between
// iterations, which means it can never rescue a job while the loop itself is
// blocked awaiting that very job — every operation inside processJob is
// timeout-bounded today so that shouldn't happen, but this sweep is the
// actual backstop if a future code path ever adds an unbounded await.
function pruneOldJobs() {
  const limit = queueConfig.jobRetentionLimit;
  if (jobs.size <= limit) return;
  const terminal = Array.from(jobs.values())
    .filter((job) => TERMINAL_STATUSES.has(job.status))
    .sort((a, b) => (a.completedAt || a.updatedAt || 0) - (b.completedAt || b.updatedAt || 0));
  let excess = jobs.size - limit;
  for (const job of terminal) {
    if (excess <= 0) break;
    jobs.delete(job.id);
    excess -= 1;
  }
}

let staleSweepTimer = null;
function startStaleSweep() {
  if (staleSweepTimer) return;
  staleSweepTimer = setInterval(() => {
    try { recoverStaleJobs(); pruneOldJobs(); } catch (err) { console.error('[queue] stale sweep failed:', err); }
  }, queueConfig.staleSweepIntervalMs);
  staleSweepTimer.unref?.();
}
function stopStaleSweep() {
  if (staleSweepTimer) clearInterval(staleSweepTimer);
  staleSweepTimer = null;
}

async function processJob(job) {
  transitionJob(job, 'drafting', { message: 'Generating draft from LinkedIn post.' });
  let draft;
  try {
    draft = await withTimeout(services.extractConceptAndDraft(job.postText), queueConfig.draftTimeoutMs, 'Draft generation');
    job.draftedAt = now();
    job.result = draft;
    addJobEvent(job, 'drafting', 'Draft generated successfully.');
  } catch (err) {
    failActiveJob(job, 'draft_failed', `Could not generate a draft: ${normalizeError(err).message}`);
    return;
  }
  const hasPlaceholder = /\[[^\]]{1,40}\]/.test(draft.subject || '') || /\[[^\]]{1,40}\]/.test(draft.body || '');
  const tooShort = !draft.body || draft.body.trim().length < 50;
  const missingSubject = !draft.subject || !draft.subject.trim();
  if (hasPlaceholder || tooShort || missingSubject) {
    failActiveJob(job, 'rejected', 'Generated email failed the safety check (placeholder text, missing subject, or too short). Nothing was sent.', draft);
    return;
  }
  const waitMs = Math.max(0, nextEligibleSendAt() - now()) + Math.floor(Math.random() * queueConfig.jitterMaxMs);
  const plannedSendAt = now() + waitMs;
  job.waitingAt = now();
  transitionJob(job, 'waiting', { plannedSendAt, message: waitMs > 0 ? `Waiting ${Math.round(waitMs / 1000)}s for the global send slot.` : 'Global send slot available now.' });
  try { await withTimeout(sleep(waitMs), Math.max(queueConfig.waitTimeoutMs, waitMs + 1000), 'Send slot wait'); }
  catch (err) { failActiveJob(job, 'send_failed', normalizeError(err).message, draft); return; }
  claimedSendSlotAt = now();
  job.sendingAt = now();
  job.sendAttemptStartedAt = now();
  transitionJob(job, 'sending', { plannedSendAt: null, message: 'Claimed global send slot; sending email.' });
  try {
    await withTimeout(services.sendOutreachEmail({ to: job.recipientEmail, subject: draft.subject, body: draft.body }), queueConfig.sendTimeoutMs, 'SMTP send');
    lastSendAt = now();
    transitionJob(job, 'sent', { completedAt: now(), result: draft, message: 'Email sent successfully.' });
  } catch (err) {
    lastSendAt = now();
    const message = normalizeError(err).message;
    failActiveJob(job, message.includes('timed out') ? 'send_unknown' : 'send_failed', `Draft looked good but sending failed: ${message}`, draft);
  }
}

async function drainQueue(workerId) {
  console.log(`[worker] ${workerId} started with ${queueLength()} queued job(s).`);
  while (true) {
    recoverStaleJobs();
    const jobId = queuedJobIds[queueHead];
    if (jobId === undefined) break;
    const job = jobs.get(jobId);
    if (!job) { advanceQueueHead(); continue; }
    if (job.status !== 'queued') { console.error(`[queue] dropping corrupt queue entry ${jobId} status=${job.status}`); advanceQueueHead(); continue; }
    activeJobId = jobId;
    transitionJob(job, 'processing', { claimedBy: workerId, claimedAt: now(), lockUntil: now() + queueConfig.jobProcessingTimeoutMs, message: 'Safely claimed by worker.' });
    advanceQueueHead();
    job.startedAt = job.startedAt || now();
    try { await processJob(job); }
    catch (err) { failActiveJob(job, job.status === 'sending' ? 'send_unknown' : 'draft_failed', `Unexpected worker error: ${normalizeError(err).message}`); }
    finally { if (activeJobId === jobId) activeJobId = null; job.claimedBy = null; job.lockUntil = null; assertQueueInvariants({ allowStoppedWorker: true }); }
  }
  console.log(`[worker] ${workerId} queue drained.`);
}

export function runWorker() {
  if (workerPromise) return workerPromise;
  const workerId = `worker-${++workerSeq}`;
  workerPromise = drainQueue(workerId)
    .catch((err) => console.error('[worker] fatal drain error:', err))
    .finally(() => { workerPromise = null; assertQueueInvariants({ allowStoppedWorker: true }); if (queueLength() > 0) runWorker(); });
  return workerPromise;
}

app.post('/api/send-outreach', (req, res) => {
  const { postText, recipientEmail } = req.body || {};
  if (!postText || !postText.trim()) return res.status(400).json({ error: 'Paste the LinkedIn post text first.' });
  if (!recipientEmail || !EMAIL_RE.test(recipientEmail)) return res.status(400).json({ error: 'Enter a valid recipient email.' });
  const jobId = makeJob(postText.trim(), recipientEmail.trim());
  const job = jobs.get(jobId);
  const position = queuePosition(jobId) || 1;
  const etaSeconds = estimateEtaSeconds(job);
  runWorker();
  res.status(202).json({ jobId, status: 'queued', position, etaSeconds });
});

app.post('/api/jobs/:jobId/retry', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  if (!FAILURE_STATUSES.has(job.status)) return res.status(400).json({ error: `Only failed or rejected jobs can be retried (this job is ${job.status}).` });
  // Idempotency in practice comes from the check above: this handler has no
  // `await` before mutating job.status, so under Node's single-threaded
  // event loop two "concurrent" retry requests are actually processed one
  // after another — the second sees status !== a failure status (it's
  // already 'queued'/active) and is rejected by the check above, not by
  // this one. This branch is a defensive backstop only (e.g. if this
  // handler is ever refactored to await something before the mutation).
  // It's an O(1) status check rather than an O(n) queuedJobIds.includes()
  // scan — a job is "already queued or active" iff its own status says so.
  if (job.status === 'queued' || ACTIVE_STATUSES.has(job.status)) return res.status(202).json({ jobId: job.id, status: job.status, position: queuePosition(job.id), etaSeconds: estimateEtaSeconds(job), message: 'This job is already queued or active.' });
  job.retryCount = (job.retryCount || 0) + 1;
  Object.assign(job, { startedAt: null, draftedAt: null, waitingAt: null, sendingAt: null, completedAt: null, plannedSendAt: null, error: null, lastErrorAt: null, claimedBy: null, claimedAt: null, lockUntil: null, sendAttemptStartedAt: null, queueSeq: nextQueueSeq++ });
  queuedJobIds.push(job.id);
  transitionJob(job, 'queued', { message: `Re-queued at the back for retry attempt ${job.retryCount + 1}.` });
  runWorker();
  res.status(202).json({ jobId: job.id, status: 'queued', position: queuePosition(job.id) || 1, etaSeconds: estimateEtaSeconds(job) });
});

app.get('/api/status/:jobId', (req, res) => { const job = jobs.get(req.params.jobId); if (!job) return res.status(404).json({ error: 'Unknown job id.' }); res.json(serializeJob(job, { includeDraft: true })); });
app.get('/api/jobs', (_req, res) => {
  const jobsList = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, queueConfig.jobListLimit).map((job) => serializeJob(job));
  res.json({ worker: { running: Boolean(workerPromise), activeJobId, currentJobId: activeJobId, queuedCount: queueLength(), queueIds: queuedJobIds.slice(queueHead), lastSendAt: asIso(lastSendAt), nextEligibleSendAt: lastSendAt || claimedSendSlotAt ? asIso(nextEligibleSendAt()) : null }, jobs: jobsList });
});

export const __queueTest = {
  jobs, queuedJobIds,
  // queuedJobIds can contain a dead prefix (already-dequeued ids not yet
  // compacted away — see advanceQueueHead) — this returns only the ids
  // actually still queued, i.e. what queuedJobIds itself used to mean
  // before the O(1)-dequeue change.
  liveQueuedIds() { return queuedJobIds.slice(queueHead); },
  setServices(next) { services = { ...services, ...next }; },
  reset() { jobs.clear(); queuedJobIds.splice(0); queueHead = 0; activeJobId = null; workerPromise = null; lastSendAt = 0; claimedSendSlotAt = 0; workerSeq = 0; nextQueueSeq = 0; dequeueSeq = 0; services = { extractConceptAndDraft: defaultExtractConceptAndDraft, sendOutreachEmail: defaultSendOutreachEmail }; stopStaleSweep(); },
  makeJob, serializeJob, runWorker, recoverStaleJobs, pruneOldJobs, startStaleSweep, stopStaleSweep,
  getDiagnostics() { return { workerPromise, activeJobId, queueIds: [...queuedJobIds], lastSendAt, claimedSendSlotAt, jobs: Array.from(jobs.values()) }; }
};

export default app;

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`));
}
if (process.env.NODE_ENV !== 'test') {
  // Safe under Vercel too: a warm serverless instance may still be reused
  // across several invocations, and this timer is unref()'d so it never
  // keeps a process alive on its own.
  startStaleSweep();
}
