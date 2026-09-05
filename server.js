import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { extractConceptAndDraft as defaultExtractConceptAndDraft } from './services/cerebrasService.js';
import { sendOutreachEmail as defaultSendOutreachEmail, closeTransporter } from './services/emailService.js';
import { extractEmailFromText } from './services/emailExtractor.js';
import { checkDraftSafety } from './services/draftSafety.js';
import { loadState, saveNow } from './persistence/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
const PORT = process.env.PORT || 3000;

const REQUIRED_ENV_VARS = ['GROQ_API_KEY', 'EMAIL_USER', 'EMAIL_APP_PASSWORD'];
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
  jobRetentionLimit: Number(process.env.JOB_RETENTION_LIMIT || 1000),
  batchRetentionLimit: Number(process.env.BATCH_RETENTION_LIMIT || 500),

  // --- Batching (see README "Batched sending") ---
  // Jobs are grouped into fixed-size batches before they're eligible to
  // send at all; minSendIntervalMs/jitterMaxMs above still pace the sends
  // *within* a batch, this adds a much larger gap *between* batches so
  // outreach goes out in small human-looking bursts rather than a steady
  // drip.
  batchSize: Number(process.env.BATCH_SIZE || 3),
  batchDelayMs: Number(process.env.BATCH_DELAY_MS || 45 * 60_000),
  // If a batch never fills up (traffic dries up with 1-2 jobs sitting in
  // it), don't let it wait forever — promote it to READY once it's been
  // assembling longer than this.
  orphanBatchTimeoutMs: Number(process.env.ORPHAN_BATCH_TIMEOUT_MS || 2 * 60 * 60_000),
  persistPath: process.env.QUEUE_PERSIST_PATH || path.join(__dirname, 'data', 'queue-state.json'),
  persistDebounceMs: Number(process.env.QUEUE_PERSIST_DEBOUNCE_MS || 250)
};

const jobs = new Map();
const queuedJobIds = [];
let activeJobId = null;
let workerPromise = null;
let lastSendAt = 0;
let claimedSendSlotAt = 0;
let workerSeq = 0;
// Incremented by __queueTest.reset() to invalidate any drainQueue instance
// still running from a previous test. reset() can clear the shared
// jobs/queuedJobIds/batches state, but it can't actually stop an
// already-running async drainQueue loop (e.g. one kicked off by a
// fire-and-forget runWorker() call — like the retry endpoint's — that no
// test awaits). Without this, that leftover loop keeps mutating the SAME
// shared Maps/arrays the *next* test just reset, racing the new test's own
// worker. In production this never applies — nothing ever calls reset().
let generation = 0;
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

// --- Batch state ---
// A job's own state machine (above) is unchanged; batches are a layer on
// top that gates *when* a queued job is allowed to leave 'queued' and be
// claimed by the worker (see isJobReleasable below). Because jobs are still
// enqueued into the single global FIFO in arrival order, and batches are
// filled from that same arrival order, the existing FIFO plumbing
// (queuedJobIds/queueHead/queueSeq) doesn't need to change at all — batches
// just decide whether the head of that FIFO is allowed to proceed yet.
const batches = new Map(); // id -> batch object
let assemblingBatch = null; // the one batch currently accepting new jobs (status ASSEMBLING), or null
const pendingBatchIds = []; // FIFO of batch ids with status READY or PROCESSING, oldest first
let nextBatchSeq = 0;

function makeBatch() {
  const id = `batch-${++nextBatchSeq}-${crypto.randomUUID().slice(0, 8)}`;
  const batch = { id, jobIds: [], status: 'ASSEMBLING', createdAt: now(), scheduledProcessTime: null };
  batches.set(id, batch);
  return batch;
}

// `immediate: true` is for a batch that's being locked because it timed out
// waiting to fill (see promoteBatches' orphan-promotion path below), not
// because it actually filled up. batchDelayMs exists to smooth a *full*
// batch into a human-looking send pattern instead of firing the instant it
// fills — that reasoning doesn't apply to an orphan, which already sat idle
// for up to orphanBatchTimeoutMs by definition. Paying the full batch delay
// on top of that (2h orphan wait + 45m batch delay, by default) has no
// smoothing benefit and just adds dead time, so an orphan-promoted batch is
// scheduled for right now instead.
function lockBatch(batch, { immediate = false } = {}) {
  batch.status = 'READY';
  batch.scheduledProcessTime = immediate ? now() : now() + queueConfig.batchDelayMs;
  pendingBatchIds.push(batch.id);
  if (assemblingBatch === batch) assemblingBatch = null;
  const scheduleMsg = immediate ? 'scheduled for now (orphan-promoted)' : `scheduled for ${new Date(batch.scheduledProcessTime).toISOString()}`;
  console.log(`[batch] ${batch.id} locked with ${batch.jobIds.length} job(s), ${scheduleMsg}`);
}

