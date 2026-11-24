import type { Call, Lang, VoiceSettings } from '../support';
import type { AiUsage } from '../ai/provider';

/**
 * The shapes every part of the voice receptionist agrees on.
 *
 * This file is the contract between the relay side (the WebSocket route, the
 * session engine, the store) and the AI side (the per-turn model call), so the
 * two can be built and tested apart and meet on these names alone. It carries
 * only types and two small tables (the timing numbers, the language names)
 * with the helpers that read them — and every import is `import type`, because `src/db/schema.ts` reads `Turn` and
 * `SessionState` from here to type the `voice_sessions` jsonb columns. A
 * runtime import in this file would close a cycle (types → store → schema →
 * types) that ESM resolves to `undefined` at the worst moment.
 *
 * The caller hears English unless they speak something else: the session
 * then switches Twilio's voice to the caller's language and carries it in
 * `SessionState.lang`. Everything the team reads goes through the i18n layer
 * with `teamLang`. That split shows up here as two separate fields rather
 * than one language, and neither has anything to do with the other.
 */

/* ------------------------------------------------------------------------ */
/*  What Twilio ConversationRelay sends and accepts on the socket            */
/* ------------------------------------------------------------------------ */

/**
 * The first message on every connection. Twilio documents more fields than
 * these; anything not listed is ignored on purpose, so a field Twilio adds
 * later cannot break the parse. `customParameters` arrive unsigned — they are
 * whatever the TwiML `<Parameter>`s said — and are cross-checked against the
 * call row, never trusted on their own.
 */
export interface SetupMessage {
  type: 'setup';
  sessionId: string;
  accountSid: string;
  callSid: string;
  parentCallSid?: string;
  from?: string;
  to?: string;
  forwardedFrom?: string;
  callerName?: string;
  direction?: string;
  callType?: string;
  callStatus?: string;
  customParameters?: Record<string, string>;
}

/**
 * The caller said something. `last` is false while the transcriber is still
 * listening. With `language="multi"` in the TwiML, `lang` is the primary tag
 * Deepgram detected ("en", "es", "pt") and never a region; the session turns
 * it into a note for the model and leaves the decision to switch to it.
 */
export interface PromptMessage {
  type: 'prompt';
  voicePrompt: string;
  lang?: string;
  last: boolean;
}

/** The caller spoke over the assistant; the text is what had been played so far. */
export interface InterruptMessage {
  type: 'interrupt';
  utteranceUntilInterrupt: string;
  durationUntilInterruptMs?: number;
}

export interface DtmfMessage {
  type: 'dtmf';
  digit: string;
}

/**
 * Twilio's own complaint about the session or about a message we sent. The
 * documented shape carries only `description`; the numeric code, when Twilio
 * includes one, is what decides whether the session is over (the connect-class
 * codes in the plan's §2.2) or merely noisy.
 */
export interface ErrorMessage {
  type: 'error';
  description: string;
  code?: number;
}

/**
 * What Twilio sends when the TwiML subscribed to `events="tokens-played"`:
 * a report of what has just been played over TTS. The attribute is
 * documented on the `<ConversationRelay>` noun; the message body is not, so
 * only `type` is relied on and the rest is read defensively — a message
 * whose fields do not match is simply the length guess falling back into
 * place, never a crash.
 */
export interface InfoMessage {
  type: 'info';
  name?: string;
  value?: string;
  last?: boolean;
  [key: string]: unknown;
}

export type InMessage = SetupMessage | PromptMessage | InterruptMessage | DtmfMessage | ErrorMessage | InfoMessage;

/**
 * Text for the TTS. Non-streaming in v1: one token per reply with `last: true`.
 * `lang` is the BCP-47 tag the token should be read in; the session stamps
 * every text with the caller's language once they have switched, so a resumed
 * connection cannot read a Spanish sentence with the English voice.
 */
export interface TextMessage {
  type: 'text';
  token: string;
  last: boolean;
  lang?: string;
  interruptible?: boolean;
  /** A later text or play replaces this one mid-playback. Fillers are sent this way. */
  preemptible?: boolean;
}

