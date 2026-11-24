import { requireEnv } from '../../env';

/**
 * The CRM's own signature on the WebSocket URL Twilio dials.
 *
 * Twilio signs the handshake with the account's auth token, and that check
 * runs too (`admit.ts`), but a second, independent proof costs one HMAC and
 * closes a door the first one leaves ajar: anyone who can read a workspace's
 * auth token — a leaked console, a shared laptop — could otherwise open a
 * socket to any call in that workspace. This token is minted by the same
 * request that wrote the `<Connect>` TwiML, for one call, for one Twilio call
 * sid, for two minutes. Nothing about it is stored: the verifier recomputes
 * it from the same three facts and compares.
 *
 * Binding the call sid matters more than it looks. The call id alone is on
 * the row before Twilio has dialled anything, so a token over the id would
 * verify for a replayed connection long after the real one ended; the sid is
 * the one value only the live call carries. The key is derived from
 * `APP_SECRET` under its own label so it can never coincide with the AES key
 * `crypto.ts` derives from the same secret.
 */

const enc = new TextEncoder();
const TTL_SECONDS = 120;

/** One key per secret, so a test that swaps `APP_SECRET` gets a fresh one. */
const keys = new Map<string, Promise<CryptoKey>>();

function relayKey(): Promise<CryptoKey> {
  const secret = requireEnv('APP_SECRET');
  let pending = keys.get(secret);
  if (!pending) {
    pending = crypto.subtle
      .digest('SHA-256', enc.encode(`relay-token|${secret}`))
      .then((raw) => crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']));
    keys.set(secret, pending);
  }
  return pending;
}

async function signature(callId: string, callSid: string, exp: number): Promise<string> {
  const mac = await crypto.subtle.sign('HMAC', await relayKey(), enc.encode(`relay|${callId}|${callSid}|${exp}`));
  return Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Length-safe, the same loop `twilio/signature.ts` uses, so a wrong token leaks nothing through timing. */
function equal(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface RelayToken {
  /** Seconds since the epoch, whole. */
  exp: number;
  /** Lower-case hex of the HMAC. */
  sig: string;
}

/**
 * A token for this call and this Twilio sid. Two minutes is generous for the
 * gap between the TwiML answer and Twilio opening the socket (measured in
 * hundreds of milliseconds) and short enough that a captured URL is worthless
 * by the time anyone could read it.
 */
export async function mintRelayToken(callId: string, callSid: string, nowMs = Date.now(), ttlSec = TTL_SECONDS): Promise<RelayToken> {
  const exp = Math.floor(nowMs / 1000) + ttlSec;
  return { exp, sig: await signature(callId, callSid, exp) };
}

/**
 * `bad` is anything that was not minted for exactly this call and sid;
 * `expired` is a genuine token past its time. The two are told apart so the
 * route can answer 403 to a forgery and 410 to a slow retry — the second is
 * worth seeing in the logs as its own thing, because it says Twilio took
 * longer than two minutes to connect, which is a Twilio-side incident.
 */
export async function verifyRelayToken(
  callId: string,
  callSid: string,
  exp: number,
  sig: string,
  nowMs = Date.now(),
): Promise<'ok' | 'expired' | 'bad'> {
  if (!callId || !callSid || !Number.isInteger(exp) || exp <= 0) return 'bad';
  if (!/^[0-9a-f]{64}$/.test(sig)) return 'bad';
  if (!equal(await signature(callId, callSid, exp), sig)) return 'bad';
  if (exp * 1000 < nowMs) return 'expired';
  return 'ok';
}