// Adds a job to the current assembling batch (creating one if needed),
// locking that batch once it hits batchSize. Used both for brand-new
// submissions and for retries (a retried job re-enters batching rather than
// resuming whatever batch it originally belonged to — see requeueJob).
function assignJobToBatch(jobId) {
  const job = jobs.get(jobId);
  if (!assemblingBatch) assemblingBatch = makeBatch();
  assemblingBatch.jobIds.push(jobId);
  job.batchId = assemblingBatch.id;
  if (assemblingBatch.jobIds.length >= queueConfig.batchSize) lockBatch(assemblingBatch);
}

// A batch is done once every job it still claims has reached a terminal
// status. Called after any job transitions to a terminal status and after a
// job is removed from a batch on retry (which can also complete a batch
// that was only waiting on that one job).
function maybeCompleteBatch(batch) {
  if (!batch || batch.status === 'COMPLETED' || batch.status === 'ASSEMBLING') return;
  // A batch can end up with zero jobs before ever running — e.g. retry
  // detaches the last job from a batch that was locked (READY) but hadn't
  // been promoted to PROCESSING yet. An empty READY/PROCESSING batch has
  // nothing left to wait for and must be completed immediately regardless
  // of status, or it sits in pendingBatchIds forever — and once
  // promoteBatches() eventually promotes it to PROCESSING, it would
  // permanently block every batch behind it, since nothing else would ever
  // call maybeCompleteBatch() for it again.
  const allTerminal = batch.jobIds.every((id) => { const j = jobs.get(id); return !j || TERMINAL_STATUSES.has(j.status); });
  if (!allTerminal) return;
  batch.status = 'COMPLETED';
  const idx = pendingBatchIds.indexOf(batch.id);
  if (idx !== -1) pendingBatchIds.splice(idx, 1);
  console.log(`[batch] ${batch.id} completed${batch.jobIds.length === 0 ? ' (emptied by retry before it ran)' : ''}.`);
}

// A queued job may only be claimed by the worker once its batch has been
// promoted to PROCESSING. This is the only place batching actually changes
// worker behavior — everything else (drafting, pacing, sending) is
// untouched.
function isJobReleasable(job) {
  const batch = batches.get(job.batchId);
  return Boolean(batch) && batch.status === 'PROCESSING';
}

// Promotes an ASSEMBLING batch that's timed out to READY, and the batch at
// the front of pendingBatchIds to PROCESSING once its delay has elapsed.
// Only the front batch is ever promoted to PROCESSING at a time — later
// batches stay READY until it completes, keeping sends grouped in the same
// arrival order the global job FIFO already guarantees.
//
// Deliberately does NOT call runWorker() itself, even though promoting a
// batch is exactly the moment a worker needs to wake up. Reason: this
// function is also called from inside drainQueue's own loop (so an
// already-running worker notices its own next batch coming due without
// waiting for the next sweep tick). Calling runWorker() from there is
// reentrant — it runs while runWorker()'s `workerPromise = drainQueue(...)`
// assignment is still in progress, so it sees the OLD (often null)
// workerPromise and spins up a genuine second drainQueue instance, which
// then races the first for the same jobs. Callers that aren't already a
// running worker (the stale-sweep tick, startup restore) call runWorker()
// themselves right after this.
function promoteBatches() {
  if (assemblingBatch && assemblingBatch.jobIds.length > 0 && now() - assemblingBatch.createdAt >= queueConfig.orphanBatchTimeoutMs) {
    console.log(`[batch] ${assemblingBatch.id} promoted early: orphaned after ${queueConfig.orphanBatchTimeoutMs}ms with only ${assemblingBatch.jobIds.length} job(s).`);
    lockBatch(assemblingBatch, { immediate: true });
  }
  const frontId = pendingBatchIds[0];
  const front = frontId && batches.get(frontId);
  if (front && front.status === 'READY' && now() >= front.scheduledProcessTime) {
    front.status = 'PROCESSING';
    console.log(`[batch] ${front.id} promoted to PROCESSING.`);
    maybeCompleteBatch(front); // covers the empty-batch case (see maybeCompleteBatch) so an emptied batch can't block the next one
  }
}

