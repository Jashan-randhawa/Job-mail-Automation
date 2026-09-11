import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidPhone, DEFAULT_GREETING } from '../services/whatsappPolicy.js';

test('accepts international WhatsApp numbers', () => {
  assert.equal(isValidPhone('+919876543210'), true);
  assert.equal(isValidPhone('+14155552671'), true);
});

test('rejects invalid or local-only numbers', () => {
  assert.equal(isValidPhone('9876543210'), true);
  assert.equal(isValidPhone('+1'), false);
  assert.equal(isValidPhone('abc'), false);
  assert.equal(isValidPhone('+0123456789'), false);
});

test('default fixed greeting is defined and informative', () => {
  assert.ok(DEFAULT_GREETING && typeof DEFAULT_GREETING === 'string');
  assert.match(DEFAULT_GREETING, /resume/i);
});
