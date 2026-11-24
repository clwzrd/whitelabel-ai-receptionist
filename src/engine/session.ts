import { switchableLanguages, withLang, type Call } from '../support';
import {
  languageName,
  primaryTag,
  type DtmfMessage,
  type EndReason,
  type ErrorMessage,
  type HandoffData,
  type InfoMessage,
  type InMessage,
  type InterruptMessage,
  type PromptMessage,
  type SessionDeps,
  type SessionOutcome,
  type SessionState,
  type SetupMessage,
  type TextMessage,
  type Turn,
  type VoiceTurnResult,
} from './types';

/**
 * One phone conversation with the assistant, as a state machine over Twilio's
 * five message types.
 *
 * This class never sees a socket, a database or a model: it is handed a
 * `sink` to speak through, a `store` to remember with and a `turn` function
 * to think with, and it is driven by `receive()` one message at a time. That
 * is what makes it testable in milliseconds with a scripted model and a fake
 * store — and it is also what keeps the timing rules in one place, because
 * everything that can go wrong on a live call is a matter of timing: the
 * function deadline, the caller's silence, the caller speaking over a reply,
 * the model taking too long, two prompts arriving while one is being
 * answered.
 *
 *   connecting ─setup ok─▶ listening ─prompt─▶ thinking ─▶ speaking ─▶ listening …
 *      │ mismatch                                 │ action end / transfer / voicemail
 *      ▼                                          ▼
 *    ended(failed)                             ending ─fixed sentence + end─▶ ended
 *   listening ─remaining < rotateListenMs─▶ rotating ─"One second, please." + end{rotate}─▶ ended
 *   prompt while remaining < rotateThinkMs ─▶ persist the user turn, rotate (do not think)
 *   listening ─idleAskMs─▶ "Are you still there?" ─idleEndMs─▶ ending(idle)
 *
 * Two rules explain most of the shape. Every user turn is persisted the
 * moment it is final, before the model is asked, so a deadline kill mid-turn
 * loses nothing the caller said and the resumed connection answers it first
 * thing. And every action the model takes — transfer, voicemail, hang up —
 * is spoken as a fixed sentence written here, never as the model's own words,
 * because `converse()` breaks the tool loop on a hand-off and the model never
 * gets to say its last line; the caller must still hear one.
 *
 * The caller hears English until they speak something else. With
 * `language="multi"` in the TwiML the transcriber reports the language of
 * each prompt; the engine notes a change for the model ("[caller spoke in
 * Spanish]") and the model decides, through `switch_language`, whether to
 * follow. Once it has, `state.lang` holds the language, every text sent
 * carries it, the engine's own fixed sentences come from the table for it,
 * and a resumed connection reads it back from the row. Everything the team
 * reads is written under `withLang(teamLang)`, because the model turn files
 * rows the team will look at and this code runs in a socket listener,
 * outside the request's language scope — and it stays English whatever the
 * caller spoke, which is the AI side's rule, not this file's.
 */

/** The sentences the engine speaks itself, in English: the primary language and the fallback for any other. */
export const SENTENCES = {
  filler: 'Sure, one moment.',
  rotate: 'One second, please.',
  transfer: "One moment, I'm connecting you to a person.",
  voicemail: "Okay, I'll take you to the voicemail now.",
  farewell: 'Thanks for calling. Goodbye.',
  wrapUp: 'I have to wrap up now. Thanks for calling, and goodbye.',
  outOfTime: "We're out of time for this call. Thanks for calling, and goodbye.",
  idleAsk: 'Are you still there?',
  idleEnd: "I'll let you go. Thanks for calling, goodbye.",
  apology: 'Sorry, I lost you for a second. Could you repeat that?',
  empty: 'Sorry, could you say that again?',
  /** Spoken when the model switched language and gave no words of its own to say in it. */
  switched: 'Sure. How can I help?',
} as const;

export type Sentences = { [K in keyof typeof SENTENCES]: string };

/**
 * The same sentences in the languages the assistant may switch to, keyed
 * by primary tag. Written here by hand rather than asked of the model: they
 * are spoken at the moments the model is not consulted — a transfer, a
 * rotate, the silence clock — and a caller who has been talking Spanish for
 * three minutes should not hear "one second, please" in English at exactly
 * the moment the line goes quiet. A language with no table here gets the
 * English; the words are still right, only the voice is not.
 */