function batchEtaSeconds(batch) {
  if (!batch) return null;
  if (batch.status === 'PROCESSING') return 0;
  if (batch.status === 'READY') return Math.max(0, Math.round((batch.scheduledProcessTime - now()) / 1000));
  return null; // ASSEMBLING has no fixed ETA yet
}

function serializeBatchSummary() {
  const assembling = assemblingBatch ? { id: assemblingBatch.id, jobCount: assemblingBatch.jobIds.length, batchSize: queueConfig.batchSize } : null;
  const ready = pendingBatchIds
    .map((id) => batches.get(id))
    .filter((b) => b && b.status === 'READY')
    .map((b) => ({ id: b.id, jobCount: b.jobIds.length, etaSeconds: batchEtaSeconds(b) }));
  const processingId = pendingBatchIds.find((id) => batches.get(id)?.status === 'PROCESSING') || null;
  return { assembling, ready, processingBatchId: processingId };
}

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
  jobs.set(id, { id, status: 'queued', postText, recipientEmail, batchId: null, createdAt: ts, updatedAt: ts, startedAt: null, draftedAt: null, waitingAt: null, sendingAt: null, completedAt: null, plannedSendAt: null, result: null, error: null, lastErrorAt: null, retryCount: 0, claimedBy: null, claimedAt: null, lockUntil: null, sendAttemptStartedAt: null, queueSeq: nextQueueSeq++, events: [{ at: ts, phase: 'queued', message: 'Queued for processing.' }] });
  queuedJobIds.push(id);
  assignJobToBatch(id);
  assertQueueInvariants({ allowStoppedWorker: true });
  schedulePersist();
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
// Flat per-job time estimate used to walk forward through batches ahead of a
// job — drafting + sending + the pacing gap between sends within a batch.
const perJobSeconds = () => queueConfig.estimatedDraftSeconds + queueConfig.estimatedSendSeconds + queueConfig.minSendIntervalMs / 1000 + queueConfig.jitterMaxMs / 2000;

// Seconds from now until job's own batch actually starts processing its
// first job. Walks pendingBatchIds (oldest-first, i.e. arrival/send order)
// so it accounts for BOTH each batch's own remaining delay AND the time
// spent actually processing every batch strictly ahead of job's batch —
// batchWaitSeconds (the function this replaces) only ever looked at job's
// own batch, silently dropping any wait accrued by earlier batches once
// their own scheduledProcessTime was later than when the queue reached
// them. Replaces batchWaitSeconds.
function estimateBatchStartOffset(job) {
  const batchId = job.batchId;
  let t = 0; // seconds from now
  for (const id of pendingBatchIds) {
    const b = batches.get(id);
    if (!b) continue;
    const dueIn = b.status === 'READY'
      ? Math.max(0, (b.scheduledProcessTime - now()) / 1000)
      : 0; // PROCESSING is already due
    t = Math.max(t, dueIn); // can't start before this batch's own due time OR the running total, whichever is later
    if (id === batchId) return t; // reached job's own batch
    t += b.jobIds.length * perJobSeconds(); // then account for time spent actually processing this batch
  }
  // job's batch is still ASSEMBLING (not yet in pendingBatchIds) — fall back
  // to the orphan-timeout upper bound, same as batchWaitSeconds used to for
  // this case (there's no exact answer yet: could still fill from more
  // arrivals, or get promoted early by the orphan timeout).
  const assembling = batches.get(batchId);
  return assembling ? Math.max(t, (queueConfig.orphanBatchTimeoutMs - (now() - assembling.createdAt)) / 1000) : t;
}

