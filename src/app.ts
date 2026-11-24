import type { AiProvider } from './ai/provider';
import type { Config } from './config';
import type { CrmPort } from './crm/port';
import { RelaySession, type SessionTuning } from './engine/session';
import { mintRelayToken, verifyRelayToken } from './engine/token';
import { SESSION_TIMING, type HandoffData, type InMessage, type OutMessage, type RelaySink, type SessionDeps } from './engine/types';
import { WORKSPACE, type ServiceStore } from './store/store';
import { switchableLanguages, voiceForLanguage, type Call } from './support';
import { createTurn } from './turn';
import { connectRelay, dial, hangup, isWithheld, say, twiml, verifyTwilioSignature } from './twilio';

/**
 * The receptionist as three entry points, with no HTTP server in sight.
 *
 *   1. `voice`  — Twilio rings: answer with TwiML that connects the call to
 *                 this service's socket.
 *   2. `admit`  — Twilio opens that socket: let it in only with this service's
 *                 own token and Twilio's signature, then run the conversation.
 *   3. `done`   — the relay ended: tell Twilio what to do next (transfer,
 *                 reconnect, hang up) and hand the finished call to the CRM.
 *
 * `server.ts` puts these behind `node:http` and `ws`. Keeping them apart from
 * the server is what lets the tests drive a whole call without a port.
 */

/** No platform deadline here, unlike a serverless function: a connection may last as long as the call. */
const NO_DEADLINE_MS = 8 * 60 * 60 * 1000;

export interface TwilioRequest {
  /** The URL as Twilio called it, built from the public address. */
  url: string;
  /** Form parameters of a webhook; empty for a WebSocket handshake. */
  params: Record<string, string>;
  signature: string | null;
}

export type Admission = { ok: true; deps: Omit<SessionDeps, 'sink' | 'deadlineMs'> } | { ok: false; status: 403 | 404 | 410; why: string };

export class Receptionist {
  private readonly finalized = new Set<string>();

  constructor(
    private readonly config: Config,
    private readonly crm: CrmPort,
    private readonly store: ServiceStore,
    /** For tests: a scripted model. */
    private readonly provider?: AiProvider,
  ) {}

  private signed(request: TwilioRequest): boolean {
    if (verifyTwilioSignature(request.signature, [request.url], request.params, this.config.twilio.authToken)) return true;
    return this.config.allowUnsigned;
  }

  async greeting(): Promise<string> {
    const own = this.config.voice.greeting.trim();
    if (own) return own;
    const { name } = await this.crm.business();
    const persona = this.config.voice.persona.trim();
    // The disclosure stays whatever the persona: callers expect to be told, and several US states require it.
    return persona
      ? `Hi, thanks for calling ${name}. This is ${persona}, the AI assistant. How can I help you today?`
      : `Hi, thanks for calling ${name}. I'm the AI assistant here. How can I help you today?`;
  }

  private async relayTwiml(call: Call, opts: { resumed: boolean; lang?: string | null }): Promise<string> {
    const { voice } = this.config;
    const token = await mintRelayToken(call.id, call.providerId);
    const socket = `${this.config.publicUrl.replace(/^http/, 'ws')}/twilio/relay?call=${encodeURIComponent(call.id)}&exp=${token.exp}&sig=${token.sig}`;
    return twiml(connectRelay({
      url: socket,
      action: `${this.config.publicUrl}/twilio/done?call=${encodeURIComponent(call.id)}`,
      welcomeGreeting: opts.resumed ? undefined : await this.greeting(),
      ttsProvider: voice.ttsProvider,
      voice: voice.voice || (voice.ttsProvider === 'ElevenLabs' ? voiceForLanguage(voice, 'en-US') : ''),
      ttsLanguage: opts.lang ?? undefined,
      languages: switchableLanguages(voice).map((code) => ({ code, voice: voiceForLanguage(voice, code) })),
      parameters: { call: call.id },
    }));
  }

  /** 1. An inbound call. */
  async voice(request: TwilioRequest): Promise<{ status: number; body: string }> {
    if (!this.signed(request)) return { status: 403, body: 'Invalid Twilio signature.' };
    const { CallSid, From, To, AccountSid } = request.params;
    if (!CallSid || AccountSid !== this.config.twilio.accountSid) return { status: 403, body: 'Unknown account.' };
    const call = await this.store.createCall({ callSid: CallSid, from: From ?? null, to: To ?? null });
    return { status: 200, body: await this.relayTwiml(call, { resumed: false }) };
  }

