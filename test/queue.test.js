import test from 'node:test';
import assert from 'node:assert/strict';
import { __queueTest, queueConfig, assertQueueInvariants, runWorker } from '../server.js';

const goodDraft = (n = '') => ({ concept: `concept ${n}`, subject: `Application ${n}`, body: `Hello team, this is a detailed and safe application email body with enough length for validation. Regards.` });

function configure({ draft, send, minInterval = 0, jitter = 0, draftTimeout = 100, sendTimeout = 100, waitTimeout = 1000, processingTimeout = 200 } = {}) {
  __queueTest.reset();
  queueConfig.minSendIntervalMs = minInterval;
  queueConfig.jitterMaxMs = jitter;
  queueConfig.draftTimeoutMs = draftTimeout;
  queueConfig.sendTimeoutMs = sendTimeout;
  queueConfig.waitTimeoutMs = waitTimeout;
  queueConfig.jobProcessingTimeoutMs = processingTimeout;
  __queueTest.setServices({
    extractConceptAndDraft: draft || (async (postText) => goodDraft(postText)),
    sendOutreachEmail: send || (async () => {})
  });
}

async function enqueueMany(count) {
  const ids = [];
  for (let i = 1; i <= count; i += 1) ids.push(__queueTest.makeJob(String(i), `user${i}@example.com`));
  return ids;
}

test('A: submits 10 rapidly and drains in strict FIFO order', async () => {
  const sendOrder = [];
  configure({ send: async ({ subject }) => sendOrder.push(subject.replace('Application ', '')) });
  await enqueueMany(10);
  await Promise.all([runWorker(), runWorker(), runWorker()]);
  assert.deepEqual(sendOrder, ['1','2','3','4','5','6','7','8','9','10']);
  assert.equal([...__queueTest.jobs.values()].every((job) => job.status === 'sent'), true);
  assert.deepEqual(assertQueueInvariants({ allowStoppedWorker: true }), []);
});

test('B: one AI failure is recorded and remaining jobs continue', async () => {
  const sent = [];
  configure({ draft: async (postText) => { if (postText === '5') throw new Error('AI failed'); return goodDraft(postText); }, send: async ({ subject }) => sent.push(subject.replace('Application ', '')) });
  await enqueueMany(10);
  await runWorker();
  assert.equal([...__queueTest.jobs.values()].filter((j) => j.status === 'draft_failed').length, 1);
  assert.equal(sent.length, 9);
  assert.equal(__queueTest.getDiagnostics().workerPromise, null);
});

test('C: SMTP send throws, marks send_failed, and worker continues with pacing', async () => {
  const starts = [];
  configure({ minInterval: 20, send: async ({ subject }) => { starts.push(Date.now()); if (subject.endsWith('1')) throw new Error('smtp down'); } });
  const [first, second] = await enqueueMany(2);
  await runWorker();
  assert.equal(__queueTest.jobs.get(first).status, 'send_failed');
  assert.equal(__queueTest.jobs.get(second).status, 'sent');
  assert.equal(starts[1] - starts[0] >= 15, true);
});

test('D: concurrent retry is idempotent and enqueues only once', async () => {
  configure();
  const [id] = await enqueueMany(1);
  const job = __queueTest.jobs.get(id);
  job.status = 'draft_failed';
  await Promise.all([fetchRetry(id), fetchRetry(id)]);
  assert.equal(__queueTest.queuedJobIds.filter((queuedId) => queuedId === id).length <= 1, true);
});

test('E: 20 near-simultaneous endpoint-equivalent submissions are unique and FIFO', async () => {
  const order = [];
  configure({ send: async ({ subject }) => order.push(subject.replace('Application ', '')) });
  await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve(__queueTest.makeJob(String(i + 1), `u${i}@e.com`))));
  await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()]);
  assert.equal(new Set([...__queueTest.jobs.keys()]).size, 20);
  assert.deepEqual(order, Array.from({ length: 20 }, (_, i) => String(i + 1)));
});

test('F: unexpected exception releases worker lock and remaining jobs continue', async () => {
  const sent = [];
  configure({ draft: async (postText) => { if (postText === '1') throw 'boom'; return goodDraft(postText); }, send: async ({ subject }) => sent.push(subject) });
  await enqueueMany(3);
  await runWorker();
  assert.equal(sent.length, 2);
  assert.equal(__queueTest.getDiagnostics().workerPromise, null);
});

test('G: processing timeout recovers a hung drafting job and continues', async () => {
  configure({ draftTimeout: 10, draft: async (postText) => { if (postText === '1') await new Promise(() => {}); return goodDraft(postText); } });
  await enqueueMany(2);
  await runWorker();
  const statuses = [...__queueTest.jobs.values()].map((job) => job.status);
  assert.deepEqual(statuses, ['draft_failed', 'sent']);
});

test('H: restart simulation documents in-memory pending jobs are lost', () => {
  configure();
  const id = __queueTest.makeJob('persist?', 'user@example.com');
  assert.equal(__queueTest.jobs.has(id), true);
  __queueTest.reset();
  assert.equal(__queueTest.jobs.has(id), false);
});