function estimateEtaSeconds(job) {
  if (job.status === 'queued') {
    const batch = batches.get(job.batchId);
    // Position *within its own batch only* — global FIFO position
    // double-counts jobs sitting in earlier batches, since
    // estimateBatchStartOffset above already accounts for the time spent
    // processing those batches.
    const positionInBatch = batch ? Math.max(1, batch.jobIds.indexOf(job.id) + 1) : (queuePosition(job.id) || 1);
    const activePenalty = activeJobId ? queueConfig.estimatedDraftSeconds + queueConfig.estimatedSendSeconds : 0;
    const jobsAheadInBatch = positionInBatch - 1;
    const sendWait = Math.max(0, nextEligibleSendAt() - now()) / 1000;
    const withinBatchEstimate = activePenalty + sendWait + jobsAheadInBatch * perJobSeconds();
    return Math.min(24 * 60 * 60, Math.max(0, Math.round(estimateBatchStartOffset(job) + withinBatchEstimate)));
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
  const body = { id: job.id, status: job.status, state: job.status, recipientEmail: job.recipientEmail, batchId: job.batchId, createdAt: asIso(job.createdAt), updatedAt: asIso(job.updatedAt), startedAt: asIso(job.startedAt), draftedAt: asIso(job.draftedAt), waitingAt: asIso(job.waitingAt), sendingAt: asIso(job.sendingAt), completedAt: asIso(job.completedAt), plannedSendAt: asIso(job.plannedSendAt), lastErrorAt: asIso(job.lastErrorAt), inFlight: activeJobId === job.id, active: activeJobId === job.id, position: activeJobId === job.id ? 0 : queuePosition(job.id), etaSeconds: eta, error: job.error, retryCount: job.retryCount || 0, canRetry: FAILURE_STATUSES.has(job.status), claimedBy: job.claimedBy, claimedAt: asIso(job.claimedAt), lockUntil: asIso(job.lockUntil), events: job.events.map((e) => ({ ...e, at: asIso(e.at) })) };
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
      // A job's legal failure exit depends on which phase it's stuck in —
      // 'waiting' (drafted, waiting for a send slot) can only legally move
      // to 'send_failed' per LEGAL_TRANSITIONS, not 'draft_failed'. Getting
      // this wrong throws inside transitionJob, which — since that throw
      // happens mid-scan here, before the stuck job's status is cleared —
      // makes every subsequent sweep tick retry the same job and throw
      // again forever.
      const status = job.status === 'sending' ? 'send_unknown' : job.status === 'waiting' ? 'send_failed' : 'draft_failed';
      failActiveJob(job, status, `Recovered stale ${job.status} job after processing timeout.`);
      // A recovered job is done — it must not keep reporting worker
      // ownership metadata for a claim that no longer exists, or /api/status
      // would misleadingly show a terminal job as still "claimed".
      job.claimedBy = null;
      job.lockUntil = null;
      if (activeJobId === job.id) activeJobId = null;
      maybeCompleteBatch(batches.get(job.batchId));
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

function pruneOldBatches() {
  const limit = queueConfig.batchRetentionLimit;
  if (batches.size <= limit) return;
  const completed = Array.from(batches.values())
    .filter((b) => b.status === 'COMPLETED')
    .sort((a, b) => a.createdAt - b.createdAt);
  let excess = batches.size - limit;
  for (const batch of completed) {
    if (excess <= 0) break;
    batches.delete(batch.id);
    excess -= 1;
  }
}

let persistTimer = null;
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    saveNow(queueConfig.persistPath, snapshotState()).catch((err) => console.error('[persist] save failed:', err));
  }, queueConfig.persistDebounceMs);
  persistTimer.unref?.();
}

function snapshotState() {
  return {
    jobs: Array.from(jobs.values()),
    batches: Array.from(batches.values()),
    queuedJobIds: queuedJobIds.slice(queueHead),
    pendingBatchIds: [...pendingBatchIds],
    assemblingBatchId: assemblingBatch ? assemblingBatch.id : null,
    counters: { nextQueueSeq, dequeueSeq, workerSeq, nextBatchSeq, lastSendAt, claimedSendSlotAt }
  };
}

