import test from 'node:test';
import assert from 'node:assert/strict';
import { __queueTest, queueConfig, assertQueueInvariants, runWorker } from '../server.js';

const goodDraft = (n = '') => ({ concept: `concept ${n}`, subject: `Application ${n}`, body: `Hello team, this is a detailed and safe application email body with enough length for validation. Regards.` });

function configure({ draft, send, minInterval = 0, jitter = 0, draftTimeout = 100, sendTimeout = 100, waitTimeout = 1000, processingTimeout = 200, batchSize = 1, batchDelay = 0, orphanTimeout = 24 * 60 * 60_000 } = {}) {
  __queueTest.reset();
  queueConfig.minSendIntervalMs = minInterval;
  queueConfig.jitterMaxMs = jitter;
  queueConfig.draftTimeoutMs = draftTimeout;
  queueConfig.sendTimeoutMs = sendTimeout;
  queueConfig.waitTimeoutMs = waitTimeout;
  queueConfig.jobProcessingTimeoutMs = processingTimeout;
  // Existing tests below are about per-job behavior (drafting, pacing,
  // failure isolation, FIFO order) and predate batching entirely — default
  // to batchSize:1/batchDelay:0 so each job is its own immediately-eligible
  // batch and none of that behavior changes. Batch-specific tests further
  // down override these explicitly.
  queueConfig.batchSize = batchSize;
  queueConfig.batchDelayMs = batchDelay;
  queueConfig.orphanBatchTimeoutMs = orphanTimeout;
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
  // Only the live (still-queued) slice matters for "enqueued only once" -
  // queuedJobIds itself may also hold an already-dequeued dead entry for
  // this same id until the next compaction (see advanceQueueHead).
  assert.equal(__queueTest.liveQueuedIds().filter((queuedId) => queuedId === id).length <= 1, true);
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

test('I: draining past the compaction threshold keeps FIFO order and invariants intact', async () => {
  // queueHead compaction kicks in once it exceeds 64 dead slots (see
  // advanceQueueHead) - this drains well past that so the compaction branch
  // actually runs, not just the fast path.
  const order = [];
  configure({ send: async ({ subject }) => order.push(Number(subject.replace('Application ', ''))) });
  await enqueueMany(150);
  await Promise.all([runWorker(), runWorker(), runWorker()]);
  assert.deepEqual(order, Array.from({ length: 150 }, (_, i) => i + 1));
  assert.deepEqual(assertQueueInvariants({ allowStoppedWorker: true }), []);
  // The dead prefix should have been compacted away at least once, not left
  // to grow unbounded for the life of the process.
  assert.ok(__queueTest.queuedJobIds.length < 150, 'dead prefix should have been compacted, not just left in place');
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

// --- Batching ---

test('J: jobs assemble into fixed-size batches and only the front batch processes at a time', async () => {
  configure({ batchSize: 3, batchDelay: 20 });
  await enqueueMany(7); // 2 full batches of 3 + 1 batch of 1 left assembling
  const batches = Array.from(__queueTest.batches.values());
  assert.equal(batches.length, 3);
  assert.deepEqual(batches.map((b) => b.jobIds.length), [3, 3, 1]);
  assert.deepEqual(batches.map((b) => b.status), ['READY', 'READY', 'ASSEMBLING']);
});

test('K: a batch only sends once its delay has elapsed, not immediately', async () => {
  const sent = [];
  configure({ batchSize: 3, batchDelay: 60, send: async ({ subject }) => sent.push(subject) });
  await enqueueMany(3);
  const soon = runWorker();
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(sent.length, 0, 'must not send before the batch delay elapses');
  await soon;
  assert.equal(sent.length, 3, 'all 3 in the batch should have sent once the delay elapsed');
});

test('L: an orphaned batch (never fills up) is promoted after the orphan timeout instead of waiting forever', async () => {
  const sent = [];
  configure({ batchSize: 3, batchDelay: 0, orphanTimeout: 30, send: async ({ subject }) => sent.push(subject) });
  await enqueueMany(1); // never reaches batchSize
  await new Promise((resolve) => setTimeout(resolve, 45));
  __queueTest.promoteBatches();
  await runWorker();
  assert.equal(sent.length, 1, 'the lone job should still send after the orphan timeout, without 2 more jobs ever arriving');
});

test('M: a batch that empties via retry before it runs is completed immediately, not left blocking the queue', async () => {
  const sent = [];
  configure({ batchSize: 1, batchDelay: 0, send: async ({ subject }) => sent.push(subject) });
  const [id] = await enqueueMany(1);
  const job = __queueTest.jobs.get(id);
  const orphanedBatch = __queueTest.batches.get(job.batchId);
  assert.equal(orphanedBatch.status, 'READY'); // locked (batchSize:1) the instant it was created — regardless of delay, nothing has promoted it yet since runWorker() hasn't run
  job.status = 'draft_failed'; // simulate a failure directly, bypassing pacing, to isolate just the retry-detach behavior
  await fetchRetry(id);
  assert.equal(orphanedBatch.status, 'COMPLETED', 'the emptied batch must not be left dangling once its last job is retried away');
  await runWorker(); // drains the job's NEW batch, created fresh by the retry
  assert.deepEqual(sent, ['Application 1']);
});

test('N: orphan-promoted batch is scheduled immediately, not delayed by batchDelayMs on top of the orphan wait', async () => {
  const sent = [];
  // batchDelay is deliberately huge relative to orphanTimeout: if the old
  // "always add batchDelayMs" behavior were still there, this batch would
  // report a scheduledProcessTime 10s in the future instead of immediate.
  configure({ batchSize: 3, batchDelay: 10_000, orphanTimeout: 30, send: async ({ subject }) => sent.push(subject) });
  const [id] = await enqueueMany(1); // never reaches batchSize
  await new Promise((resolve) => setTimeout(resolve, 45));
  __queueTest.promoteBatches();
  const job = __queueTest.jobs.get(id);
  const batch = __queueTest.batches.get(job.batchId);
  // Scheduled for "now" means the very same promoteBatches() call can carry
  // it straight past READY into PROCESSING (it also promotes the front of
  // pendingBatchIds once due) — either status is fine here, the thing under
  // test is the schedule time, not which of the two it landed on.
  assert.equal(batch.status === 'READY' || batch.status === 'PROCESSING', true, `expected READY or PROCESSING, got ${batch.status}`);
  assert.equal(batch.scheduledProcessTime <= Date.now(), true, 'orphan-promoted batch must be due immediately, not now() + batchDelayMs');
  await runWorker();
  assert.equal(sent.length, 1, 'the lone job should send right away once orphan-promoted, without an extra batchDelayMs wait');
});

test('O: estimateBatchStartOffset for a burst of batches reflects the max due time, not the sum', async () => {
  configure({ batchSize: 1, batchDelay: 500 });
  // Isolate the batch-due-time stacking behavior from the (separately
  // correct) per-job processing-time addition, so this test measures only
  // what it's meant to.
  queueConfig.estimatedDraftSeconds = 0;
  queueConfig.estimatedSendSeconds = 0;
  const [id1] = await enqueueMany(1); // locks its own batch immediately (batchSize:1)
  const [id2] = await enqueueMany(1); // ditto — the two batches lock near-simultaneously, a burst
  const job1 = __queueTest.jobs.get(id1);
  const job2 = __queueTest.jobs.get(id2);
  const offset1 = __queueTest.estimateBatchStartOffset(job1);
  const offset2 = __queueTest.estimateBatchStartOffset(job2);
  assert.equal(Math.abs(offset2 - offset1) < 0.05, true, `offsets should be close (both batches due at ~the same time): offset1=${offset1} offset2=${offset2}`);
  assert.equal(offset2 < 0.9, true, `must not be close to the sum of both batches' delays (~1s): offset2=${offset2}`);
});

test('P: estimateBatchStartOffset reflects a genuine time gap between non-overlapping batches', async () => {
  configure({ batchSize: 1, batchDelay: 100 });
  queueConfig.estimatedDraftSeconds = 0;
  queueConfig.estimatedSendSeconds = 0;
  const [id1] = await enqueueMany(1);
  const [id2] = await enqueueMany(1);
  const job1 = __queueTest.jobs.get(id1);
  const job2 = __queueTest.jobs.get(id2);
  const batch1 = __queueTest.batches.get(job1.batchId);
  // Simulate batch1 genuinely being scheduled much later than batch2 (e.g.
  // arrival was spread out in time, not a burst).
  batch1.scheduledProcessTime = Date.now() + 5000;
  const offset2 = __queueTest.estimateBatchStartOffset(job2);
  assert.equal(offset2 > 4.5, true, `offset2=${offset2} should reflect the large gap ahead of it, not just its own ~0.1s delay`);
});