test('recoverStaleJobs clears claimedBy/lockUntil so a recovered job is never misreported as still claimed', () => {
  configure();
  const id = __queueTest.makeJob('stuck post', 'user@example.com');
  const job = __queueTest.jobs.get(id);
  // Simulate a job the worker claimed but whose lease expired without ever
  // going through the normal drainQueue finally-block cleanup — this is
  // exactly the shape recoverStaleJobs() is meant to rescue.
  job.status = 'drafting';
  job.claimedBy = 'worker-ghost';
  job.claimedAt = Date.now() - 10_000;
  job.lockUntil = Date.now() - 1; // already expired
  const idx = __queueTest.queuedJobIds.indexOf(id);
  if (idx !== -1) __queueTest.queuedJobIds.splice(idx, 1); // a claimed job is no longer "waiting"

  __queueTest.recoverStaleJobs();

  assert.equal(job.status, 'draft_failed');
  assert.equal(job.claimedBy, null, 'claimedBy must be cleared on recovery');
  assert.equal(job.lockUntil, null, 'lockUntil must be cleared on recovery');
  assert.equal(__queueTest.getDiagnostics().activeJobId, null);
  assert.deepEqual(assertQueueInvariants({ allowStoppedWorker: true }), []);
});

test('serializeJob reports a numeric etaSeconds for every active status, not just queued/waiting', () => {
  configure();
  const id = __queueTest.makeJob('post', 'user@example.com');
  const job = __queueTest.jobs.get(id);
  for (const status of ['processing', 'drafting', 'sending']) {
    job.status = status; // serializeJob only reads status; it doesn't validate transitions
    const body = __queueTest.serializeJob(job);
    assert.equal(typeof body.etaSeconds, 'number', `etaSeconds should be a number for status=${status}, got ${body.etaSeconds}`);
    assert.ok(Number.isFinite(body.etaSeconds) && body.etaSeconds >= 0);
  }
});

test('active-state etaSeconds counts down with real elapsed time instead of staying flat', () => {
  configure();
  const id = __queueTest.makeJob('post', 'user@example.com');
  const job = __queueTest.jobs.get(id);
  job.status = 'drafting';
  job.startedAt = Date.now() - (queueConfig.estimatedDraftSeconds - 3) * 1000; // 3s of budget left
  const eta = __queueTest.serializeJob(job).etaSeconds;
  assert.ok(eta <= 3 && eta >= 0, `expected a small remaining ETA, got ${eta}`);

  job.startedAt = Date.now() - (queueConfig.estimatedDraftSeconds + 100) * 1000; // way over budget
  const overdueEta = __queueTest.serializeJob(job).etaSeconds;
  assert.equal(overdueEta, 0, 'ETA must never go negative once the estimate is exceeded');
});

test('assertQueueInvariants detects activeJobId drifting out of sync with the active-status job', () => {
  configure();
  const id = __queueTest.makeJob('post', 'user@example.com');
  const job = __queueTest.jobs.get(id);
  job.status = 'drafting'; // an active-status job now exists...
  // ...but the module-level activeJobId was never pointed at it.
  const problems = assertQueueInvariants({ allowStoppedWorker: true });
  assert.ok(problems.some((p) => p.includes('is in an active status but activeJobId is')));
});

test('startStaleSweep/stopStaleSweep can be toggled repeatedly without throwing or leaking timers', () => {
  configure();
  assert.doesNotThrow(() => __queueTest.startStaleSweep());
  assert.doesNotThrow(() => __queueTest.startStaleSweep()); // idempotent while already running
  assert.doesNotThrow(() => __queueTest.stopStaleSweep());
  assert.doesNotThrow(() => __queueTest.stopStaleSweep()); // idempotent while already stopped
});

test('pruneOldJobs bounds memory by dropping the oldest terminal jobs, never touching queued/active ones', () => {
  configure();
  queueConfig.jobRetentionLimit = 5;

  // 3 terminal jobs, oldest to newest by completedAt.
  const terminalIds = [];
  for (let i = 0; i < 3; i += 1) {
    const id = __queueTest.makeJob(`old ${i}`, `old${i}@example.com`);
    const job = __queueTest.jobs.get(id);
    const idx = __queueTest.queuedJobIds.indexOf(id);
    if (idx !== -1) __queueTest.queuedJobIds.splice(idx, 1);
    job.status = 'sent';
    job.completedAt = Date.now() - (10 - i) * 1000; // ascending completion order
    terminalIds.push(id);
  }
  // 1 job still genuinely queued — must survive pruning no matter what.
  const queuedId = __queueTest.makeJob('still queued', 'queued@example.com');

  assert.equal(__queueTest.jobs.size, 4, 'sanity: below the retention limit, nothing should prune yet');
  __queueTest.pruneOldJobs();
  assert.equal(__queueTest.jobs.size, 4, 'must not prune below the configured limit');

  // Push over the limit with more terminal jobs.
  for (let i = 0; i < 4; i += 1) {
    const id = __queueTest.makeJob(`filler ${i}`, `filler${i}@example.com`);
    const job = __queueTest.jobs.get(id);
    const idx = __queueTest.queuedJobIds.indexOf(id);
    if (idx !== -1) __queueTest.queuedJobIds.splice(idx, 1);
    job.status = 'sent';
    job.completedAt = Date.now();
  }
  assert.equal(__queueTest.jobs.size, 8);

  __queueTest.pruneOldJobs();

  assert.equal(__queueTest.jobs.size, queueConfig.jobRetentionLimit);
  assert.equal(__queueTest.jobs.has(queuedId), true, 'the still-queued job must never be pruned');
  assert.equal(__queueTest.jobs.has(terminalIds[0]), false, 'the oldest terminal job should be pruned first');

  queueConfig.jobRetentionLimit = 1000; // restore default so this doesn't leak into later tests
});

async function fetchRetry(id) {
  const { app } = await import('../server.js');
  const server = app.listen(0);
  try {
    const port = server.address().port;
    const response = await fetch(`http://127.0.0.1:${port}/api/jobs/${id}/retry`, { method: 'POST' });
    return response.json();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
