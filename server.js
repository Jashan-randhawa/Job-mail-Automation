import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { extractConceptAndDraft } from './services/openrouterService.js';
import { sendOutreachEmail } from './services/emailService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Rapid-fire, evenly-spaced sends from a personal Gmail account read as
// script activity to Gmail's own abuse detection, which hurts deliverability
// for every send after it. Rather than making the submitter's browser sit on
// an open request for that whole gap, submissions are queued and a
// background worker drains them one at a time, respecting this interval
// (plus a little jitter so the timing isn't perfectly mechanical).
const MIN_SEND_INTERVAL_MS = Number(process.env.MIN_SEND_INTERVAL_MS || 45_000);
const JITTER_MAX_MS = Number(process.env.SEND_JITTER_MAX_MS || 20_000);
const JOB_EVENT_LIMIT = Number(process.env.JOB_EVENT_LIMIT || 50);
const JOB_LIST_LIMIT = Number(process.env.JOB_LIST_LIMIT || 100);

// In-memory job store. Fine for a single-process personal tool; jobs are
// lost on restart, which is an acceptable tradeoff here (nothing partially
// sent is lost, only queued-but-not-yet-sent jobs).
const jobs = new Map(); // jobId -> job record
const queue = []; // ordered list of jobIds waiting to be sent
let lastSendAt = 0;
let workerRunning = false;
let currentJobId = null;

function asIso(ts) {
  return ts ? new Date(ts).toISOString() : null;
}

function addJobEvent(job, phase, message) {
  const at = Date.now();
  job.updatedAt = at;
  job.events.push({ at, phase, message });
  if (job.events.length > JOB_EVENT_LIMIT) {
    job.events.splice(0, job.events.length - JOB_EVENT_LIMIT);
  }
  console.log(`[job:${job.id}] ${phase} - ${message}`);
}

function makeJob(postText, recipientEmail) {
  const id = crypto.randomUUID();
  const now = Date.now();
  jobs.set(id, {
    id,
    status: 'queued', // queued -> drafting -> sending -> sent | failed | rejected
    postText,
    recipientEmail,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    draftedAt: null,
    sendingAt: null,
    completedAt: null,
    plannedSendAt: null,
    result: null,
    error: null,
    lastErrorAt: null,
    events: [{ at: now, phase: 'queued', message: 'Queued for processing.' }]
  });
  queue.push(id);
  return id;
}

function nextEligibleSendAt() {
  return lastSendAt + MIN_SEND_INTERVAL_MS;
}

function getQueuePosition(jobId) {
  const queueIndex = queue.indexOf(jobId);
  if (queueIndex === -1) return null;
  return queueIndex + 1 + (currentJobId ? 1 : 0);
}

function estimateEtaSecondsForPosition(position) {
  if (!position || position < 1) return 0;
  const baseWaitMs = Math.max(0, nextEligibleSendAt() - Date.now());
  const jobsAhead = position - 1;
  const queueDelayMs = jobsAhead * (MIN_SEND_INTERVAL_MS + Math.floor(JITTER_MAX_MS / 2));
  return Math.max(0, Math.round((baseWaitMs + queueDelayMs) / 1000));
}

function serializeJob(job, { includeDraft = false } = {}) {
  const response = {
    id: job.id,
    status: job.status,
    recipientEmail: job.recipientEmail,
    createdAt: asIso(job.createdAt),
    updatedAt: asIso(job.updatedAt),
    startedAt: asIso(job.startedAt),
    draftedAt: asIso(job.draftedAt),
    sendingAt: asIso(job.sendingAt),
    completedAt: asIso(job.completedAt),
    lastErrorAt: asIso(job.lastErrorAt),
    inFlight: currentJobId === job.id,
    error: job.error,
    events: job.events.map((event) => ({ ...event, at: asIso(event.at) }))
  };

  if (job.result?.concept) response.concept = job.result.concept;
  if (job.result?.subject) response.subject = job.result.subject;
  if (includeDraft && job.result) response.draft = job.result;

  if (job.status === 'queued') {
    response.position = getQueuePosition(job.id);
    response.etaSeconds = estimateEtaSecondsForPosition(response.position);
  } else if (job.status === 'sending' && job.plannedSendAt) {
    response.etaSeconds = Math.max(0, Math.round((job.plannedSendAt - Date.now()) / 1000));
  }

  return response;
}

