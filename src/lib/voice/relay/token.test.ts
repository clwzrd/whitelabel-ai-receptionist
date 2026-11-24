import assert from 'node:assert/strict';
import { test } from 'node:test';

process.env.APP_SECRET = process.env.APP_SECRET || 'test-secret-for-relay-tokens';
const { mintRelayToken, verifyRelayToken } = await import('./token.ts');

/*
 * The CRM's own proof on the socket URL: one call, one Twilio sid, two
 * minutes. Every test below is a way the proof could be wrong, and each must
 * be told apart from the others — `bad` is a 403, `expired` a 410.
 */

const CALL = '7d3f3b1a-0c5e-4e0a-9a7b-2c3d4e5f6a7b';
const SID = 'CA0123456789abcdef0123456789abcdef';
const NOW = 1_800_000_000_000;

test('a freshly minted token verifies for the same call and sid', async () => {
  const token = await mintRelayToken(CALL, SID, NOW);
  assert.equal(token.exp, Math.floor(NOW / 1000) + 120);
  assert.match(token.sig, /^[0-9a-f]{64}$/);
  assert.equal(await verifyRelayToken(CALL, SID, token.exp, token.sig, NOW + 60_000), 'ok');
});

test('past its time it is expired, not bad', async () => {
  const token = await mintRelayToken(CALL, SID, NOW, 120);
  assert.equal(await verifyRelayToken(CALL, SID, token.exp, token.sig, NOW + 121_000), 'expired');
  assert.equal(await verifyRelayToken(CALL, SID, token.exp, token.sig, NOW + 119_000), 'ok');
});

test('a token for another call does not verify', async () => {
  const token = await mintRelayToken(CALL, SID, NOW);
  assert.equal(await verifyRelayToken('7d3f3b1a-0c5e-4e0a-9a7b-2c3d4e5f6a7c', SID, token.exp, token.sig, NOW), 'bad');
});

test('a token for another Twilio sid does not verify — replay is closed', async () => {
  const token = await mintRelayToken(CALL, SID, NOW);
  assert.equal(await verifyRelayToken(CALL, 'CAffffffffffffffffffffffffffffffff', token.exp, token.sig, NOW), 'bad');
});

test('a tampered signature, or a stretched expiry, is bad', async () => {
  const token = await mintRelayToken(CALL, SID, NOW);
  const flipped = (token.sig[0] === 'a' ? 'b' : 'a') + token.sig.slice(1);
  assert.equal(await verifyRelayToken(CALL, SID, token.exp, flipped, NOW), 'bad');
  assert.equal(await verifyRelayToken(CALL, SID, token.exp + 3600, token.sig, NOW), 'bad');
  assert.equal(await verifyRelayToken(CALL, SID, token.exp, 'not-hex', NOW), 'bad');
  assert.equal(await verifyRelayToken(CALL, SID, Number.NaN, token.sig, NOW), 'bad');
  assert.equal(await verifyRelayToken('', SID, token.exp, token.sig, NOW), 'bad');
});

test('a different APP_SECRET produces a different key', async () => {
  const token = await mintRelayToken(CALL, SID, NOW);
  const original = process.env.APP_SECRET;
  process.env.APP_SECRET = 'another-secret-entirely';
  try {
    assert.equal(await verifyRelayToken(CALL, SID, token.exp, token.sig, NOW), 'bad');
    const other = await mintRelayToken(CALL, SID, NOW);
    assert.notEqual(other.sig, token.sig);
  } finally {
    process.env.APP_SECRET = original;
  }
  assert.equal(await verifyRelayToken(CALL, SID, token.exp, token.sig, NOW), 'ok');
});