export const SENTENCES_BY_LANG: Record<string, Sentences> = {
  es: {
    filler: 'Claro, un momento.',
    rotate: 'Un segundo, por favor.',
    transfer: 'Un momento, le comunico con una persona.',
    voicemail: 'De acuerdo, le paso al buzón de voz.',
    farewell: 'Gracias por llamar. Hasta luego.',
    wrapUp: 'Tengo que terminar ahora. Gracias por llamar, y hasta luego.',
    outOfTime: 'Se nos acabó el tiempo para esta llamada. Gracias por llamar, y hasta luego.',
    idleAsk: '¿Sigue ahí?',
    idleEnd: 'Le dejo entonces. Gracias por llamar, hasta luego.',
    apology: 'Perdón, le perdí por un segundo. ¿Podría repetirlo?',
    empty: 'Perdón, ¿podría repetirlo?',
    switched: 'Claro. ¿En qué puedo ayudarle?',
  },
  pt: {
    filler: 'Claro, um momento.',
    rotate: 'Um segundo, por favor.',
    transfer: 'Um momento, vou transferir para uma pessoa.',
    voicemail: 'Certo, vou passar para a caixa de mensagens.',
    farewell: 'Obrigado por ligar. Até logo.',
    wrapUp: 'Preciso encerrar agora. Obrigado por ligar, e até logo.',
    outOfTime: 'Nosso tempo para esta ligação acabou. Obrigado por ligar, e até logo.',
    idleAsk: 'Ainda está aí?',
    idleEnd: 'Vou deixar você ir. Obrigado por ligar, até logo.',
    apology: 'Desculpe, perdi você por um segundo. Pode repetir?',
    empty: 'Desculpe, pode repetir?',
    switched: 'Claro. Como posso ajudar?',
  },
  fr: {
    filler: 'Bien sûr, un instant.',
    rotate: 'Une seconde, s’il vous plaît.',
    transfer: 'Un instant, je vous mets en relation avec une personne.',
    voicemail: 'D’accord, je vous passe la messagerie.',
    farewell: 'Merci d’avoir appelé. Au revoir.',
    wrapUp: 'Je dois terminer maintenant. Merci d’avoir appelé, et au revoir.',
    outOfTime: 'Nous n’avons plus de temps pour cet appel. Merci d’avoir appelé, et au revoir.',
    idleAsk: 'Vous êtes toujours là ?',
    idleEnd: 'Je vous laisse. Merci d’avoir appelé, au revoir.',
    apology: 'Pardon, je vous ai perdu un instant. Pouvez-vous répéter ?',
    empty: 'Pardon, pouvez-vous répéter ?',
    switched: 'Bien sûr. Comment puis-je vous aider ?',
  },
  de: {
    filler: 'Gern, einen Moment.',
    rotate: 'Eine Sekunde, bitte.',
    transfer: 'Einen Moment, ich verbinde Sie mit einer Person.',
    voicemail: 'In Ordnung, ich leite Sie zur Mailbox weiter.',
    farewell: 'Danke für Ihren Anruf. Auf Wiederhören.',
    wrapUp: 'Ich muss jetzt zum Ende kommen. Danke für Ihren Anruf, und auf Wiederhören.',
    outOfTime: 'Unsere Zeit für dieses Gespräch ist um. Danke für Ihren Anruf, und auf Wiederhören.',
    idleAsk: 'Sind Sie noch da?',
    idleEnd: 'Dann lasse ich Sie gehen. Danke für Ihren Anruf, auf Wiederhören.',
    apology: 'Entschuldigung, ich habe Sie kurz verloren. Könnten Sie das wiederholen?',
    empty: 'Entschuldigung, könnten Sie das wiederholen?',
    switched: 'Gern. Wie kann ich helfen?',
  },
  it: {
    filler: 'Certo, un momento.',
    rotate: 'Un secondo, per favore.',
    transfer: 'Un momento, la metto in contatto con una persona.',
    voicemail: 'Va bene, la passo alla segreteria.',
    farewell: 'Grazie per aver chiamato. Arrivederci.',
    wrapUp: 'Devo concludere adesso. Grazie per aver chiamato, e arrivederci.',
    outOfTime: 'Il tempo per questa chiamata è finito. Grazie per aver chiamato, e arrivederci.',
    idleAsk: 'È ancora in linea?',
    idleEnd: 'La lascio andare. Grazie per aver chiamato, arrivederci.',
    apology: 'Mi scusi, l’ho persa per un secondo. Può ripetere?',
    empty: 'Mi scusi, può ripetere?',
    switched: 'Certo. Come posso aiutarla?',
  },
};

/** The engine's sentences for a language code, English for null and for anything not in the table. */
export function sentencesFor(lang: string | null | undefined): Sentences {
  return SENTENCES_BY_LANG[primaryTag(lang)] ?? SENTENCES;
}

/** The text-message `lang` for the session's language: English is the TwiML's primary, spelled out so a resume cannot lose it. */
export function ttsLangOf(lang: string | null | undefined): string {
  return lang && primaryTag(lang) !== 'en' ? lang : 'en-US';
}

/** Twilio error codes after which the session is over whatever we do (the docs' "Ends session: Yes", connection class). */
export const FATAL_RELAY_CODES = new Set([64101, 64102, 64106, 64109, 64110]);

/**
 * The documented error message carries only `description`; when Twilio names
 * the code it is inside that text ("64110: …", "error 64105"), so it is read
 * from there. A message with no five-digit 64xxx code in it is noise, not the
 * end of the session.
 */