/** Ends the session; Twilio then POSTs the TwiML `action` with `HandoffData` as a JSON string. */
export interface EndMessage {
  type: 'end';
  handoffData?: string;
}

export interface SendDigitsMessage {
  type: 'sendDigits';
  digits: string;
}

export interface PlayMessage {
  type: 'play';
  source: string;
  loop?: number;
  preemptible?: boolean;
  interruptible?: boolean;
}

/**
 * Changes the spoken language mid-session. Twilio reads the voice for it from
 * the `<Language>` children of the TwiML (or its own default for that
 * provider), and keeps it until the next one; the transcriber is left alone
 * because `language="multi"` already detects on its own.
 */
export interface LanguageMessage {
  type: 'language';
  ttsLanguage?: string;
  transcriptionLanguage?: string;
}

export type OutMessage = TextMessage | EndMessage | SendDigitsMessage | PlayMessage | LanguageMessage;

/**
 * The English name of each language the assistant may speak, by primary tag.
 * The one place the names live: the session writes "[caller spoke in
 * Spanish]" for the model from it, the summary writes "Language: Spanish"
 * for the team from it, and the settings card labels its checkboxes with it.
 * A tag not in here is spoken of by its code, never dropped.
 */
export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  pt: 'Portuguese',
  fr: 'French',
  de: 'German',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  nl: 'Dutch',
  hi: 'Hindi',
};