function restoreState(state) {
  if (!state) return;
  jobs.clear(); queuedJobIds.splice(0); batches.clear(); pendingBatchIds.splice(0);
  for (const job of state.jobs || []) jobs.set(job.id, job);
  for (const batch of state.batches || []) batches.set(batch.id, batch);
  // Loaded queuedJobIds are already "live" (dead-prefix entries are never
  // persisted — see snapshotState), so queueHead restarts at 0 and
  // dequeueSeq/queueSeq positions are recomputed relative to that.
  for (const id of state.queuedJobIds || []) queuedJobIds.push(id);
  queueHead = 0; // queuedJobIds only ever stores the live suffix (see snapshotState), so the head starts at 0 again
  for (const id of state.pendingBatchIds || []) pendingBatchIds.push(id);
  assemblingBatch = state.assemblingBatchId ? batches.get(state.assemblingBatchId) || null : null;
  const counters = state.counters || {};
  nextQueueSeq = counters.nextQueueSeq || 0;
  dequeueSeq = counters.dequeueSeq || 0; // preserved as-is: queuePosition() is queueSeq - dequeueSeq, both saved from the same moment
  workerSeq = counters.workerSeq || 0;
  nextBatchSeq = counters.nextBatchSeq || 0;
  lastSendAt = counters.lastSendAt || 0;
  claimedSendSlotAt = counters.claimedSendSlotAt || 0;
  console.log(`[persist] restored ${jobs.size} job(s), ${batches.size} batch(es) from ${queueConfig.persistPath}`);
}

