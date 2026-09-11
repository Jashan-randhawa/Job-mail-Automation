// WhatsApp Channel Integration — Revised Plan
//
// Implements manual, on-demand outreach: sends one fixed greeting message
// plus the resume PDF directly to one contact at a time without an automated
// queue, randomized pacing delays, or daily send caps.

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { initWhatsapp, getStatus, getQr, sendDirectMessage } from './services/whatsappClient.js';
import { loadState, saveNow } from './persistence/store.js';
import { isValidPhone, DEFAULT_GREETING } from './services/whatsappPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const app = express();
const PORT = process.env.PORT || 4000;

const API_KEY = process.env.WHATSAPP_API_KEY;
if (!API_KEY || !API_KEY.trim()) {
  console.warn('[startup] WHATSAPP_API_KEY is not set — every request will be rejected with 401 until it is set.');
}

app.use(cors());
app.use(express.json({ limit: '256kb' }));

export const config = {
  persistPath: process.env.WHATSAPP_PERSIST_PATH || path.join(__dirname, 'data', 'sent-contacts.json')
};

// Persisted log of contacts messaged: [{ phone, sentAt, attachmentSent, messageId }]
let sentLog = [];

export function getSentLog() {
  return sentLog;
}

export async function recordSend(entry) {
  sentLog.push(entry);
  try {
    await saveNow(config.persistPath, { sentLog });
  } catch (err) {
    console.error('[persist] failed to save sent log:', err.message);
  }
}

function requireApiKey(req, res, next) {
  const apiKey = (process.env.WHATSAPP_API_KEY || '').trim();
  const provided = req.get('x-api-key');
  if (!apiKey || !provided || provided !== apiKey) {
    return res.status(401).json({ error: 'Missing or invalid x-api-key header.' });
  }
  next();
}

// QR pairing endpoint
app.get('/whatsapp/qr', requireApiKey, (_req, res) => res.json(getQr()));

// Status endpoint: connection state + summary of sent outreach
app.get('/whatsapp/status', requireApiKey, (_req, res) => {
  const status = getStatus();
  res.json({
    ...status,
    totalSent: sentLog.length,
    recentSends: sentLog.slice(-10).reverse(),
    queueLength: 0 // backwards compatibility for any legacy callers
  });
});

// History endpoint: query who has already received the greeting
app.get('/whatsapp/history', requireApiKey, (_req, res) => {
  res.json({
    totalSent: sentLog.length,
    history: sentLog.slice().reverse()
  });
});

// Direct on-demand send endpoint
app.post('/whatsapp/send', requireApiKey, async (req, res) => {
  const { phone, message, attachResume = true, resumePath } = req.body || {};
  const trimmedPhone = phone ? String(phone).trim() : '';

  if (!trimmedPhone || !isValidPhone(trimmedPhone)) {
    return res.status(400).json({ error: 'Provide a valid phone number in international format, e.g. +919876543210.' });
  }

  const previousSend = sentLog.slice().reverse().find((item) => item.phone === trimmedPhone);

  try {
    const result = await sendDirectMessage({
      phone: trimmedPhone,
      message: message || DEFAULT_GREETING,
      attachResume: attachResume !== false,
      resumePath
    });

    const entry = {
      phone: trimmedPhone,
      sentAt: result.sentAt,
      attachmentSent: result.attachmentSent,
      messageId: result.messageId
    };
    await recordSend(entry);

    res.status(200).json({
      ok: true,
      ...entry,
      previouslySent: Boolean(previousSend),
      previousSentAt: previousSend ? previousSend.sentAt : null
    });
  } catch (err) {
    console.error(`[whatsapp-send] send to ${trimmedPhone} failed:`, err.message);
    const status = err.code === 'NOT_CONNECTED' ? 503 : (err.code === 'NOT_ON_WHATSAPP' ? 400 : 500);
    res.status(status).json({
      ok: false,
      error: err.message,
      code: err.code || 'SEND_FAILED'
    });
  }
});

// Platform health check
app.get('/healthz', (_req, res) => res.json({ ok: true }));

export default app;

const isTest = process.env.NODE_ENV === 'test' || Boolean(process.env.NODE_TEST_CONTEXT) || process.execArgv.includes('--test');

if (!isTest) {
  const restored = await loadState(config.persistPath);
  if (restored && Array.isArray(restored.sentLog)) {
    sentLog = restored.sentLog;
    console.log(`[persist] restored ${sentLog.length} previously messaged contact(s).`);
  }

  initWhatsapp();

  app.listen(PORT, () => console.log(`WhatsApp on-demand outreach service running at http://localhost:${PORT}`));

  const shutdown = (signal) => {
    console.log(`[server] ${signal} received, shutting down...`);
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