  /** 2. The socket Twilio opens for that call. */
  async admit(request: TwilioRequest): Promise<Admission> {
    const url = new URL(request.url);
    const callId = url.searchParams.get('call') ?? '';
    const call = await this.store.callById(callId);
    if (!call) return { ok: false, status: 404, why: 'unknown call' };
    const verdict = await verifyRelayToken(call.id, call.providerId, Number(url.searchParams.get('exp')), url.searchParams.get('sig') ?? '');
    if (verdict === 'expired') return { ok: false, status: 410, why: 'token expired' };
    if (verdict !== 'ok') return { ok: false, status: 403, why: 'bad token' };
    // The token proves this service wrote the URL; the signature proves Twilio is the one dialling it.
    if (!this.signed({ ...request, params: {} })) return { ok: false, status: 403, why: 'bad Twilio signature' };

    const { voice } = this.config;
    const phone = isWithheld(call.fromNumber) ? null : call.fromNumber;
    const transferTo = voice.transferTo.trim() || null;
    return {
      ok: true,
      deps: {
        call,
        creds: { accountSid: this.config.twilio.accountSid },
        settings: { ai: voice },
        teamLang: 'en',
        workspaceId: WORKSPACE,
        turn: createTurn({ crm: this.crm, creds: this.config.ai.creds, phone, persona: voice.persona, transferTo, languages: switchableLanguages(voice), priceIn: this.config.ai.priceIn, priceOut: this.config.ai.priceOut, provider: this.provider }),
        store: this.store,
        limits: { maxTurns: voice.maxTurns, maxMinutes: voice.maxMinutes, ...SESSION_TIMING },
        greeting: await this.greeting(),
        transferTo,
      },
    };
  }

  /** One admitted connection as a session. `sink` is the socket; the caller feeds it what Twilio sends through `receive`. */
  session(admission: Extract<Admission, { ok: true }>, sink: RelaySink, tuning: Partial<SessionTuning> = {}): RelaySession {
    return new RelaySession({ ...admission.deps, sink, deadlineMs: Date.now() + NO_DEADLINE_MS }, tuning);
  }

  /** 3. The relay ended; Twilio asks what to do with the call. */
  async done(request: TwilioRequest): Promise<{ status: number; body: string }> {
    if (!this.signed(request)) return { status: 403, body: 'Invalid Twilio signature.' };
    const call = await this.store.callById(new URL(request.url).searchParams.get('call') ?? '');
    if (!call) return { status: 404, body: 'Unknown call.' };
    const handoff = parseHandoff(request.params.HandoffData);
    const row = await this.store.byCall(WORKSPACE, call.id);

    if (handoff?.reason === 'rotate' && row) return { status: 200, body: await this.relayTwiml(call, { resumed: true, lang: row.state.lang ?? null }) };
    await this.finish(call);
    if (handoff?.reason === 'transfer' && handoff.to) return { status: 200, body: twiml(dial(handoff.to, call.toNumber ?? undefined)) };
    if (handoff?.reason === 'failed' || (!handoff && request.params.SessionStatus === 'failed')) {
      return { status: 200, body: twiml(say('Sorry, we could not take your call right now. Please try again in a few minutes.') + hangup()) };
    }
    return { status: 200, body: twiml(hangup()) };
  }

  /** Hands the finished call to the CRM, once, however many times Twilio asks. */
  async finish(call: Call): Promise<void> {
    if (this.finalized.has(call.id)) return;
    this.finalized.add(call.id);
    const row = await this.store.byCall(WORKSPACE, call.id);
    if (!row) return;
    try {
      await this.crm.recordCall({
        callSid: call.providerId,
        from: call.fromNumber,
        to: call.toNumber,
        callerId: row.state.lookedUp ?? call.contactId,
        startedAt: call.startedAt,
        endedAt: row.endedAt ?? new Date(),
        outcome: row.outcome ?? 'nothing',
        endReason: row.endReason ?? 'caller-hung-up',
        language: row.state.lang ?? null,
        transcript: row.turns.filter((t) => t.role !== 'system' && t.text.trim()).map((t) => ({ role: t.role === 'user' ? 'caller' as const : 'assistant' as const, text: t.text, at: new Date(t.ts) })),
      });
    } catch (error) {
      this.finalized.delete(call.id);
      await this.store.recordError({ where: 'recordCall', error });
    }
  }
}

function parseHandoff(raw: string | undefined): HandoffData | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as HandoffData;
    return parsed && typeof parsed.reason === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/** One message off the wire, as the engine wants it. Anything unreadable becomes an `error` the engine can log. */
export function parseIncoming(data: unknown): InMessage {
  const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data as Buffer[]).toString('utf8') : data instanceof ArrayBuffer ? Buffer.from(data).toString('utf8') : String(data);
  try {
    const parsed = JSON.parse(text) as { type?: unknown };
    if (parsed && typeof parsed === 'object' && typeof parsed.type === 'string') return parsed as InMessage;
    return { type: 'error', description: `unrecognised message: ${text.slice(0, 200)}` };
  } catch {
    return { type: 'error', description: `unparseable message: ${text.slice(0, 200)}` };
  }
}

export type { OutMessage };
