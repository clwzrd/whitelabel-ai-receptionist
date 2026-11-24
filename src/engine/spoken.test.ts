import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeSpokenEmail, spellOut } from './spoken.ts';

/*
 * What a transcriber writes down when somebody says their e-mail address,
 * and what the assistant should make of it before reading it back.
 */

test('the plain case: name dot name at gmail dot com', () => {
  assert.equal(normalizeSpokenEmail('maria dot lopez at gmail dot com').address, 'maria.lopez@gmail.com');
  assert.equal(normalizeSpokenEmail('john dot smith at gmail dot com').address, 'john.smith@gmail.com');
});

test('an address the transcriber already wrote with symbols passes through, lower-cased, spaces or not', () => {
  assert.equal(normalizeSpokenEmail('Maria.Lopez@Gmail.com').address, 'maria.lopez@gmail.com');
  assert.equal(normalizeSpokenEmail('JOHN . SMITH @ GMAIL . COM').address, 'john.smith@gmail.com');
});

test('"at sign", "underscore", "dash" and "hyphen" are characters', () => {
  assert.equal(normalizeSpokenEmail('m underscore lopez at sign yahoo dot com').address, 'm_lopez@yahoo.com');
  assert.equal(normalizeSpokenEmail('sales dash team at outlook dot com').address, 'sales-team@outlook.com');
  assert.equal(normalizeSpokenEmail('john at acme hyphen corp dot com').address, 'john@acme-corp.com');
});

test('the sentence around the address is dropped, before and after', () => {
  assert.equal(normalizeSpokenEmail('sure, my e-mail is john at hotmail dot com, thanks').address, 'john@hotmail.com');
  assert.equal(normalizeSpokenEmail("it's carla dot m at gmail dot com. Did you get that?").address, 'carla.m@gmail.com');
  assert.equal(normalizeSpokenEmail('yeah it is bob at acme dot com thank you').address, 'bob@acme.com');
  assert.equal(normalizeSpokenEmail('you can reach me at bob at acme dot com').address, 'bob@acme.com');
});

test('letters said one at a time are glued, and "double l" is two', () => {
  assert.equal(normalizeSpokenEmail('j-o-h-n at gmail.com').address, 'john@gmail.com');
  assert.equal(normalizeSpokenEmail('B O B at acme dot com').address, 'bob@acme.com');
  assert.equal(normalizeSpokenEmail('j o h n underscore 4 2 at yahoo dot com').address, 'john_42@yahoo.com');
  assert.equal(normalizeSpokenEmail('double l ee at icloud dot com').address, 'llee@icloud.com');
});

test('numbers said as words are digits; two names with no "dot" are one word', () => {
  assert.equal(normalizeSpokenEmail('one two three at acme dot com').address, '123@acme.com');
  assert.equal(normalizeSpokenEmail('John Smith at G mail dot com').address, 'johnsmith@gmail.com');
});

test('a domain said without the dot still lands: "gmail com"; two-level TLDs too', () => {
  assert.equal(normalizeSpokenEmail('paulo at gmail com').address, 'paulo@gmail.com');
  assert.equal(normalizeSpokenEmail('john at company dot co dot uk').address, 'john@company.co.uk');
});

test('"g mail" and "gee mail" are gmail', () => {
  assert.equal(normalizeSpokenEmail('ana at g mail dot com').address, 'ana@gmail.com');
  assert.equal(normalizeSpokenEmail('ana at gee mail dot com').address, 'ana@gmail.com');
});

test('nothing address-shaped is null, never a guess', () => {
  assert.equal(normalizeSpokenEmail('I would rather not say').address, null);
  assert.equal(normalizeSpokenEmail('at').address, null);
  assert.equal(normalizeSpokenEmail('john at gmail').address, null);
  assert.equal(normalizeSpokenEmail('my email is john at gmail').address, null);
  assert.equal(normalizeSpokenEmail('hello there').address, null);
  assert.equal(normalizeSpokenEmail('').address, null);
});

test('spellOut names the symbols, reads letters upper-case and a known domain as a word', () => {
  assert.equal(spellOut('ab.c@x.io'), 'A, B, dot, C, at, X, dot, I, O');
  assert.equal(spellOut('m_l-1+t@y.com'), 'M, underscore, L, dash, 1, plus, T, at, Y, dot, C, O, M');
  assert.equal(spellOut('john.smith@gmail.com'), 'J, O, H, N, dot, S, M, I, T, H, at, gmail dot com');
  assert.equal(spellOut('m_lo-pez@acme-corp.com'), 'M, underscore, L, O, dash, P, E, Z, at, A, C, M, E, dash, C, O, R, P, dot, C, O, M');
});

test('the spelling comes back with the address', () => {
  const out = normalizeSpokenEmail('bo at x dot io');
  assert.equal(out.address, 'bo@x.io');
  assert.equal(out.spelled, 'B, O, at, X, dot, I, O');
});
