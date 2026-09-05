// Minimal JSON-file persistence for server.js's in-memory job/batch queue.
//
// Why this exists: batches now wait up to BATCH_DELAY_MS (default 45
// minutes) before sending. A plain in-memory queue that gets wiped on every
// restart (Render/Railway redeploy, crash, `npm run dev` file-watch reload)
// would silently drop hours of pending outreach. This module is deliberately
// the simplest thing that fixes that — a single JSON file, not a database —
// matching this project's existing "no extra infra" style (see
// groqRateLimiter.js's in-memory sliding window for the same philosophy).
//
// This is NOT meant to survive concurrent writers. It assumes exactly one
// server.js process owns the file. If you outgrow that (multiple
// instances, need for real transactions), that's the point at which to
// switch to SQLite, per the size of the deployment rather than pre-building
// it now.

import { promises as fs } from 'fs';
import path from 'path';

// Loads persisted state from `filePath`. Returns null (not an empty object)
// if there's nothing to load yet — the very first run, or the file was
// deleted — so callers can tell "nothing to restore" apart from "restore an
// empty queue", which matters for deciding whether to run the
// immediately-on-startup overdue check at all.
export async function loadState(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null; // no prior state — first run
    console.error(`[persist] failed to load ${filePath}, starting with an empty queue:`, err.message);
    return null;
  }
}

// Writes state atomically: write to a temp file in the same directory, then
// rename over the target. A rename is atomic on the same filesystem, so a
// crash mid-write can never leave a half-written, unparseable state file —
// worst case, the rename simply hasn't happened yet and the previous good
// file is still there.
export async function saveNow(filePath, state) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(tmpPath, JSON.stringify(state), 'utf8');
  await fs.rename(tmpPath, filePath);
}
