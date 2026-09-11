// Minimal JSON-file persistence for this service's daily-cap counter and
// send-pacing timestamp. Mirrors the main app's persistence/store.js — same
// "simplest thing that works, one process owns the file" philosophy. What's
// actually precious here isn't the in-flight queue (a restart re-sending a
// still-queued message is harmless and expected), it's the daily counter:
// losing it on every redeploy would let the daily cap be silently bypassed
// by restarting the process, defeating the whole point of Phase 9's safety
// caps.

import { promises as fs } from 'fs';
import path from 'path';

export async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null; // first run — nothing to restore
    console.error(`[persist] failed to load ${filePath}, starting fresh:`, err.message);
    return null;
  }
}

export async function saveNow(filePath, state) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state), 'utf8');
  await fs.rename(tmpPath, filePath);
}