export function relayErrorCode(m: ErrorMessage): number | null {
  if (typeof m.code === 'number' && Number.isFinite(m.code)) return m.code;
  const match = /\b(64\d{3})\b/.exec(m.description ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * The small numbers that are about physics rather than policy: how long a
 * sentence takes to say, how long to wait for the model before filling the
 * silence. Overridable so the tests run in milliseconds; the policy numbers
 * (idle, rotate, caps) come from `SessionLimits` and are not repeated here.
 */
export interface SessionTuning {
  /** Silence after the caller stops before "Sure, one moment." */
  fillerMs: number;
  /** Keypad digits pressed within this window are one entry. */
  dtmfBufferMs: number;
  /** Rough TTS pace, used to guess when a reply has finished playing. */
  speakMsPerChar: number;
  speakMinMs: number;
  speakMaxMs: number;
  /** How long a rotate waits for a reply in progress to finish before cutting in. */
  rotateWaitMs: number;
}

const DEFAULT_TUNING: SessionTuning = {
  fillerMs: 1800,
  dtmfBufferMs: 1500,
  speakMsPerChar: 60,
  speakMinMs: 400,
  speakMaxMs: 15_000,
  rotateWaitMs: 3000,
};

type Phase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'rotating' | 'ending' | 'ended';

const TOOL_TEXT_MAX = 400;

export class RelaySession {
  /** Resolves once the session has sent its `end` (or failed); the socket waits on it, then flushes. */
  readonly finished: Promise<void>;

  private resolveFinished!: () => void;
  private readonly tuning: SessionTuning;
  private readonly now: () => number;
  private call: Call;

  private phase: Phase = 'connecting';
  private opened = false;
  private turns: Turn[] = [];
  private state: SessionState = { transferAttempts: 0 };
  private rotateCount = 0;
  private sessionId: string | undefined;
  private replies = 0;
  private startMs = 0;
  private costCents = 0;
  private booked = false;
  private tookMessage = false;

  private pending = false;
  private working = false;
  private preemptNext = false;
  /**
   * What is playing right now, for the interrupt handler: a `reply` is a
   * persisted assistant turn that must be cut to what was heard; a `filler`
   * is noise the transcript never had; an `aside` ("Are you still there?",
   * the `*` repeat) was spoken without a turn, so an interrupt over it must
   * not rewrite the last real reply.
   */
  private lastSpoken: 'filler' | 'reply' | 'aside' | null = null;
  private lastAssistantText = '';
  private speakingUntil = 0;
  private endReason: EndReason | null = null;
  private dtmfBuffer = '';
  /** Resolved by a `tokens-played` report for the sentence being spoken, so `endWith` need not wait out the guess. */
  private playedResolve: (() => void) | null = null;
  /** The assistant ran `cancel_appointment` / `reschedule_appointment` and the tool said it did it. */
  private canceled = false;
  private rescheduled = false;
  /**
   * The last language the transcriber reported that the model was told
   * about, so a caller who keeps talking Spanish while the model has not
   * switched yet is noted once, not on every sentence. Cleared on a switch,
   * so a third language, or the same one again later, is noted afresh.
   */
  private notedHint: string | null = null;

  private chain: Promise<void> = Promise.resolve();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private dtmfTimer: ReturnType<typeof setTimeout> | null = null;
  private fillerTimer: ReturnType<typeof setTimeout> | null = null;
  private listenTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: SessionDeps,
    tuning: Partial<SessionTuning> = {},
  ) {
    this.tuning = { ...DEFAULT_TUNING, ...tuning };
    this.now = deps.nowMs ?? (() => Date.now());
    this.call = deps.call;
    this.finished = new Promise<void>((resolve) => {
      this.resolveFinished = resolve;
    });
    /*
     * Armed before the first message: the deadline is a property of this
     * invocation, not of the conversation, and a socket that sits in
     * `connecting` until the function dies would take the call down with it.
     */
    this.after(Math.max(0, deps.deadlineMs - deps.limits.rotateListenMs - this.now()), () => void this.rotate());
  }

  /* ---------------------------------------------------------------------- */
  /*  Inbound                                                                */
  /* ---------------------------------------------------------------------- */

  /**
   * Messages are handled strictly in order — a prompt must not be looked at
   * before the setup that names the call has been checked — so each one is
   * queued behind the last. The model call itself runs off this chain (see
   * `work`), which is what lets an interrupt or a second prompt be seen while
   * the model is still thinking.
   */
  receive(message: InMessage): Promise<void> {
    this.chain = this.chain
      .then(() => withLang(this.deps.teamLang, () => this.handle(message)))
      .catch((error) => this.report(error));
    return this.chain;
  }

  /** The transport broke. Nothing can be said any more; the row records it and the session is over. */
  fail(error: unknown): void {
    void this.report(error);
    if (this.endReason) return;
    this.endReason = 'failed';
    this.phase = 'ended';
    this.clearTimers();
    void this.persistEnd({ reason: 'failed', why: String(error instanceof Error ? error.message : error).slice(0, 200) }).finally(() =>
      this.resolveFinished(),
    );
  }

  /**
   * Called once the socket is closed. A session that ended on its own has
   * already written its row and this is a no-op — which is what makes a
   * rotate safe: the old invocation's flush, running after the resumed
   * connection has opened the row again, writes nothing. A socket that
   * closed without our `end` means the caller hung up.
   */
  async flush(): Promise<void> {
    await this.chain.catch(() => undefined);
    if (this.endReason) return;
    this.endReason = 'caller-hung-up';
    this.phase = 'ended';
    this.clearTimers();
    /*
     * A socket that closes inside the rotate window is far more likely the
     * platform tearing the invocation down at its deadline than the caller
     * hanging up at that exact moment. Marking the row ended here would make
     * `relay-done` refuse the 64105 resume that follows and send a caller who
     * is mid-sentence to the voicemail; the row is left live instead, and if
     * it really was a hang-up the action webhook or the status callback
     * closes it a moment later.
     */
    const inRotateWindow = this.remaining() <= this.deps.limits.rotateListenMs;
    if (this.opened && !inRotateWindow) await this.persistEnd({ reason: 'caller-hung-up' });
    this.resolveFinished();
  }

  private async handle(message: InMessage): Promise<void> {
    if (this.endReason) return;
    switch (message.type) {
      case 'setup':
        return this.onSetup(message);
      case 'prompt':
        return this.onPrompt(message);
      case 'interrupt':
        return this.onInterrupt(message);
      case 'dtmf':
        return this.onDtmf(message);
      case 'error':
        return this.onError(message);
      case 'info':
        return this.onInfo(message);
      default:
        return;
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Setup                                                                  */
  /* ---------------------------------------------------------------------- */

  private async onSetup(m: SetupMessage): Promise<void> {
    if (this.phase !== 'connecting') return;
    const { call, creds, store, workspaceId } = this.deps;
    /*
     * The token and Twilio's signature let the socket in; this is the third
     * check, on what Twilio says about itself once connected. The custom
     * parameters are unsigned (they are the TwiML's own `<Parameter>`s read
     * back), so they are compared against the row rather than believed.
     */
    const ok = m.callSid === call.providerId && m.accountSid === creds.accountSid && m.customParameters?.call === call.id;
    if (!ok) {
      await this.abort('setup mismatch', new Error(`setup mismatch: callSid=${m.callSid} accountSid=${m.accountSid} call=${m.customParameters?.call ?? '-'}`));
      return;
    }

    try {
      this.call = await store.markAnswered(call);
    } catch (error) {
      await this.report(error);
    }
    /*
     * No row, no conversation. A session left in `connecting` would play the
     * greeting and then ignore every prompt until the rotate timer fired
     * minutes later — minutes of ConversationRelay billed for a dead line —
     * so a store that cannot open the row ends the session at once and
     * `relay-done` takes the caller to the voicemail.
     */
    let row;
    try {
      row = await store.open(workspaceId, call.id);
    } catch (error) {
      await this.abort('session store unavailable', error);
      return;
    }
    this.opened = true;
    this.turns = [...row.turns];
    this.state = { ...row.state, transferAttempts: row.state.transferAttempts ?? 0 };
    this.rotateCount = row.rotateCount;
    this.sessionId = row.id;
    // The greeting is the first turn and not a model reply; every other assistant turn was one.
    this.replies = this.turns.filter((t, i) => t.role === 'assistant' && i > 0).length;
    this.startMs = this.call.answeredAt?.getTime() ?? this.now();

    // Total time across every reconnection, counted from the moment the assistant picked up.
    const untilCap = this.startMs + this.deps.limits.maxMinutes * 60_000 - this.now();
    this.after(Math.max(0, untilCap), () => void this.endWith('max-minutes', this.sentences().outOfTime));

    if (this.turns.length === 0 && this.deps.greeting) {
      // Twilio is speaking the greeting right now (`welcomeGreeting`); the transcript should say so.
      const greeting: Turn = { role: 'assistant', text: this.deps.greeting, ts: this.now() };
      this.turns.push(greeting);
      await store.append(workspaceId, call.id, [greeting]);
      this.lastAssistantText = this.deps.greeting;
      this.lastSpoken = 'reply';
      this.spokeFor(this.deps.greeting);
      return;
    }

    this.phase = 'listening';
    const last = this.turns[this.turns.length - 1];
    if (last && (last.role === 'user' || (last.role === 'assistant' && last.unspoken))) {
      // A resume after a kill or a rotate mid-turn: the caller is still waiting for this answer.
      this.pending = true;
      void this.work();
      return;
    }
    this.armIdle();
  }

  /**
   * The session cannot go on and Twilio must be told so, not left to notice
   * the socket closing: `end{failed}` makes `relay-done` send the caller to
   * the voicemail now, where a bare close would read as a server drop and
   * be retried as a resume against a row that was never opened.
   */
  private async abort(why: string, error: unknown): Promise<void> {
    if (this.endReason) return;
    this.endReason = 'failed';
    this.phase = 'ended';
    this.clearTimers();
    await this.report(error);
    this.deps.sink.send({ type: 'end', handoffData: JSON.stringify({ reason: 'failed', why } satisfies HandoffData) });
    await this.persistEnd({ reason: 'failed', why });
    this.deps.sink.close();
    this.resolveFinished();
  }

  /* ---------------------------------------------------------------------- */
  /*  The caller spoke                                                       */
  /* ---------------------------------------------------------------------- */

  private async onPrompt(m: PromptMessage): Promise<void> {
    if (this.phase === 'connecting' || this.phase === 'ending' || this.phase === 'ended') return;
    // The caller is talking; the silence clock stops even before the sentence is final.
    this.clearIdle();
    if (!m.last) return;
    let text = m.voicePrompt.trim();
    if (!text) {
      this.armIdle();
      return;
    }
    /*
     * What language the transcriber heard, as a note the model reads. Only
     * when it differs from the language the assistant is speaking right now
     * — English while the call is in English needs no announcing, and once
     * the call is in Spanish an English sentence is news the model should
     * hear, so it can bring the call back with switch_language('en-US') —
     * and only once per language until the model acts on it. The once-only
     * guard is what keeps a short "sí" the detector mislabels as English
     * from pulling a Spanish conversation back: the model sees one note it
     * is free to ignore, never a switch. The note is part of the persisted
     * turn on purpose: the resumed connection answers the same turn from
     * the row and must see the same note.
     */
    const hint = primaryTag(m.lang);
    if (hint && hint !== this.state.langHint) {
      this.state.langHint = hint;
      await this.deps.store.setState(this.deps.workspaceId, this.deps.call.id, { langHint: hint });
    }
    const active = primaryTag(this.state.lang) || 'en';
    if (hint && hint !== active && hint !== this.notedHint) {
      this.notedHint = hint;
      text = `[caller spoke in ${languageName(hint)}] ${text}`;
    }
    await this.userTurn({ role: 'user', text, ts: this.now() });
  }

  /**
   * Persist first, think second. If the function dies between the two the
   * resumed connection finds an unanswered user turn and answers it; if the
   * model is already busy with the previous one, the reply it is about to
   * give is marked preemptible and the loop runs once more with both turns
   * in the history, which reads to the model as one longer utterance.
   */
  private async userTurn(turn: Turn): Promise<void> {
    this.turns.push(turn);
    await this.deps.store.append(this.deps.workspaceId, this.deps.call.id, [turn]);
    if (this.endReason) return;
    if (this.remaining() < this.deps.limits.rotateThinkMs) {
      await this.rotate();
      return;
    }
    if (this.working) this.preemptNext = true;
    this.pending = true;
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.working) return;
    this.working = true;
    try {
      while (this.pending && !this.endReason) {
        this.pending = false;
        await withLang(this.deps.teamLang, () => this.think());
      }
    } catch (error) {
      await this.report(error);
    } finally {
      this.working = false;
    }
  }

  private async think(): Promise<void> {
    const remaining = this.remaining();
    // Two ways of saying the same thing, kept both: the policy number, and
    // the arithmetic behind it, in case the two are ever tuned apart.
    if (remaining < this.deps.limits.rotateThinkMs || remaining - this.deps.limits.rotateListenMs < this.deps.limits.roundFloorMs) {
      await this.rotate();
      return;
    }
    this.phase = 'thinking';
    this.clearIdle();
    const turn = this.replies + 1;

    /*
     * Time-based, not round-based: the caller cannot tell a slow first round
     * from a tool call, only that nothing has been said for a while. Sent
     * preemptible so the real reply cuts it off, and never persisted — it is
     * noise, not part of the conversation.
     */
    this.fillerTimer = this.after(this.tuning.fillerMs, () => {
      if (this.phase !== 'thinking' || this.endReason) return;
      this.say(this.sentences().filler, { preemptible: true });
      this.lastSpoken = 'filler';
    });

    let result: VoiceTurnResult | null = null;
    try {
      result = await this.deps.turn({
        history: [...this.turns],
        state: { ...this.state },
        sessionId: this.sessionId,
        turn,
        budgetMs: remaining - this.deps.limits.rotateListenMs,
        nowMs: this.now(),
      });
    } catch (error) {
      await this.report(error);
    }
    this.clearTimer(this.fillerTimer);
    this.fillerTimer = null;
    if (this.endReason) {
      /*
       * The session ended while the model was thinking — a rotate, the
       * minutes cap, a hang-up. Whatever the model did is done: a booking
       * made, a message filed. Dropping the result would leave the user turn
       * unanswered in the row, and the resumed connection would answer it
       * from scratch and run those tools a second time. The turn is kept as
       * an assistant turn with the tool trace and no words, which the resumed
       * session answers first thing, from the results, without a second run.
       */
      if (result) await this.keepUnspoken(result);
      return;
    }

    if (!result) {
      // The model is the part that can fail without the call being over. The caller hears an apology and the conversation goes on.
      await this.speak(this.sentences().apology, {});
      return;
    }

    this.state = { ...this.state, ...result.state };
    await this.deps.store.setState(this.deps.workspaceId, this.deps.call.id, result.state);
    this.costCents += Math.max(0, result.costUsd) * 100;
    if (result.booked) this.booked = true;
    const tools = toolsOf(result);
    this.noteTools(tools);
    const reply = result.reply.trim();

    /*
     * The one action that does not end the exchange: the model asked to go on
     * in another language. The voice is switched before the reply is spoken,
     * so the reply itself — the model's first words in that language — comes
     * out in the right voice, and the words are the model's when it gave
     * some and the table's when it did not. When a terminal action took the
     * action slot on the same turn, the switch arrives as `result.language`
     * instead, and it is honoured first for the same reason: the farewell
     * or the "connecting you" is read in the language the caller just chose.
     */
    let switched = false;
    const wantedLang = result.action?.kind === 'language' ? result.action.code : (result.language ?? null);
    if (wantedLang) {
      switched = await this.switchLanguage(wantedLang);
    }

    if (result.action && result.action.kind !== 'language') {
      switch (result.action.kind) {
        case 'transfer':
          this.state.transferAttempts = (this.state.transferAttempts ?? 0) + 1;
          await this.endWith('transfer', this.sentences().transfer, { to: result.action.to }, { runId: result.runId, tools });
          return;
        case 'voicemail':
          await this.endWith('voicemail', this.sentences().voicemail, {}, { runId: result.runId, tools });
          return;
        case 'end':
          await this.endWith('assistant-ended', reply || this.sentences().farewell, {}, { runId: result.runId, tools });
          return;
      }
    }

    this.replies += 1;
    const preemptible = this.preemptNext;
    this.preemptNext = false;
    await this.speak(reply || (switched ? this.sentences().switched : this.sentences().empty), { runId: result.runId ?? undefined, tools, preemptible });
    if (this.replies >= this.deps.limits.maxTurns) await this.endWith('max-turns', this.sentences().wrapUp);
  }

  /**
   * The model asked, through `switch_language`, to continue in `code`. The
   * tool already checked the code against the workspace's list; it is
   * checked once more here because the engine, not the tool, is what sends
   * Twilio a `language` message, and an unknown code in that message is an
   * error that ends the session. English (any `en-*`) is always allowed and
   * means "back to the primary": the state goes to null, which is how the
   * row has always spelled English.
   *
   * Sent once per change: a second request for the language already being
   * spoken is a no-op, so a model that repeats the tool call does not make
   * Twilio re-load the voice mid-sentence. Returns whether anything changed.
   */
  private async switchLanguage(code: string): Promise<boolean> {
    const wanted = (code ?? '').trim();
    const english = primaryTag(wanted) === 'en';
    if (!wanted || !(english || this.allowedLanguage(wanted))) {
      await this.report(new Error(`switch_language refused: ${wanted || '(empty)'} is not in the workspace's languages`));
      return false;
    }
    const next = english ? null : wanted;
    if ((this.state.lang ?? null) === next) return false;
    this.deps.sink.send({ type: 'language', ttsLanguage: english ? 'en-US' : wanted });
    this.state.lang = next;
    this.notedHint = null;
    await this.deps.store.setState(this.deps.workspaceId, this.deps.call.id, { lang: next });
    return true;
  }

  /**
   * Whether the call may be moved to `code`: the same answer `switchableLanguages`
   * gives the model, so the engine never sends Twilio a `language` message
   * for a code the TwiML did not declare. On Amazon or Google the TwiML has
   * no `<Language>` children and no `language="multi"`, so the list is empty
   * there whatever the settings say, and the tool was not offered either.
   */
  private allowedLanguage(code: string): boolean {
    return switchableLanguages(this.deps.settings.ai).includes(code);
  }

  /** The engine's own sentences in the language the assistant is speaking right now. */
  private sentences(): Sentences {
    return sentencesFor(this.state.lang);
  }

  /**
   * Every text the engine sends goes through here so it carries the
   * session's language. Twilio reads a text in the TwiML's language unless
   * the message says otherwise; after a switch, "otherwise" is every message,
   * and a resumed connection whose TwiML opened in the caller's language is
   * covered the same way. English is written out as `en-US` rather than
   * left off, so the two cases are one code path.
   */
  private say(token: string, extra: Partial<Omit<TextMessage, 'type' | 'token' | 'last' | 'lang'>> = {}): void {
    this.deps.sink.send({ type: 'text', token, last: true, lang: ttsLangOf(this.state.lang), ...extra });
  }

  /** The tools that decide the outcome, noted as they run so `outcomeOf` can name what the call amounted to. */
  private noteTools(tools: Turn['tools'] | undefined): void {
    if (!tools) return;
    for (const tool of tools) {
      if (tool.name === 'leave_message_for_team') this.tookMessage = true;
      // The trace has no error flag; the tools' own first word says whether they did it (`tools.ts`).
      if (tool.name === 'cancel_appointment' && /^Canceled\b/.test(tool.result)) this.canceled = true;
      if (tool.name === 'reschedule_appointment' && /^Moved\b/.test(tool.result)) this.rescheduled = true;
    }
  }

  /** A model answer that arrived too late to be spoken: persisted for its tool results, never for its words. */
  private async keepUnspoken(result: VoiceTurnResult): Promise<void> {
    const tools = toolsOf(result);
    this.noteTools(tools);
    if (result.booked) this.booked = true;
    this.costCents += Math.max(0, result.costUsd) * 100;
    try {
      this.state = { ...this.state, ...result.state };
      await this.deps.store.setState(this.deps.workspaceId, this.deps.call.id, result.state);
      /*
       * A switch_language on this turn is a fact about the row, not about
       * the socket that is closing: the model now believes the call is in
       * Spanish and will not ask again, so the row must say so, or the
       * resumed connection reopens in English, reads the re-answered turn in
       * the English voice and the summary never learns the language. No
       * `language` message here — there is nobody to send it to; the fresh
       * `<Connect>` carries `ttsLanguage` from the row instead. The same
       * checks as `switchLanguage`, because the code goes into TwiML next.
       */
      const wantedLang = result.action?.kind === 'language' ? result.action.code : (result.language ?? null);
      const wanted = (wantedLang ?? '').trim();
      if (wanted) {
        const english = primaryTag(wanted) === 'en';
        if (english || this.allowedLanguage(wanted)) {
          const next = english ? null : wanted;
          if ((this.state.lang ?? null) !== next) {
            this.state.lang = next;
            this.notedHint = null;
            await this.deps.store.setState(this.deps.workspaceId, this.deps.call.id, { lang: next });
          }
        }
      }
      const turn: Turn = {
        role: 'assistant',
        text: '',
        ts: this.now(),
        unspoken: true,
        ...(result.runId ? { runId: result.runId } : {}),
        ...(tools?.length ? { tools } : {}),
      };
      this.turns.push(turn);
      await this.deps.store.append(this.deps.workspaceId, this.deps.call.id, [turn]);
    } catch (error) {
      await this.report(error);
    }
  }

  /* ---------------------------------------------------------------------- */
  /*  Interrupt, keypad, errors                                              */
  /* ---------------------------------------------------------------------- */

  private async onInterrupt(m: InterruptMessage): Promise<void> {
    /*
     * The caller spoke over something. If that something was the filler, the
     * reply is still to come and the transcript has nothing to cut; if it was
     * an aside — the idle ask, a `*` repeat — no turn was appended for it
     * and the last real reply must stay as it was; only a reply is cut to
     * what was heard, because a later "as I said" from the model would
     * otherwise refer to words never played.
     */
    if (this.lastSpoken !== 'reply') {
      if (this.lastSpoken === 'aside' && this.phase === 'speaking') {
        this.phase = 'listening';
        this.armIdle();
      }
      return;
    }
    if (this.phase !== 'speaking' && this.phase !== 'listening') return;
    const heard = m.utteranceUntilInterrupt.trim();
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      const turn = this.turns[i]!;
      if (turn.role !== 'assistant') continue;
      turn.text = heard;
      turn.interrupted = true;
      break;
    }
    await this.deps.store.truncateLast(this.deps.workspaceId, this.deps.call.id, heard);
    this.lastAssistantText = heard;
    this.speakingUntil = this.now();
    this.clearTimer(this.listenTimer);
    this.listenTimer = null;
    this.phase = 'listening';
    this.armIdle();
  }

  private async onDtmf(m: DtmfMessage): Promise<void> {
    if (this.phase === 'connecting' || this.phase === 'ending' || this.phase === 'ended') return;
    const digit = (m.digit ?? '').trim();
    if (!digit) return;
    this.dtmfBuffer += digit;
    this.clearTimer(this.dtmfTimer);
    // Digits come one message each; a person dialling "12" is one entry, not two.
    this.dtmfTimer = this.after(this.tuning.dtmfBufferMs, () => {
      this.dtmfTimer = null;
      this.chain = this.chain.then(() => withLang(this.deps.teamLang, () => this.flushDtmf())).catch((error) => this.report(error));
    });
  }

  private async flushDtmf(): Promise<void> {
    const digits = this.dtmfBuffer;
    this.dtmfBuffer = '';
    if (!digits || this.endReason) return;
    this.clearIdle();
    if (digits === '0' && this.deps.transferTo && (this.state.transferAttempts ?? 0) < 1) {
      // Zero for a person is the one keypad habit everybody has; no model needed.
      // Once the team has been tried and did not pick up, the same rule as the
      // model's `transfer_to_human` applies: no second dial, the press becomes
      // a user turn and the assistant offers to take a message.
      this.state.transferAttempts = (this.state.transferAttempts ?? 0) + 1;
      await this.endWith('transfer', this.sentences().transfer, { to: this.deps.transferTo });
      return;
    }
    if (digits === '*') {
      if (this.lastAssistantText) {
        this.say(this.lastAssistantText);
        this.lastSpoken = 'aside';
        this.spokeFor(this.lastAssistantText);
      }
      return;
    }
    await this.userTurn({ role: 'user', text: `[pressed ${digits}]`, ts: this.now(), dtmf: digits });
  }

  private async onError(m: ErrorMessage): Promise<void> {
    const code = relayErrorCode(m);
    await this.report(new Error(`twilio ${code ?? '-'}: ${m.description}`));
    if (code === null || !FATAL_RELAY_CODES.has(code)) return;
    // Twilio has already ended the session on its side; there is nobody left to speak to.
    this.endReason = 'failed';
    this.phase = 'ended';
    this.clearTimers();
    await this.persistEnd({ reason: 'failed', why: `twilio ${code}` });
    this.resolveFinished();
  }

  /**
   * Twilio's report of what has just been played (`events="tokens-played"`
   * in the TwiML). It is the accurate end of the assistant's speech, where
   * `spokeFor` only guesses from the length of the text; the guess stays as
   * the fallback because the message's fields are not documented and a
   * report that does not match the sentence being spoken is ignored.
   */
  private async onInfo(m: InfoMessage): Promise<void> {
    if (!/tokens?-?played/i.test(String(m.name ?? ''))) return;
    const played = String(m.value ?? '').trim();
    const current = this.lastAssistantText.trim();
    const tail = current.slice(-24);
    const finished = m.last === true || (played.length > 0 && tail.length > 0 && played.endsWith(tail));
    if (!finished) return;
    this.playedResolve?.();
    this.playedResolve = null;
    if (this.phase !== 'speaking') return;
    this.speakingUntil = this.now();
    this.clearTimer(this.listenTimer);
    this.listenTimer = null;
    this.phase = 'listening';
    this.armIdle();
  }

  /* ---------------------------------------------------------------------- */
  /*  Speaking and ending                                                    */
  /* ---------------------------------------------------------------------- */

  /** One reply, spoken and persisted, then the estimated wait before the caller is being listened to again. */
  private async speak(text: string, opts: { runId?: string; tools?: Turn['tools']; preemptible?: boolean }): Promise<void> {
    if (this.endReason) return;
    this.say(text, opts.preemptible ? { preemptible: true } : {});
    this.lastSpoken = 'reply';
    this.lastAssistantText = text;
    const turn: Turn = {
      role: 'assistant',
      text,
      ts: this.now(),
      ...(opts.runId ? { runId: opts.runId } : {}),
      ...(opts.tools?.length ? { tools: opts.tools } : {}),
    };
    this.turns.push(turn);
    await this.deps.store.append(this.deps.workspaceId, this.deps.call.id, [turn]);
    this.spokeFor(text);
  }

  /**
   * When the caller is being listened to again, guessed from the length of
   * the text. The TwiML subscribes to Twilio's `tokens-played` report, which
   * is the accurate signal and moves the phase the moment it arrives
   * (`onInfo`); the guess is what stands when that report does not come. It
   * only feeds the idle clock and the rotate's courtesy wait; a prompt or an
   * interrupt overrides it the instant it arrives.
   */
  private spokeFor(text: string): void {
    const ms = Math.min(this.tuning.speakMaxMs, Math.max(this.tuning.speakMinMs, text.length * this.tuning.speakMsPerChar));
    this.speakingUntil = this.now() + ms;
    this.phase = 'speaking';
    this.clearTimer(this.listenTimer);
    this.listenTimer = this.after(ms, () => {
      this.listenTimer = null;
      if (this.phase !== 'speaking') return;
      this.phase = 'listening';
      this.armIdle();
    });
  }

  /**
   * The only way a session ends on our side: a fixed sentence, a pause long
   * enough for it to play, then `end` with the reason for the action webhook.
   * Idempotent — the first reason wins, so a rotate racing a hang-up or a
   * max-turns racing the caller's goodbye cannot write two endings.
   */
  private async endWith(reason: EndReason, sentence: string, handoff: Omit<HandoffData, 'reason'> = {}, spoken: { runId?: string | null; tools?: Turn['tools'] } = {}): Promise<void> {
    if (this.endReason) return;
    this.endReason = reason;
    this.phase = 'ending';
    this.clearTimers();

    this.say(sentence);
    this.lastSpoken = 'reply';
    this.lastAssistantText = sentence;
    if (reason !== 'rotate') {
      const turn: Turn = {
        role: 'assistant',
        text: sentence,
        ts: this.now(),
        ...(spoken.runId ? { runId: spoken.runId } : {}),
        ...(spoken.tools?.length ? { tools: spoken.tools } : {}),
      };
      this.turns.push(turn);
      await this.deps.store.append(this.deps.workspaceId, this.deps.call.id, [turn]);
    }
    if (reason === 'transfer') {
      await this.deps.store.setState(this.deps.workspaceId, this.deps.call.id, { transferAttempts: this.state.transferAttempts });
    }

    // Let the sentence play before the session is torn down under it: the
    // `tokens-played` report says when, the length guess is the ceiling.
    const ms = Math.min(this.tuning.speakMaxMs, Math.max(this.tuning.speakMinMs, sentence.length * this.tuning.speakMsPerChar));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.playedResolve = null;
        resolve();
      }, ms);
      this.playedResolve = () => {
        clearTimeout(timer);
        resolve();
      };
    });

    const data: HandoffData = { reason, ...handoff };
    this.deps.sink.send({ type: 'end', handoffData: JSON.stringify(data) });
    await this.persistEnd(data);
    this.phase = 'ended';
    this.resolveFinished();
  }

  /** Waits for a reply in flight to finish (briefly), then hands the call back so a fresh function can pick it up. */
  private async rotate(): Promise<void> {
    if (this.endReason) return;
    this.phase = 'rotating';
    this.clearIdle();
    const wait = Math.min(this.tuning.rotateWaitMs, Math.max(0, this.speakingUntil - this.now()));
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    await this.endWith('rotate', this.sentences().rotate);
  }

  private async persistEnd(handoff: HandoffData): Promise<void> {
    if (!this.opened) return;
    const terminal = handoff.reason !== 'rotate';
    try {
      await this.deps.store.end(this.deps.workspaceId, this.deps.call.id, {
        reason: handoff.reason,
        outcome: terminal ? this.outcomeOf(handoff.reason) : undefined,
        handoff,
        costCents: Math.round(this.costCents),
        expectedRotateCount: this.rotateCount,
      });
      this.costCents = 0;
    } catch (error) {
      await this.report(error);
    }
  }

  private outcomeOf(reason: EndReason): SessionOutcome {
    if (reason === 'transfer') return 'transferred';
    if (reason === 'voicemail') return 'voicemail';
    if (this.booked) return 'booked';
    if (this.rescheduled) return 'rescheduled';
    if (this.canceled) return 'canceled';
    if (this.tookMessage) return 'message';
    if (reason === 'failed') return 'nothing';
    return this.turns.some((t) => t.role === 'user') ? 'info' : 'nothing';
  }

  /* ---------------------------------------------------------------------- */
  /*  Clocks                                                                 */
  /* ---------------------------------------------------------------------- */

  private remaining(): number {
    return this.deps.deadlineMs - this.now();
  }

  /** The silence clock: ask once, then let the caller go. Armed after every reply, cleared by anything the caller does. */
  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = this.after(this.deps.limits.idleAskMs, () => {
      if (this.phase !== 'listening' || this.endReason) return;
      this.say(this.sentences().idleAsk);
      // No turn is appended for the ask; an interrupt over it must not cut the last real reply.
      this.lastSpoken = 'aside';
      this.idleTimer = this.after(this.deps.limits.idleEndMs, () => {
        if (this.phase !== 'listening' || this.endReason) return;
        void this.endWith('idle', this.sentences().idleEnd);
      });
    });
  }

  private clearIdle(): void {
    this.clearTimer(this.idleTimer);
    this.idleTimer = null;
  }

  private after(ms: number, fn: () => void): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
    return timer;
  }

  private clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(timer);
  }

  /** Everything, so a finished session holds no handle and a test process can exit. */
  private clearTimers(): void {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.idleTimer = this.dtmfTimer = this.fillerTimer = this.listenTimer = null;
  }

  private async report(error: unknown): Promise<void> {
    try {
      await this.deps.store.recordError({ where: 'relay', error, workspaceId: this.deps.workspaceId, path: `/api/twilio/relay?call=${this.deps.call.id}` });
    } catch {
      // The error log is the one place a failure may be lost: nothing here may throw into a socket listener.
    }
  }
}

/**
 * What the assistant looked up on this turn, as the model side reports it,
 * cut to size once more here so the persisted turn stays small whatever the
 * AI side sent. Kept on the assistant turn so a later "the nine-thirty one"
 * can be resolved from the transcript without a second lookup.
 */
function toolsOf(result: VoiceTurnResult): Turn['tools'] | undefined {
  if (!Array.isArray(result.tools)) return undefined;
  const out: { name: string; result: string }[] = [];
  for (const item of result.tools) {
    if (!item || typeof item.name !== 'string' || !item.name) continue;
    out.push({ name: item.name.slice(0, TOOL_TEXT_MAX), result: String(item.result ?? '').slice(0, TOOL_TEXT_MAX) });
  }
  return out.length ? out : undefined;
}
