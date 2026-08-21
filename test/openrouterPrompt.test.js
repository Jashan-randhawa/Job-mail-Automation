import test from 'node:test';
import assert from 'node:assert/strict';
import { __promptTest } from '../services/openrouterService.js';

const { buildPrompt, TECH_FACTS, SALES_FACTS } = __promptTest;

test('prompt includes both fact sets and explicit role classification instructions', () => {
  const prompt = buildPrompt('We are hiring a Sales Development Representative.');
  assert.ok(prompt.includes(TECH_FACTS), 'tech facts must still be present');
  assert.ok(prompt.includes(SALES_FACTS), 'sales/business facts must be present');
  assert.ok(prompt.includes('TECHNICAL'), 'must instruct classification into TECHNICAL');
  assert.ok(prompt.includes('SALES_BUSINESS'), 'must instruct classification into SALES_BUSINESS');
  assert.ok(prompt.includes('HYBRID'), 'must instruct classification into HYBRID');
});

test('prompt explicitly forbids falling back to the same tech pitch for non-technical roles', () => {
  const prompt = buildPrompt('We are hiring an Account Executive.');
  assert.ok(
    /must not read like a copy-pasted engineering pitch/i.test(prompt),
    'prompt should explicitly forbid reusing the tech-jargon framing for sales/business roles'
  );
});

test('prompt requires the model to report which category it chose (for observability/debugging)', () => {
  const prompt = buildPrompt('We are hiring a backend engineer.');
  assert.ok(prompt.includes('"roleCategory"'), 'response schema must request the chosen category');
});

test('SALES_FACTS never introduces a company, title, or numeric claim absent from TECH_FACTS', () => {
  // Every company name mentioned in SALES_FACTS must already appear in
  // TECH_FACTS — this is the actual guard against fabricated experience.
  const companyNames = ['Excellence Technologies', 'Infosys ICT Academy'];
  for (const name of companyNames) {
    if (SALES_FACTS.includes(name)) {
      assert.ok(TECH_FACTS.includes(name), `SALES_FACTS mentions "${name}" which must also be real (present in TECH_FACTS)`);
    }
  }
  // Every percentage/number cited in SALES_FACTS must also appear in
  // TECH_FACTS — catches an accidentally-invented metric.
  const numbers = SALES_FACTS.match(/\d+%|\d+\+/g) || [];
  assert.ok(numbers.length > 0, 'sanity: SALES_FACTS should cite at least one real number');
  for (const n of numbers) {
    assert.ok(TECH_FACTS.includes(n), `SALES_FACTS cites "${n}" which does not appear anywhere in TECH_FACTS — looks fabricated`);
  }
});

test('SALES_FACTS does not claim a formal sales job title or dated sales role that does not exist in TECH_FACTS', () => {
  const fabricatedTitleHints = [
    /sales (development )?representative/i,
    /account executive/i,
    /business development (representative|manager)/i,
    /\bSDR\b/,
    /\bBDR\b/,
    /quota/i,
    /closed \$/i,
    /revenue generated/i
  ];
  for (const pattern of fabricatedTitleHints) {
    assert.equal(
      pattern.test(SALES_FACTS),
      false,
      `SALES_FACTS should not claim a formal sales title/metric like ${pattern} unless it's genuinely true and added deliberately`
    );
  }
});
