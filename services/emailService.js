// Nodemailer transport + resume attachment. Sends via Gmail SMTP.
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { profile } from '../config/profile.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RESUME_PATH = process.env.RESUME_PATH || path.join(__dirname, '..', 'resume', 'resume.pdf');

// Intentionally unpooled (nodemailer defaults to pool: false unless you opt
// in). A pooled connection can go stale after Gmail closes it server-side,
// and the next send just hangs on the dead socket until the queue's send
// timeout kills it — see README "Notes" for the real bug this caused.
// Opening a fresh connection per send costs a little latency but is what's
// actually reliable here; don't add `pool: true` without also handling
// stale-connection detection.
let transporter = null;
function getTransporter() {
  if (!transporter) {
    const user = process.env.EMAIL_USER;
    const pass = process.env.EMAIL_APP_PASSWORD;
    if (!user || !pass) {
      throw new Error(
        'EMAIL_USER / EMAIL_APP_PASSWORD are not set — cannot send email. Set them in .env (App Password from https://myaccount.google.com/apppasswords, not your normal Gmail password).'
      );
    }
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user, pass }
    });
  }
  return transporter;
}

// Draft-only / dry-run mode (see .env DRY_RUN and README "Draft-only mode
// for testing"). Nothing is sent over SMTP — the would-be email is appended
// to DRY_RUN_LOG_PATH instead, so a student can review the first 10-20
// drafts for tone before ever risking a real recruiter's inbox.
const DRY_RUN = String(process.env.DRY_RUN || '').trim() === '1' ||
  String(process.env.DRY_RUN || '').trim().toLowerCase() === 'true';
const DRY_RUN_LOG_PATH = process.env.DRY_RUN_LOG_PATH ||
  path.join(__dirname, '..', 'data', 'drafts.json');

function appendDryRunDraft(entry) {
  let existing = [];
  try {
    if (fs.existsSync(DRY_RUN_LOG_PATH)) {
      existing = JSON.parse(fs.readFileSync(DRY_RUN_LOG_PATH, 'utf8'));
      if (!Array.isArray(existing)) existing = [];
    }
  } catch {
    existing = []; // corrupt/missing file — start fresh rather than crash a dry run
  }
  existing.push(entry);
  fs.mkdirSync(path.dirname(DRY_RUN_LOG_PATH), { recursive: true });
  fs.writeFileSync(DRY_RUN_LOG_PATH, JSON.stringify(existing, null, 2));
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Converts the LLM's plain-text body (paragraphs separated by blank lines,
// achievement bullets as "- " lines — see cerebrasService.js STEP 3) into
// simple, email-client-safe HTML: <p> per paragraph, <ul>/<li> for bullet
// runs. Deliberately minimal — no external CSS, no images, nothing that
// trips spam filters or breaks in Gmail's/Outlook's stripped-down renderers.
function bodyToHtml(body) {
  const blocks = String(body || '').trim().split(/\n\s*\n/);
  const html = blocks.map((block) => {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    const isBulletBlock = lines.length > 0 && lines.every((l) => /^[-•]\s+/.test(l));
    if (isBulletBlock) {
      const items = lines.map((l) => `<li>${escapeHtml(l.replace(/^[-•]\s+/, ''))}</li>`).join('');
      return `<ul style="margin:0 0 12px;padding-left:20px;">${items}</ul>`;
    }
    const escaped = lines.map(escapeHtml).join('<br>');
    return `<p style="margin:0 0 12px;">${escaped}</p>`;
  }).join('');
  return html;
}

function stripProtocol(url) {
  return String(url || '').replace(/^https?:\/\//, '');
}

// Contact links live here, not in the LLM prompt (see cerebrasService.js
// STEP 3 point 7) — the model is told to stop at "Sincerely,\n\n{name}" so
// this block is appended identically to every email, in dry-run logs and
// real sends alike, rather than trusting the model to reproduce URLs
// verbatim every time. Deliberately plain and compact — no boxes, no bold,
// no dot-separated single line — a short label per line reads cleanly in
// both an HTML client and a plain-text one.
function signatureHtml() {
  return `<p style="margin:4px 0 0;font-size:13px;color:#555;">
${escapeHtml(profile.phone)} · ${escapeHtml(profile.email)}<br>
Portfolio: <a href="https://${stripProtocol(profile.portfolioLink)}">${escapeHtml(profile.portfolioLink)}</a><br>
GitHub: <a href="https://${stripProtocol(profile.githubLink)}">${escapeHtml(profile.githubLink)}</a><br>
LinkedIn: <a href="https://${stripProtocol(profile.linkedinLink)}">${escapeHtml(profile.linkedinLink)}</a>
</p>`;
}

function signatureText() {
  return `${profile.phone} · ${profile.email}\nPortfolio: ${profile.portfolioLink}\nGitHub: ${profile.githubLink}\nLinkedIn: ${profile.linkedinLink}`;
}

export async function sendOutreachEmail({ to, subject, body }) {
  if (!fs.existsSync(RESUME_PATH)) {
    throw new Error(`Resume not found at ${RESUME_PATH} — add resume/resume.pdf, or set RESUME_PATH in .env.`);
  }

  // Single \n, not a blank line: the model's body already ends with
  // "Sincerely,\n\n{name}" (see prompt), so this block sits directly under
  // the name — matching a normal letter closing, not a second signature
  // floating below a gap.
  const textBody = `${body}\n${signatureText()}`;
  const htmlBody = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111;line-height:1.5;">${bodyToHtml(body)}${signatureHtml()}</div>`;

  if (DRY_RUN) {
    const draft = { to, subject, body: textBody, html: htmlBody, resumeFilename: profile.resumeFilename, sentAt: new Date().toISOString(), dryRun: true };
    appendDryRunDraft(draft);
    // Fake messageId so callers (queue/status code, tests) that key off a
    // truthy messageId behave identically to a real send.
    return { messageId: `dry-run-${Date.now()}`, dryRun: true };
  }

  const user = process.env.EMAIL_USER;
  const t = getTransporter();
  const info = await t.sendMail({
    from: `"${profile.name}" <${user}>`,
    to,
    replyTo: (process.env.REPLY_TO_EMAIL || user || '').trim(),
    subject,
    text: textBody, // plain-text fallback for clients/screen readers that don't render HTML
    html: htmlBody,
    attachments: [{ filename: profile.resumeFilename, path: RESUME_PATH }]
  });
  return { messageId: info.messageId };
}

// Unpooled means there's no persistent connection sitting open between
// sends, so there's nothing to keep alive between calls — this only exists
// to drop the cached transporter object itself on graceful shutdown.
export function closeTransporter() {
  if (transporter) {
    transporter.close();
    transporter = null;
  }
}
