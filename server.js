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
  estimatedSendSeconds: Number(process.env.ESTIMATED_SEND_SECONDS || 10)
};

const jobs = new Map();
const queuedJobIds = [];
let activeJobId = null;
let workerPromise = null;
let lastSendAt = 0;
let claimedSendSlotAt = 0;
let workerSeq = 0;
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
  console.log(`[queue] job=${job.id} ${from} -> ${to} queue=${queuedJobIds.length} active=${activeJobId || '-'} retry=${job.retryCount || 0} at=${new Date().toISOString()}`);
}

export function assertQueueInvariants({ allowStoppedWorker = false } = {}) {
  const problems = [];
  const seen = new Set();
  for (const id of queuedJobIds) {
    if (seen.has(id)) problems.push(`duplicate job id in queue: ${id}`);
    seen.add(id);
    const job = jobs.get(id);
    if (!job) problems.push(`queue contains nonexistent job: ${id}`);
    else if (job.status !== 'queued') problems.push(`queue contains ${id} with status ${job.status}`);
  }
  const activeJobs = Array.from(jobs.values()).filter((job) => ACTIVE_STATUSES.has(job.status));
  if (activeJobs.length > 1) problems.push(`more than one active job: ${activeJobs.map((j) => j.id).join(',')}`);
  if (activeJobId && queuedJobIds.includes(activeJobId)) problems.push(`active job is also queued: ${activeJobId}`);
  for (const job of jobs.values()) {
    if (job.status === 'queued' && !seen.has(job.id)) problems.push(`queued job missing from queue: ${job.id}`);
    if (TERMINAL_STATUSES.has(job.status) && seen.has(job.id)) problems.push(`terminal job still queued: ${job.id}`);
  }
  if (!allowStoppedWorker && queuedJobIds.length > 0 && !workerPromise) problems.push(`worker stopped while queue has ${queuedJobIds.length} job(s)`);
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
  jobs.set(id, { id, status: 'queued', postText, recipientEmail, createdAt: ts, updatedAt: ts, startedAt: null, draftedAt: null, waitingAt: null, sendingAt: null, completedAt: null, plannedSendAt: null, result: null, error: null, lastErrorAt: null, retryCount: 0, claimedBy: null, claimedAt: null, lockUntil: null, sendAttemptStartedAt: null, events: [{ at: ts, phase: 'queued', message: 'Queued for processing.' }] });
  queuedJobIds.push(id);
  assertQueueInvariants({ allowStoppedWorker: true });
  return id;
}

function queuePosition(jobId) { const idx = queuedJobIds.indexOf(jobId); return idx === -1 ? null : idx + 1; }
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
  return undefined;
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
      if (activeJobId === job.id) activeJobId = null;
    }
  }
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
  console.log(`[worker] ${workerId} started with ${queuedJobIds.length} queued job(s).`);
  while (true) {
    recoverStaleJobs();
    const jobId = queuedJobIds[0];
    if (!jobId) break;
    const job = jobs.get(jobId);
    if (!job) { queuedJobIds.shift(); continue; }
    if (job.status !== 'queued') { console.error(`[queue] dropping corrupt queue entry ${jobId} status=${job.status}`); queuedJobIds.shift(); continue; }
    activeJobId = jobId;
    transitionJob(job, 'processing', { claimedBy: workerId, claimedAt: now(), lockUntil: now() + queueConfig.jobProcessingTimeoutMs, message: 'Safely claimed by worker.' });
    queuedJobIds.shift();
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
    .finally(() => { workerPromise = null; assertQueueInvariants({ allowStoppedWorker: true }); if (queuedJobIds.length) runWorker(); });
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
  if (queuedJobIds.includes(job.id) || activeJobId === job.id) return res.status(202).json({ jobId: job.id, status: job.status, position: queuePosition(job.id), etaSeconds: estimateEtaSeconds(job), message: 'This job is already queued or active.' });
  job.retryCount = (job.retryCount || 0) + 1;
  Object.assign(job, { startedAt: null, draftedAt: null, waitingAt: null, sendingAt: null, completedAt: null, plannedSendAt: null, error: null, lastErrorAt: null, claimedBy: null, claimedAt: null, lockUntil: null, sendAttemptStartedAt: null });
  queuedJobIds.push(job.id);
  transitionJob(job, 'queued', { message: `Re-queued at the back for retry attempt ${job.retryCount + 1}.` });
  runWorker();
  res.status(202).json({ jobId: job.id, status: 'queued', position: queuePosition(job.id) || 1, etaSeconds: estimateEtaSeconds(job) });
});

app.get('/api/status/:jobId', (req, res) => { const job = jobs.get(req.params.jobId); if (!job) return res.status(404).json({ error: 'Unknown job id.' }); res.json(serializeJob(job, { includeDraft: true })); });
app.get('/api/jobs', (_req, res) => {
  const jobsList = Array.from(jobs.values()).sort((a, b) => b.createdAt - a.createdAt).slice(0, queueConfig.jobListLimit).map((job) => serializeJob(job));
  res.json({ worker: { running: Boolean(workerPromise), activeJobId, currentJobId: activeJobId, queuedCount: queuedJobIds.length, queueIds: [...queuedJobIds], lastSendAt: asIso(lastSendAt), nextEligibleSendAt: lastSendAt || claimedSendSlotAt ? asIso(nextEligibleSendAt()) : null }, jobs: jobsList });
});

export const __queueTest = {
  jobs, queuedJobIds,
  setServices(next) { services = { ...services, ...next }; },
  reset() { jobs.clear(); queuedJobIds.splice(0); activeJobId = null; workerPromise = null; lastSendAt = 0; claimedSendSlotAt = 0; workerSeq = 0; services = { extractConceptAndDraft: defaultExtractConceptAndDraft, sendOutreachEmail: defaultSendOutreachEmail }; },
  makeJob, serializeJob, runWorker, recoverStaleJobs,
  getDiagnostics() { return { workerPromise, activeJobId, queueIds: [...queuedJobIds], lastSendAt, claimedSendSlotAt, jobs: Array.from(jobs.values()) }; }
};

export default app;

if (process.env.NODE_ENV !== 'test' && !process.env.VERCEL) {
  app.listen(PORT, () => console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`));
}