async function processJob(job) {
  job.status = 'drafting';
  job.startedAt = job.startedAt || Date.now();
  addJobEvent(job, 'drafting', 'Generating draft from LinkedIn post.');

  let draft;
  try {
    draft = await extractConceptAndDraft(job.postText);
    job.draftedAt = Date.now();
    addJobEvent(job, 'drafting', 'Draft generated successfully.');
  } catch (err) {
    job.status = 'failed';
    job.error = 'Could not generate a draft from that post.';
    job.lastErrorAt = Date.now();
    job.completedAt = Date.now();
    addJobEvent(job, 'failed', `Drafting failed: ${err?.message || 'unknown error'}`);
    console.error(`Job ${job.id} draft failed:`, err);
    return;
  }

  const hasPlaceholder = /\[[^\]]{1,40}\]/.test(draft.subject || '') || /\[[^\]]{1,40}\]/.test(draft.body || '');
  const tooShort = !draft.body || draft.body.trim().length < 50;
  const missingSubject = !draft.subject || !draft.subject.trim();

  if (hasPlaceholder || tooShort || missingSubject) {
    job.status = 'rejected';
    job.error = 'Generated email failed the safety check (placeholder text, missing subject, or too short). Nothing was sent.';
    job.result = draft;
    job.completedAt = Date.now();
    addJobEvent(job, 'rejected', 'Draft failed safety checks.');
    console.error(`Job ${job.id} failed safety check.`, draft);
    return;
  }

  // Wait out whatever's left of the minimum interval, plus jitter, right
  // before actually sending — this is what keeps sends spaced out even
  // though drafting happened as soon as the job was picked up.
  const waitMs = Math.max(0, nextEligibleSendAt() - Date.now()) + Math.floor(Math.random() * JITTER_MAX_MS);
  job.status = 'sending';
  job.sendingAt = Date.now();
  job.plannedSendAt = Date.now() + waitMs;
  addJobEvent(job, 'sending', waitMs > 0 ? `Waiting ${Math.round(waitMs / 1000)}s before send.` : 'Ready to send immediately.');
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

  try {
    await sendOutreachEmail({ to: job.recipientEmail, subject: draft.subject, body: draft.body });
    lastSendAt = Date.now();
    job.status = 'sent';
    job.result = draft;
    job.completedAt = Date.now();
    job.plannedSendAt = null;
    addJobEvent(job, 'sent', 'Email sent successfully.');
  } catch (err) {
    job.status = 'failed';
    job.error = 'Draft looked good but sending failed. Check your email credentials in .env.';
    job.result = draft;
    job.lastErrorAt = Date.now();
    job.completedAt = Date.now();
    job.plannedSendAt = null;
    addJobEvent(job, 'failed', `Send failed: ${err?.message || 'unknown error'}`);
    console.error(`Job ${job.id} send failed:`, err);
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  console.log(`[worker] started with ${queue.length} queued job(s).`);
  while (queue.length > 0) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    currentJobId = jobId;
    if (!job) {
      currentJobId = null;
      continue;
    }

    addJobEvent(job, 'worker', 'Picked up by worker.');
    try {
      await processJob(job);
    } catch (err) {
      job.status = 'failed';
      job.error = 'Worker failed unexpectedly while processing this job.';
      job.lastErrorAt = Date.now();
      job.completedAt = Date.now();
      addJobEvent(job, 'failed', `Unexpected worker error: ${err?.message || 'unknown error'}`);
      console.error(`Job ${job.id} unexpected worker error:`, err);
    } finally {
      currentJobId = null;
    }
  }
  workerRunning = false;
  console.log('[worker] queue drained.');
}

app.post('/api/send-outreach', (req, res) => {
  const { postText, recipientEmail } = req.body || {};

  if (!postText || !postText.trim()) {
    return res.status(400).json({ error: 'Paste the LinkedIn post text first.' });
  }
  if (!recipientEmail || !EMAIL_RE.test(recipientEmail)) {
    return res.status(400).json({ error: 'Enter a valid recipient email.' });
  }

  const jobId = makeJob(postText.trim(), recipientEmail.trim());
  const position = getQueuePosition(jobId) || 1;
  const etaSeconds = estimateEtaSecondsForPosition(position);

  runWorker(); // fire and forget — processes in the background

  res.status(202).json({ jobId, status: 'queued', position, etaSeconds });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });
  res.json(serializeJob(job, { includeDraft: true }));
});

app.get('/api/jobs', (_req, res) => {
  const jobsList = Array.from(jobs.values())
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, JOB_LIST_LIMIT)
    .map((job) => serializeJob(job));

  res.json({
    worker: {
      running: workerRunning,
      currentJobId,
      queuedCount: queue.length,
      lastSendAt: asIso(lastSendAt),
      nextEligibleSendAt: asIso(nextEligibleSendAt())
    },
    jobs: jobsList
  });
});

app.listen(PORT, () => {
  console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`);
});
