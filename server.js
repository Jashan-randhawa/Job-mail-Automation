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

// In-memory job store. Fine for a single-process personal tool; jobs are
// lost on restart, which is an acceptable tradeoff here (nothing partially
// sent is lost, only queued-but-not-yet-sent jobs).
const jobs = new Map(); // jobId -> job record
const queue = []; // ordered list of jobIds waiting to be sent
let lastSendAt = 0;
let workerRunning = false;

function makeJob(postText, recipientEmail) {
  const id = crypto.randomUUID();
  jobs.set(id, {
    id,
    status: 'queued', // queued -> drafting -> sending -> sent | failed | rejected
    postText,
    recipientEmail,
    createdAt: Date.now(),
    result: null,
    error: null
  });
  queue.push(id);
  return id;
}

function nextEligibleSendAt() {
  return lastSendAt + MIN_SEND_INTERVAL_MS;
}

async function processJob(job) {
  job.status = 'drafting';

  let draft;
  try {
    draft = await extractConceptAndDraft(job.postText);
  } catch (err) {
    job.status = 'failed';
    job.error = 'Could not generate a draft from that post.';
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
    console.error(`Job ${job.id} failed safety check.`, draft);
    return;
  }

  // Wait out whatever's left of the minimum interval, plus jitter, right
  // before actually sending — this is what keeps sends spaced out even
  // though drafting happened as soon as the job was picked up.
  const waitMs = Math.max(0, nextEligibleSendAt() - Date.now()) + Math.floor(Math.random() * JITTER_MAX_MS);
  if (waitMs > 0) {
    job.status = 'sending';
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  try {
    await sendOutreachEmail({ to: job.recipientEmail, subject: draft.subject, body: draft.body });
    lastSendAt = Date.now();
    job.status = 'sent';
    job.result = draft;
  } catch (err) {
    job.status = 'failed';
    job.error = 'Draft looked good but sending failed. Check your email credentials in .env.';
    job.result = draft;
    console.error(`Job ${job.id} send failed:`, err);
  }
}

async function runWorker() {
  if (workerRunning) return;
  workerRunning = true;
  while (queue.length > 0) {
    const jobId = queue.shift();
    const job = jobs.get(jobId);
    if (job) await processJob(job);
  }
  workerRunning = false;
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
  runWorker(); // fire and forget — processes in the background

  const position = queue.indexOf(jobId) + 1; // 1-based position in line (0 if already picked up)
  const etaSeconds = Math.max(0, Math.round((nextEligibleSendAt() - Date.now()) / 1000)) + (position > 1 ? (position - 1) * (MIN_SEND_INTERVAL_MS / 1000) : 0);

  res.status(202).json({ jobId, status: 'queued', position: position || 1, etaSeconds: Math.round(etaSeconds) });
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Unknown job id.' });

  const response = { status: job.status };
  if (job.status === 'sent') {
    response.concept = job.result?.concept;
    response.subject = job.result?.subject;
  } else if (job.status === 'rejected' || job.status === 'failed') {
    response.error = job.error;
    response.draft = job.result;
  } else {
    const positionInQueue = queue.indexOf(job.id);
    if (positionInQueue !== -1) {
      response.position = positionInQueue + 1;
      response.etaSeconds = Math.max(0, Math.round((nextEligibleSendAt() - Date.now()) / 1000)) + positionInQueue * (MIN_SEND_INTERVAL_MS / 1000);
    }
  }
  res.json(response);
});

app.listen(PORT, () => {
  console.log(`LinkedIn outreach bot running at http://localhost:${PORT}`);
});