let staleSweepTimer = null;
function startStaleSweep() {
  if (staleSweepTimer) return;
  staleSweepTimer = setInterval(() => {
    try {
      recoverStaleJobs();
      promoteBatches();
      if (queueLength() > 0) runWorker(); // promoteBatches() itself never calls runWorker() — see its comment; this is the wake-up for the "nothing was actively draining" case
      pruneOldJobs(); pruneOldBatches(); schedulePersist();
    }
    catch (err) { console.error('[queue] stale sweep failed:', err); }
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
  const { rejected, reason } = checkDraftSafety(draft);
  if (rejected) {
    failActiveJob(job, 'rejected', reason, draft);
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
  console.log(`[send] job=${job.id} attempting SMTP send to="${job.recipientEmail}" subject="${draft.subject}" timeoutMs=${queueConfig.sendTimeoutMs}`);
  const sendStartedAt = Date.now();
  try {
    await withTimeout(services.sendOutreachEmail({ to: job.recipientEmail, subject: draft.subject, body: draft.body }), queueConfig.sendTimeoutMs, 'SMTP send');
    lastSendAt = now();
    console.log(`[send] job=${job.id} SUCCEEDED in ${Date.now() - sendStartedAt}ms`);
    transitionJob(job, 'sent', { completedAt: now(), result: draft, message: 'Email sent successfully.' });
  } catch (err) {
    lastSendAt = now();
    const message = normalizeError(err).message;
    const outcome = message.includes('timed out') ? 'send_unknown' : 'send_failed';
    // Full diagnostic dump: err.code/command/responseCode come from nodemailer's
    // SMTP transport and are the actual reason Gmail/the network rejected the
    // send (auth failure, connection refused, blocked port, etc.) — the
    // wrapped `message` alone often just says "Failed to send email via Gmail SMTP: ...".
    console.error(
      `[send] job=${job.id} FAILED after ${Date.now() - sendStartedAt}ms -> outcome=${outcome}\n` +
      `  message: ${message}\n` +
      `  err.code: ${err?.code ?? 'n/a'}\n` +
      `  err.command: ${err?.command ?? 'n/a'}\n` +
      `  err.responseCode: ${err?.responseCode ?? 'n/a'}\n` +
      `  err.response: ${err?.response ?? 'n/a'}`
    );
    failActiveJob(job, outcome, `Draft looked good but sending failed: ${message}`, draft);
  }
}

async function drainQueue(workerId, myGeneration) {
  console.log(`[worker] ${workerId} started with ${queueLength()} queued job(s).`);
  while (true) {
    if (myGeneration !== generation) { console.log(`[worker] ${workerId} stopping: superseded by a reset.`); return; }
    recoverStaleJobs();
    promoteBatches();
    const jobId = queuedJobIds[queueHead];
    if (jobId === undefined) break;
    const job = jobs.get(jobId);
    if (!job) { advanceQueueHead(); continue; }
    if (job.status !== 'queued') { console.error(`[queue] dropping corrupt queue entry ${jobId} status=${job.status}`); advanceQueueHead(); continue; }
    // The job at the head of the FIFO may still be sitting in an
    // ASSEMBLING/READY batch — batching gates *when* a job may be claimed,
    // not whether it's in the queue. Wait (don't break-and-let-runWorker's
    // .finally immediately restart us) — that pattern was tried first and
    // is a real hazard: with no delay, "not releasable yet" turns into a
    // tight microtask restart loop (drainQueue exits -> .finally sees
    // queueLength()>0 -> calls runWorker() again -> exits again...) that
    // starves the event loop's timer queue entirely, so even a legitimately
    // *sending* job's own sleep() never gets to fire. Waiting here instead
    // keeps this one drain loop alive (cheap - it's a real setTimeout, not
    // a spin) until the batch is promoted, jobs must stay in arrival order.
    if (!isJobReleasable(job)) {
      const batch = batches.get(job.batchId);
      const untilScheduled = batch?.scheduledProcessTime ? batch.scheduledProcessTime - now() : Infinity;
      const waitMs = Math.max(25, Math.min(untilScheduled, queueConfig.staleSweepIntervalMs));
      await sleep(waitMs);
      continue;
    }
    activeJobId = jobId;
    transitionJob(job, 'processing', { claimedBy: workerId, claimedAt: now(), lockUntil: now() + queueConfig.jobProcessingTimeoutMs, message: 'Safely claimed by worker.' });
    advanceQueueHead();
    job.startedAt = job.startedAt || now();
    try { await processJob(job); }
    catch (err) { failActiveJob(job, job.status === 'sending' ? 'send_unknown' : 'draft_failed', `Unexpected worker error: ${normalizeError(err).message}`); }
    finally {
      if (activeJobId === jobId) activeJobId = null;
      job.claimedBy = null;
      job.lockUntil = null;
      maybeCompleteBatch(batches.get(job.batchId));
      assertQueueInvariants({ allowStoppedWorker: true });
      schedulePersist();
    }
  }
  console.log(`[worker] ${workerId} queue drained.`);
}

export function runWorker() {
  if (workerPromise) return workerPromise;
  const workerId = `worker-${++workerSeq}`;
  const myGeneration = generation;
  workerPromise = drainQueue(workerId, myGeneration)
    .catch((err) => console.error('[worker] fatal drain error:', err))
    .finally(() => {
      if (myGeneration !== generation) return; // superseded by a reset — don't touch the new generation's state or self-restart into it
      workerPromise = null;
      assertQueueInvariants({ allowStoppedWorker: true });
      if (queueLength() > 0) runWorker();
    });
  return workerPromise;
}

app.post('/api/send-outreach', (req, res) => {
  const { postText, recipientEmail } = req.body || {};
  if (!postText || !postText.trim()) return res.status(400).json({ error: 'Paste the LinkedIn post text first.' });

  // An explicitly-typed, valid address always takes priority over anything
  // auto-detected from the post text itself. The current frontend leaves
  // this field blank and relies on the server to fill it in, so this
  // fallback has to stay even though the zip's original handler dropped it.
  let resolvedEmail = recipientEmail && recipientEmail.trim();
  let emailAutoDetected = false;
  if (!resolvedEmail || !EMAIL_RE.test(resolvedEmail)) {
    const detected = extractEmailFromText(postText);
    if (detected && EMAIL_RE.test(detected)) {
      resolvedEmail = detected;
      emailAutoDetected = true;
    }
  }

  if (!resolvedEmail || !EMAIL_RE.test(resolvedEmail)) {
    return res.status(400).json({ error: 'Enter a valid recipient email, or paste a post that includes one.' });
  }

  const jobId = makeJob(postText.trim(), resolvedEmail);
  const job = jobs.get(jobId);
  const position = queuePosition(jobId) || 1;
  const etaSeconds = estimateEtaSeconds(job);
  runWorker();
  res.status(202).json({
    jobId, status: 'queued', position, etaSeconds,
    recipientEmail: resolvedEmail, emailAutoDetected
  });
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
  // A retried job re-enters batching fresh rather than resuming whatever
  // batch it originally belonged to — that batch may already be COMPLETED,
  // and even if not, splicing a re-queued job back into an in-flight batch
  // would break the "batch = one arrival-order group" model. Detach it
  // from the old batch first, which may itself complete that batch if this
  // was the last job it was waiting on.
  const oldBatch = batches.get(job.batchId);
  if (oldBatch) { oldBatch.jobIds = oldBatch.jobIds.filter((id) => id !== job.id); maybeCompleteBatch(oldBatch); }
  Object.assign(job, { batchId: null, startedAt: null, draftedAt: null, waitingAt: null, sendingAt: null, completedAt: null, plannedSendAt: null, error: null, lastErrorAt: null, claimedBy: null, claimedAt: null, lockUntil: null, sendAttemptStartedAt: null, queueSeq: nextQueueSeq++ });
  queuedJobIds.push(job.id);
  assignJobToBatch(job.id);
  transitionJob(job, 'queued', { message: `Re-queued at the back for retry attempt ${job.retryCount + 1}.` });
  runWorker();
  schedulePersist();
  res.status(202).json({ jobId: job.id, status: 'queued', position: queuePosition(job.id) || 1, etaSeconds: estimateEtaSeconds(job) });
});

app.get('/api/status/:jobId', (req, res) => { const job = jobs.get(req.params.jobId); if (!job) return res.status(404).json({ error: 'Unknown job id.' }); res.json(serializeJob(job, { includeDraft: true })); });
app.get('/api/jobs', (_req, res) => {
  const jobsList = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, queueConfig.jobListLimit).map((job) => serializeJob(job));
  res.json({ worker: { running: Boolean(workerPromise), activeJobId, currentJobId: activeJobId, queuedCount: queueLength(), queueIds: queuedJobIds.slice(queueHead), lastSendAt: asIso(lastSendAt), nextEligibleSendAt: lastSendAt || claimedSendSlotAt ? asIso(nextEligibleSendAt()) : null }, batches: serializeBatchSummary(), jobs: jobsList });
});

export const __queueTest = {
  jobs, queuedJobIds,
  // queuedJobIds can contain a dead prefix (already-dequeued ids not yet
  // compacted away — see advanceQueueHead) — this returns only the ids
  // actually still queued, i.e. what queuedJobIds itself used to mean
  // before the O(1)-dequeue change.
  liveQueuedIds() { return queuedJobIds.slice(queueHead); },
  setServices(next) { services = { ...services, ...next }; },
  reset() {
    generation += 1; // invalidate any drainQueue instance left running from a previous test — see the `generation` comment above
    jobs.clear(); queuedJobIds.splice(0); queueHead = 0; activeJobId = null; workerPromise = null; lastSendAt = 0; claimedSendSlotAt = 0; workerSeq = 0; nextQueueSeq = 0; dequeueSeq = 0;
    batches.clear(); pendingBatchIds.splice(0); assemblingBatch = null; nextBatchSeq = 0;
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    services = { extractConceptAndDraft: defaultExtractConceptAndDraft, sendOutreachEmail: defaultSendOutreachEmail };
    stopStaleSweep();
  },
  makeJob, serializeJob, runWorker, recoverStaleJobs, pruneOldJobs, startStaleSweep, stopStaleSweep,
  batches, promoteBatches, pruneOldBatches, lockBatch, assignJobToBatch, maybeCompleteBatch,
  estimateEtaSeconds, estimateBatchStartOffset,
  snapshotState, restoreState,
  getDiagnostics() { return { workerPromise, activeJobId, queueIds: [...queuedJobIds], lastSendAt, claimedSendSlotAt, jobs: Array.from(jobs.values()), batches: Array.from(batches.values()), pendingBatchIds: [...pendingBatchIds], assemblingBatchId: assemblingBatch?.id || null }; }
};

export default app;

if (process.env.NODE_ENV !== 'test') {
  const restored = await loadState(queueConfig.persistPath);
  if (restored) {
    restoreState(restored);
    // A batch could have matured (or a job's processing lock could have
    // expired) entirely while this process was down — evaluate both
    // immediately rather than waiting for the first sweep tick.
    recoverStaleJobs();
    promoteBatches();
    if (queueLength() > 0) runWorker();
  }
  app.listen(PORT, () => console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`));
  startStaleSweep();

  // Render (and most PaaS hosts) send SIGTERM on every redeploy/restart —
  // stop taking new work and close the SMTP transporter cleanly instead of
  // getting killed mid-send.
  const shutdown = (signal) => {
    console.log(`[server] ${signal} received, shutting down...`);
    stopStaleSweep();
    closeTransporter();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
