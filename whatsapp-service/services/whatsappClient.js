// Thin wrapper around Baileys: owns the single socket instance, tracks
// connection status, renders the pairing QR, and exposes direct on-demand
// messaging with resume PDF attachment support.
//
// Swapped from whatsapp-web.js -> Baileys (see whatsapp-service/README.md).
// Same job, same public API (initWhatsapp/getStatus/getQr/sendDirectMessage),
// same on-disk session directory — the only thing that changed is that
// Baileys talks to WhatsApp over a raw WebSocket instead of driving a full
// headless Chromium via Puppeteer, so there's no ~500MB browser process to
// get OOM-killed on Render's free tier during the initial sync.

import fs from 'fs';
import { promises as fsp } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import qrcode from 'qrcode';
import { DEFAULT_GREETING } from './whatsappPolicy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SESSION_DIR = process.env.WHATSAPP_SESSION_DIR || './data/wa-session';
const RESUME_FILENAME = process.env.RESUME_ATTACHMENT_FILENAME || 'Jashanpreet_Singh_Resume.pdf';
const logger = pino({ level: process.env.WHATSAPP_LOG_LEVEL || 'warn' });

let sock = null;
let latestQrString = null;
let latestQrDataUrl = null;
let connectionStatus = 'not_initialized';
let readyAt = null;
let starting = false; // guards against overlapping connect() calls from rapid reconnects

// Watchdog: same reasoning as before the library swap. Baileys normally
// keeps moving — a fresh QR every ~20-40s while pairing, or a 'connecting'
// -> 'open' transition once a session is restored. If that stops entirely
// (a hung socket, a silent stall) the status can get stuck indefinitely with
// no crash for Render's supervisor to recover from. So we track the last
// time *any* progress event fired and self-exit if too much time passes
// with no movement — a clean restart beats a silent hang.
const WATCHDOG_STALL_MS = Number(process.env.WHATSAPP_WATCHDOG_STALL_MS || 3 * 60_000);
const WATCHDOG_CHECK_MS = 30_000;
let lastProgressAt = Date.now();
let watchdogTimer = null;

function markProgress() {
  lastProgressAt = Date.now();
}

function startWatchdog() {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (connectionStatus === 'connected') return; // no need to watch a healthy, ready session
    const stalledFor = Date.now() - lastProgressAt;
    if (stalledFor > WATCHDOG_STALL_MS) {
      console.error(`[whatsapp] watchdog: no progress for ${Math.round(stalledFor / 1000)}s (status: ${connectionStatus}) — exiting so the platform restarts the process cleanly.`);
      process.exit(1);
    }
  }, WATCHDOG_CHECK_MS);
  watchdogTimer.unref?.();
}

export function resolveResumePath(customPath) {
  if (customPath && fs.existsSync(customPath)) return customPath;
  if (process.env.RESUME_PATH && fs.existsSync(process.env.RESUME_PATH)) return process.env.RESUME_PATH;
  const candidate1 = path.resolve(__dirname, '../../resume/resume.pdf');
  if (fs.existsSync(candidate1)) return candidate1;
  const candidate2 = path.resolve(__dirname, '../resume/resume.pdf');
  if (fs.existsSync(candidate2)) return candidate2;
  const candidate3 = path.resolve(process.cwd(), 'resume/resume.pdf');
  if (fs.existsSync(candidate3)) return candidate3;
  return null;
}

