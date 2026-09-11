import test from 'node:test';
import assert from 'node:assert/strict';
import { reserveGroqCapacity, estimateTokens, __rateLimiterTest } from '../services/groqRateLimiter.js';

test('estimateTokens is a fast, roughly chars/4 estimate', () => {
  assert.equal(estimateTokens(''), 0);
  assert.equal(estimateTokens('a'.repeat(400)), 100);
});

test('reserveGroqCapacity resolves immediately while under both RPM and TPM budget', async () => {
  __rateLimiterTest.reset();
  const { TPM_LIMIT } = __rateLimiterTest.getLimits();
  const start = Date.now();
  const handle = await reserveGroqCapacity(Math.floor(TPM_LIMIT * 0.1));
  assert.ok(Date.now() - start < 50, 'should not have waited for a small reservation with a fresh window');
  handle.settle(Math.floor(TPM_LIMIT * 0.1));
  const usage = __rateLimiterTest.getUsage();
  assert.equal(usage.requests, 1);
});

test('reserveGroqCapacity blocks once a reservation would exceed the TPM budget, and unblocks once the window frees up', async () => {
  __rateLimiterTest.reset();
  __rateLimiterTest.setWindowMs(150); // short window so this test doesn't wait out a real 60s cycle
  try {
    const { TPM_LIMIT } = __rateLimiterTest.getLimits();
    // Fill most of the budget with one big reservation.
    const first = await reserveGroqCapacity(Math.floor(TPM_LIMIT * 0.8));
    first.settle(Math.floor(TPM_LIMIT * 0.8));

    // A second reservation that would blow the remaining (safety-margined)
    // budget should not resolve instantly — it has to wait for the window.
    let resolved = false;
    const pendingStart = Date.now();
    const pending = reserveGroqCapacity(Math.floor(TPM_LIMIT * 0.5)).then((h) => { resolved = true; return h; });

    await new Promise((r) => setTimeout(r, 30));
    assert.equal(resolved, false, 'second reservation should still be waiting for budget, not granted immediately');

    // With a 150ms window it should resolve well within a couple of window
    // cycles — confirms it actually unblocks, not just that it initially waits.
    const handle = await pending;
    assert.ok(Date.now() - pendingStart >= 100, 'should have genuinely waited for the window to free up, not resolved early');
    handle.settle(Math.floor(TPM_LIMIT * 0.5));
  } finally {
    __rateLimiterTest.resetWindowMs();
  }
});

test('reserveGroqCapacity blocks once RPM is exhausted even with plenty of token budget left', async () => {
  __rateLimiterTest.reset();
  __rateLimiterTest.setWindowMs(150); // short window so this test doesn't wait out a real 60s cycle
  try {
    const { RPM_LIMIT } = __rateLimiterTest.getLimits();
    for (let i = 0; i < RPM_LIMIT; i += 1) {
      const h = await reserveGroqCapacity(1); // trivially small token cost
      h.settle(1);
    }
    const usage = __rateLimiterTest.getUsage();
    assert.equal(usage.requests, RPM_LIMIT);

    let resolved = false;
    const pending = reserveGroqCapacity(1).then((h) => { resolved = true; return h; });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(resolved, false, 'RPM cap should block a further reservation regardless of token budget');

    const handle = await pending;
    handle.settle(1);
  } finally {
    __rateLimiterTest.resetWindowMs();
  }
});

test('settle() reconciles the reservation down to actual usage, freeing budget for the next caller', async () => {
  __rateLimiterTest.reset();
  const { TPM_LIMIT } = __rateLimiterTest.getLimits();
  // Reserve conservatively (as if using max_tokens as the estimate)...
  const handle = await reserveGroqCapacity(Math.floor(TPM_LIMIT * 0.7));
  // ...then reconcile down to what was actually used.
  handle.settle(Math.floor(TPM_LIMIT * 0.1));

  const usage = __rateLimiterTest.getUsage();
  assert.equal(usage.tokens, Math.floor(TPM_LIMIT * 0.1), 'usage should reflect the settled amount, not the original estimate');

  // A second, similarly-sized reservation should now fit comfortably.
  const start = Date.now();
  await reserveGroqCapacity(Math.floor(TPM_LIMIT * 0.1));
  assert.ok(Date.now() - start < 50, 'reconciled budget should let a similarly-sized reservation through immediately');
});