/** "es-US" → "es"; "" → "". Lower-cased, so a provider's "ES" reads as Spanish too. */
export function primaryTag(code: string | null | undefined): string {
  return (code ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '';
}

/** "es-US" → "Spanish"; an unknown tag is returned as it came, so the model still sees something. */
export function languageName(code: string | null | undefined): string {
  const tag = primaryTag(code);
  return LANGUAGE_NAMES[tag] ?? (code ?? '').trim();
}

/* ------------------------------------------------------------------------ */
/*  How a session ends, and what it hands to the action webhook             */
/* ------------------------------------------------------------------------ */

export type EndReason =
  | 'caller-hung-up'
  | 'assistant-ended'
  | 'transfer'
  | 'voicemail'
  | 'idle'
  | 'max-minutes'
  | 'max-turns'
  | 'rotate'
  | 'failed';

/**
 * Serialised into `end.handoffData` and read back by the `relay-done` step,
 * which is the only place that decides what TwiML comes next. `to` is the
 * transfer destination; `why` is a short English note for the error log.
 */
export interface HandoffData {
  reason: EndReason;
  to?: string;
  why?: string;
}

/* ------------------------------------------------------------------------ */
/*  The transcript and the state the model needs between turns               */
/* ------------------------------------------------------------------------ */

/**
 * One exchange as persisted in `voice_sessions.turns`. A `system` turn is a
 * note the engine leaves for the model ("the team did not pick up"); it is
 * folded into the next user message when the history is rebuilt, never spoken.
 * `tools` keeps what the assistant looked up on this turn so a later "the
 * nine-thirty one" does not force a second `list_free_slots`.
 */
export interface Turn {
  role: 'user' | 'assistant' | 'system';
  text: string;
  /** Milliseconds since the epoch, on the server's clock. */
  ts: number;
  /** The caller spoke over this reply; `text` was cut to what was actually played. */
  interrupted?: boolean;
  /** The `ai_runs` row that produced an assistant turn. */
  runId?: string;
  /** Keypad digits that produced a user turn, kept raw next to the `[pressed …]` text. */
  dtmf?: string;
  /** Name and result of each tool call, each truncated to 400 characters. */
  tools?: { name: string; result: string }[];
  /**
   * An assistant turn whose tools ran but whose words were never played: the
   * model answered after the session had already rotated or been cut off.
   * Kept so the resumed connection folds the tool results into the history
   * and answers the waiting caller without running the tools a second time.
   */
  unspoken?: boolean;
}

/**
 * Everything the model needs to remember that is not in the transcript.
 * Persisted as one jsonb and patched with `state || $1`, so a field added later
 * costs nothing.
 */
export interface SessionState {
  /** Slots read out so far: the exact ISO start to copy and the words the caller heard. */
  offered?: { startIso: string; spoken: string }[];
  /** The contact id `look_up_contact` resolved, when it ran. */
  lookedUp?: string;
  /** How many times the assistant tried to reach a person on this call. */
  transferAttempts: number;
  /** The caller confirmed the name and day on a booking before touching it. */
  identityChecked?: boolean;
  /** Set when the caller said no to texts, so the model is not told to ask again. */
  textConsentDeclined?: boolean;
  /** The Twilio error code of the last segment that dropped, for the resume-or-fail decision. */
  lastFailure?: number;
  /**
   * The BCP-47 tag of the language the assistant is speaking, once the model
   * switched to it through `switch_language`; null (or absent) means English,
   * which is the language of the greeting and of everything the team reads.
   * Persisted so a rotated or resumed connection opens in the same language
   * instead of flipping back to English mid-call.
   */
  lang?: string | null;
  /** The primary tag the transcriber last reported for the caller ("es"), whether or not the assistant switched. */
  langHint?: string | null;
  /**
   * What the caller said about themselves before the transfer, written by
   * `transfer_to_human` and read after the socket has closed: by the
   * `relay-done` step for the whisper the colleague hears, and by the
   * summary job for the line it stamps. Persisted with the rest of the
   * state before the `end` message goes out, so the webhook never races it.
   */
  caller?: CallerIntake;
  /**
   * The turn on which `transfer_to_human` was refused for arriving without
   * a name and the model was told to ask. A later turn — the caller has had
   * their say — goes through with whatever it carries: one question is the
   * intake, not an interrogation. The same turn is refused again, because a
   * retry inside one turn is a model answering itself, not the caller.
   */
  intakeAskedTurn?: number;
}

/**
 * The briefing a receptionist gives before putting a call through: who it
 * is, who they are with, what they need, and whether it is new business.
 * Every field is what the caller said, in English, already trimmed; a
 * missing one means they did not say, not that the assistant forgot.
 */
export interface CallerIntake {
  name?: string;
  company?: string;
  /** What they need, one sentence, for the person picking up. */
  wants?: string;
  /** A prospective client asking about the services, as the model judged it. */
  lead?: boolean;
  /**
   * What the contact row already had when the caller gave nothing new: a
   * name from an earlier call or from caller-ID, a company on file. The
   * whisper uses it so the colleague hears a name; the summary does not,
   * because "the caller gave" means what they said on this call.
   */
  onFile?: { name?: string; company?: string };
}

/* ------------------------------------------------------------------------ */
/*  The persisted session row and the store the engine writes through       */
/* ------------------------------------------------------------------------ */

export type SessionStatus = 'connecting' | 'live' | 'rotating' | 'ended';

/** What the call amounted to, for the timeline title and the team notification. */
export type SessionOutcome =
  | 'booked'
  | 'rescheduled'
  | 'canceled'
  | 'message'
  | 'transferred'
  | 'voicemail'
  | 'info'
  | 'nothing';

/**
 * One row of `voice_sessions`, spelled out rather than inferred from the
 * schema so this file stays free of a type-level cycle with `schema.ts`. The
 * store maps the Drizzle row onto this shape; the columns have the same names.
 */
export interface SessionRow {
  id: string;
  workspaceId: string;
  callId: string;
  status: SessionStatus;
  turns: Turn[];
  turnCount: number;
  /** How many times the socket was re-connected to dodge the function deadline. */
  rotateCount: number;
  state: SessionState;
  endReason: EndReason | null;
  outcome: SessionOutcome | null;
  handoff: HandoffData | null;
  summary: string | null;
  costCents: number;
  startedAt: Date;
  lastTurnAt: Date | null;
  endedAt: Date | null;
}

export interface SessionEndInput {
  reason: EndReason;
  outcome?: SessionOutcome | null;
  handoff?: HandoffData | null;
  /** Added to the row's running total, not assigned. */
  costCents?: number;
  /**
   * The rotate count this invocation opened with. The UPDATE is guarded on it,
   * so a function that was already replaced by a resumed connection cannot
   * write its ending over the live one.
   */
  expectedRotateCount: number;
}

/**
 * Everything the session engine writes, behind an interface so the engine can
 * be unit-tested with a fake and never imports Neon itself. Every method takes
 * the workspace id and scopes its query by it. The two call-row writes the
 * session needs (`markAnswered`, `recordError`) live here too, for the same
 * reason.
 */
export interface SessionStore {
  /**
   * Inserts the row for a first connection, or on a resume bumps `rotate_count`
   * and returns the turns and state so far. One statement, so two connections
   * racing for the same call cannot both think they are first.
   */
  open(workspaceId: string, callId: string): Promise<SessionRow>;
  /** Atomic append: `turns = turns || $1`, `turn_count = turn_count + n`. */
  append(workspaceId: string, callId: string, turns: Turn[]): Promise<void>;
  /**
   * Rewrites the text of the last turn, only when it is an assistant turn, and
   * marks it interrupted. Returns false when the guard did not match.
   */
  truncateLast(workspaceId: string, callId: string, text: string): Promise<boolean>;
  /** `state = state || $1` — a merge, never a replacement. */
  setState(workspaceId: string, callId: string, patch: Partial<SessionState>): Promise<void>;
  /** Marks the row ended, guarded by `rotate_count = expectedRotateCount`. Returns whether it applied. */
  end(workspaceId: string, callId: string, input: SessionEndInput): Promise<boolean>;
  byCall(workspaceId: string, callId: string): Promise<SessionRow | null>;
  /**
   * `applyCallStatus(call, { status: 'in-progress', meta: { leg: 'relay', answeredBy: 'ai' } })`:
   * stamps `answeredAt`, which is what keeps an AI-answered call out of the
   * missed-call path. Returns the row as it stands afterwards.
   */
  markAnswered(call: Call): Promise<Call>;
  /** `ops/errors.recordError` with `where: 'relay'`; never throws. */
  recordError(input: { where: string; error: unknown; workspaceId?: string | null; path?: string | null }): Promise<void>;
}

/* ------------------------------------------------------------------------ */
/*  The engine's dependencies and limits                                      */
/* ------------------------------------------------------------------------ */

/** The socket, reduced to the two things the engine does with it. */
export interface RelaySink {
  send(m: OutMessage): void;
  close(): void;
}

/**
 * The timers the engine runs on, in milliseconds unless the name says
 * otherwise. `maxTurns` and `maxMinutes` come from the workspace's settings;
 * the rest are fixed and shared so the tests and the engine cannot disagree.
 */
export interface SessionLimits {
  maxTurns: number;
  /** Total across rotations, measured from `call.answeredAt`. */
  maxMinutes: number;
  /** Silence after which the assistant asks "Are you still there?". */
  idleAskMs: number;
  /** Silence after the ask before the session ends as `idle`. */
  idleEndMs: number;
  /** With less than this left before the deadline, stop listening and rotate. */
  rotateListenMs: number;
  /**
   * With less than this left, a prompt is persisted and the session rotates
   * instead of thinking. It leaves the model at least one round after
   * `rotateListenMs` is set aside: the listen margin, the round floor and one
   * provider call — a turn started with less than that has nowhere to go but
   * an empty reply and a second "could you say that again?".
   */
  rotateThinkMs: number;
  /** The model is not asked for another round with less than this left in its budget. */
  roundFloorMs: number;
}

/** The fixed part of `SessionLimits`. The two per-workspace numbers are spread on top. */
export const SESSION_TIMING: Pick<SessionLimits, 'idleAskMs' | 'idleEndMs' | 'rotateListenMs' | 'rotateThinkMs' | 'roundFloorMs'> = {
  idleAskMs: 25_000,
  idleEndMs: 20_000,
  rotateListenMs: 40_000,
  // 40 s listen margin + 8 s round floor + 12 s (`CALL_TIMEOUT_MS` in ai/voice.ts) for one model round.
  rotateThinkMs: 60_000,
  roundFloorMs: 8_000,
};

export interface SessionDeps {
  call: Call;
  creds: { accountSid: string };
  settings: VoiceSettings;
  /** The team's language, for anything the session writes that the team reads. */
  teamLang: Lang;
  workspaceId: string;
  sink: RelaySink;
  /** Absolute time, ms since the epoch, at which Vercel kills this invocation. */
  deadlineMs: number;
  nowMs?: () => number;
  /** The model turn. Injectable so the engine is tested with a scripted one. */
  turn: VoiceTurnFn;
  store: SessionStore;
  limits: SessionLimits;
  /** The first sentence, on a first connection only. Empty on a resume. */
  greeting: string;
  /** Where `transfer_to_human` dials, decided before the socket opened. */
  transferTo: string | null;
}

/* ------------------------------------------------------------------------ */
/*  The model turn, as the relay side calls it                                */
/* ------------------------------------------------------------------------ */

/**
 * What the engine hands the AI side for one exchange. The AI side already
 * knows the workspace, the agent and the contact — they were bound when the
 * bundle was built — so a call carries only what changed since: the transcript,
 * the state, and how much time is left before the function dies.
 */
export interface VoiceTurnCall {
  history: Turn[];
  state: SessionState;
  /** The `voice_sessions` row id, once the session is open, so the `ai_runs` row can name it. */
  sessionId?: string;
  /** 1-based count of assistant replies so far, this one included. */
  turn: number;
  /** How long the whole turn, tool rounds included, may take before the engine rotates. */
  budgetMs: number;
  nowMs: number;
  /** Called at the start of each model round, so the engine can time its filler. */
  onRound?: (n: number) => void;
}

export type VoiceTurnFn = (input: VoiceTurnCall) => Promise<VoiceTurnResult>;

export interface VoiceTurnResult {
  /**
   * What the assistant says. The engine speaks a fixed sentence for every
   * terminal action instead; a `language` action is the one that is not
   * terminal — the reply is spoken, in the new language, after the switch.
   */
  reply: string;
  action: null | { kind: 'transfer'; to: string } | { kind: 'end' } | { kind: 'voicemail' } | { kind: 'language'; code: string };
  /**
   * The language `switch_language` asked for on this turn, whatever the
   * action. A turn carries one action and the terminal ones (transfer, end,
   * voicemail) outrank the switch, so a model that switches and hangs up in
   * the same breath would otherwise have its farewell read in the old voice
   * and the row would forget the language. The engine reads this before it
   * acts on anything; null or absent means no switch.
   */
  language?: string | null;
  /** The state as the tools left it; the engine persists it as a patch. */
  state: SessionState;
  /** The `ai_runs` row for this turn, when one was written. */
  runId: string | null;
  booked: { appointmentId: string; startAt: Date } | null;
  usage: AiUsage;
  costUsd: number;
  model: string;
  latencyMs: number;
  /**
   * What the assistant looked up on this turn, name and result each cut to
   * 400 characters. The engine persists it as `Turn.tools` on the assistant
   * turn, and the next turn's history folds it back in — which is what lets
   * "the nine-thirty one" resolve without a second `list_free_slots`.
   */
  tools?: { name: string; result: string }[];
}

/**
 * Built once per session by `voiceTurnFor()` on the AI side: the turn function
 * with everything bound, plus the handful of settings the engine needs to
 * greet, cap and transfer. The relay side never sees the agent or the tools.
 */
export interface VoiceTurnBundle {
  turn: VoiceTurnFn;
  transferTo: string | null;
  greeting: string;
  maxTurns: number;
  maxMinutes: number;
  teamLang: Lang;
  contactId: string;
  /** The caller's number is not E.164 (withheld): no texts, no lookups, no data read back. */
  callerWithheld: boolean;
}