async function connect() {
  if (starting) return;
  starting = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);

    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      console.warn('[whatsapp] could not fetch latest WA Web version, using library default:', err.message);
    }

    sock = makeWASocket({
      version,
      auth: state,
      logger,
      syncFullHistory: false, // skip the heavy initial chat/message backfill — that sync was the memory spike that used to OOM Chromium
      markOnlineOnConnect: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      markProgress();

      if (qr) {
        latestQrString = qr;
        connectionStatus = 'qr';
        try {
          latestQrDataUrl = await qrcode.toDataURL(qr);
        } catch (err) {
          console.error('[whatsapp] failed to render QR to a data URL:', err.message);
        }
        console.log('[whatsapp] new QR code ready — scan it via GET /whatsapp/qr.');
      }

      if (connection === 'open') {
        connectionStatus = 'connected';
        readyAt = Date.now();
        latestQrString = null;
        latestQrDataUrl = null;
        console.log('[whatsapp] client ready — session connected.');
      }

      if (connection === 'close') {
        readyAt = null;
        const error = lastDisconnect?.error;
        const statusCode = error instanceof Boom ? error.output?.statusCode : error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;

        if (loggedOut) {
          connectionStatus = 'disconnected';
          console.warn('[whatsapp] disconnected (LOGOUT) — needs re-scan via GET /whatsapp/qr.');
          // Wipe the stale session so the next connect() starts a clean pairing
          // instead of retrying invalid creds forever.
          await fsp.rm(SESSION_DIR, { recursive: true, force: true }).catch(() => {});
        } else {
          connectionStatus = 'reconnecting';
          console.warn(`[whatsapp] connection closed (status ${statusCode || 'unknown'}) — reconnecting...`);
        }
        connect();
      }
    });
  } catch (err) {
    connectionStatus = 'init_failed';
    console.error('[whatsapp] initialize() failed:', err.message);
  } finally {
    starting = false;
  }
}

export function initWhatsapp() {
  if (sock) return sock;
  markProgress();
  startWatchdog();
  connect().catch((err) => {
    connectionStatus = 'init_failed';
    markProgress();
    console.error('[whatsapp] initialize() failed:', err.message);
  });
  return sock;
}

export function getStatus() {
  return {
    status: connectionStatus,
    connected: connectionStatus === 'connected',
    needsRescan: connectionStatus === 'disconnected' || connectionStatus === 'auth_failure',
    readyAt: readyAt ? new Date(readyAt).toISOString() : null
  };
}

export function getQr() {
  return { status: connectionStatus, qrString: latestQrString, qrDataUrl: latestQrDataUrl };
}

async function resolveChatId(phone) {
  const digits = String(phone).replace(/[^\d]/g, '');
  if (!digits) throw new Error('Phone number must contain at least one digit.');
  const results = await sock.onWhatsApp(digits);
  const match = results && results[0];
  if (!match || !match.exists) {
    const err = new Error(`${phone} is not registered on WhatsApp.`);
    err.code = 'NOT_ON_WHATSAPP';
    throw err;
  }
  return match.jid;
}

export async function sendRawMessage(phone, message) {
  if (connectionStatus !== 'connected') {
    const err = new Error(`WhatsApp session is not connected (status: ${connectionStatus}). Re-scan the QR at GET /whatsapp/qr.`);
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const chatId = await resolveChatId(phone);
  return sock.sendMessage(chatId, { text: message });
}

export async function sendDirectMessage({ phone, message, attachResume = true, resumePath = null } = {}) {
  if (connectionStatus !== 'connected') {
    const err = new Error(`WhatsApp session is not connected (status: ${connectionStatus}). Re-scan the QR at GET /whatsapp/qr.`);
    err.code = 'NOT_CONNECTED';
    throw err;
  }
  const text = (message && String(message).trim()) || process.env.WHATSAPP_FIXED_GREETING || DEFAULT_GREETING;
  const chatId = await resolveChatId(phone);

  const messageResult = await sock.sendMessage(chatId, { text });

  let attachmentResult = null;
  if (attachResume) {
    const finalResumePath = resolveResumePath(resumePath);
    if (finalResumePath) {
      attachmentResult = await sock.sendMessage(chatId, {
        document: fs.readFileSync(finalResumePath),
        mimetype: 'application/pdf',
        fileName: RESUME_FILENAME
      });
    } else {
      console.warn('[whatsapp] attachResume was true but resume PDF was not found at resolved paths.');
    }
  }

  return {
    ok: true,
    phone,
    chatId,
    messageId: messageResult?.key?.id || null,
    attachmentSent: Boolean(attachmentResult),
    sentAt: new Date().toISOString()
  };
}

export const __test = {
  setClient(mockClient, status = 'connected') {
    sock = mockClient;
    connectionStatus = status;
    readyAt = Date.now();
  },
  reset() {
    sock = null;
    connectionStatus = 'not_initialized';
    readyAt = null;
    latestQrString = null;
    latestQrDataUrl = null;
  }
};
