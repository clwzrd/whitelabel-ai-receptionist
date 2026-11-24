import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { enableBlockedReason, loadAgent, loadConnection, startOfLocalDay } from '../../ai/config';
import { todaysRunTotals } from '../../ai/totals';
import { translator, type Lang } from '../../i18n';
import { alertSettingsOf } from '../../twilio/alerts';
import { callbackOrigin } from '../../twilio/voice';
import { getIntegration } from '../../integrations';
import type { VoiceSettings } from '../settings';
import { transferTarget } from './transfer';

/**
 * Whether the AI receptionist may answer a call right now, and why not.
 *
 * One function for two readers. The inbound route asks it before every call
 * it might hand over, and takes a hard problem as "no, ring the human or the
 * voicemail as before". The settings card asks it on render, and shows the
 * same list in words, so what the owner sees is what the phone will do — two
 * checks that could disagree is how an assistant gets switched on and never
 * picks up.
 *
 * Hard problems stop the assistant. Soft ones do not: with no calendar it
 * still takes messages and transfers, with no transfer number it still
 * books — but the owner should know what the caller is not being offered.
 */
export type ReadinessProblem =
  | 'ai-off'
  | 'agent-disabled'
  | 'no-llm-connection'
  | 'llm-not-proved'
  | 'no-public-origin'
  | 'cost-cap-reached'
  | 'minutes-cap-reached'
  | 'no-human-reachable'
  | 'no-calendar'
  | 'no-transfer-number'
  | 'languages-need-elevenlabs';

export interface Readiness {
  ok: boolean;
  hard: ReadinessProblem[];
  soft: ReadinessProblem[];
  /** The figures behind the two caps, for the card to show next to the sentence. */
  figures: ReadinessFigures;
}

export interface ReadinessFigures {
  /** Assistant talk time today, whole minutes, across every call in the workspace. */
  minutesToday: number;
  dailyMinutesCap: number;
  /** Model spend today at the workspace's rates, and the ceiling from Settings → AI. Zero cap means no ceiling. */
  costCentsToday: number;
  dailyCostCapCents: number;
  /** Where a transfer would go, or null when nobody can be rung. */
  transferTo: string | null;
}

export interface ReadinessOptions {
  /** The line that was dialled, for its forwarding number. Absent on the settings page. */
  dialedNumber?: string | null;
  nowMs?: number;
}

export async function voiceAiReadiness(
  db: Db,
  workspaceId: string,
  settings: VoiceSettings,
  opts: ReadinessOptions = {},
): Promise<Readiness> {
  const nowMs = opts.nowMs ?? Date.now();
  const hard: ReadinessProblem[] = [];
  const soft: ReadinessProblem[] = [];
  const figures: ReadinessFigures = {
    minutesToday: 0,
    dailyMinutesCap: settings.ai.dailyMinutesCap,
    costCentsToday: 0,
    dailyCostCapCents: 0,
    transferTo: null,
  };

  /*
   * Off is the ordinary state of every workspace, and the inbound route asks
   * this on every call. Nothing below is worth a query when the switch is
   * down, so the answer is one problem and no round trip.
   */
  if (!settings.ai.enabled) return { ok: false, hard: ['ai-off'], soft, figures };

  const [agent, connection, workspace, twilio] = await Promise.all([
    loadAgent(db, workspaceId),
    loadConnection(db, workspaceId),
    db
      .select({ timezone: schema.workspaces.timezone })
      .from(schema.workspaces)
      .where(eq(schema.workspaces.id, workspaceId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    getIntegration(db, workspaceId, 'twilio'),
  ]);
  const timezone = workspace?.timezone ?? 'America/Los_Angeles';
  figures.dailyCostCapCents = connection.settings.dailyCostCapCents;

  if (!agent || !agent.enabled) hard.push('agent-disabled');

  // The same verdict the SMS agent's own switch is gated on: a key, a test
  // that answered, and a model that returns usable tool calls. Without a key
  // the reason is "no connection"; anything else is "not proved yet".
  const blocked = enableBlockedReason(connection);
  if (blocked) hard.push(connection.apiKey ? 'llm-not-proved' : 'no-llm-connection');

  // Twilio has to reach the socket; a localhost origin is not a place it can dial.
  if (!callbackOrigin()) hard.push('no-public-origin');

  const [totals, minutesToday, transferTo] = await Promise.all([
    todaysRunTotals(db, workspaceId, timezone, connection.settings, nowMs),
    minutesSpokenToday(db, workspaceId, timezone, nowMs, settings.ai.maxMinutes),
    transferTarget(db, workspaceId, settings, opts.dialedNumber ?? null),
  ]);
  figures.costCentsToday = totals.costCents;
  figures.minutesToday = minutesToday;
  figures.transferTo = transferTo;

  if (connection.settings.dailyCostCapCents > 0 && totals.costCents >= connection.settings.dailyCostCapCents) hard.push('cost-cap-reached');
  if (minutesToday >= settings.ai.dailyMinutesCap) hard.push('minutes-cap-reached');

  /*
   * A fresh workspace in `always` mode with nobody to transfer to, nobody to
   * hand off to and nobody who gets an e-mail would answer every call and be
   * able to tell no one about any of them. That is a hard stop, not a
   * warning: the assistant's whole value is that a person hears about the
   * call afterwards.
   */
  const handoffPerson = Boolean(agent?.handoffUserId);
  if (!transferTo && !handoffPerson && !(await someoneGetsEmail(db, workspaceId, alertSettingsOf(twilio?.config)))) {
    hard.push('no-human-reachable');
  }

  if (!agent?.canBook || !agent.bookingCalendarId) soft.push('no-calendar');
  if (!transferTo) soft.push('no-transfer-number');
  /*
   * Twilio pairs automatic language detection with ElevenLabs only; the
   * TwiML builder drops the languages under any other provider rather than
   * send a combination Twilio refuses. So the assistant still answers — in
   * English — and the owner is told why the Spanish they ticked is not
   * happening.
   */
  if (settings.ai.languages.length > 0 && settings.ai.ttsProvider !== 'ElevenLabs') soft.push('languages-need-elevenlabs');

  return { ok: hard.length === 0, hard, soft, figures };
}

/**
 * Assistant talk time today, across every session of the workspace, whole
 * minutes. A session still open counts up to now, so a long call in progress
 * cannot let a second one start past the cap. Twilio bills ConversationRelay
 * by the minute of connection, which is what `started_at → ended_at` measures.
 *
 * An open row is bounded at `maxMinutes` plus one: no session can lawfully
 * run longer than the per-call cap, so a row still "live" past it is one
 * whose close never arrived (a webhook that timed out, a dial the caller
 * abandoned), and letting it count up to now for the rest of the day would
 * let one stuck row eat the whole cap and silence the receptionist until
 * midnight.
 */
async function minutesSpokenToday(db: Db, workspaceId: string, timezone: string, nowMs: number, maxMinutes: number): Promise<number> {
  const since = startOfLocalDay(timezone, nowMs);
  const bound = Math.max(1, Math.round(maxMinutes)) + 1;
  const [row] = await db
    .select({
      minutes: sql<number>`coalesce(sum(extract(epoch from (least(coalesce(${schema.voiceSessions.endedAt}, now()), ${schema.voiceSessions.startedAt} + make_interval(mins => ${bound}::int)) - ${schema.voiceSessions.startedAt}))), 0) / 60`,
    })
    .from(schema.voiceSessions)
    .where(and(eq(schema.voiceSessions.workspaceId, workspaceId), gte(schema.voiceSessions.startedAt, since)));
  return Math.floor(Number(row?.minutes ?? 0));
}

/**
 * Whether the unanswered-call alert would reach anybody by e-mail: a member
 * whose preference is e-mail (the default when nothing was chosen), or an
 * extra address. Mirrors the recipient logic of `sendUnansweredAlert`, which
 * is the path the team notification for an AI call goes down — and that path
 * sends nothing at all while alerts are switched off, extra addresses
 * included, so a workspace with alerts off has nobody reachable this way.
 */
async function someoneGetsEmail(db: Db, workspaceId: string, alerts: ReturnType<typeof alertSettingsOf>): Promise<boolean> {
  if (!alerts.enabled) return false;
  if (alerts.extraEmails.length) return true;
  if (alerts.to === 'custom') return false;
  const members = await db
    .select({ id: schema.workspaceMembers.userId, email: schema.user.email })
    .from(schema.workspaceMembers)
    .innerJoin(schema.user, eq(schema.user.id, schema.workspaceMembers.userId))
    .where(eq(schema.workspaceMembers.workspaceId, workspaceId));
  return members.some((m) => {
    if (!m.email) return false;
    const pref = alerts.members[m.id];
    return !pref || pref.channel === 'email' || pref.channel === 'both';
  });
}

/**
 * The problems in words, for the settings card and for the action's reply.
 * The keys are the English sentences, as everywhere in the CRM, so the
 * Portuguese entries live in the dictionary and a missing one shows English
 * rather than a blank. Each is a literal `t('…')` call on purpose: that is
 * what `scripts/i18n-keys.py` collects.
 */
export function readinessSentences(problems: ReadinessProblem[], lang: Lang, figures?: Partial<ReadinessFigures>): string[] {
  const t = translator(lang);
  const minutes = figures?.minutesToday ?? 0;
  const minutesCap = figures?.dailyMinutesCap ?? 0;
  const spent = ((figures?.costCentsToday ?? 0) / 100).toFixed(2);
  const cap = ((figures?.dailyCostCapCents ?? 0) / 100).toFixed(2);
  return problems.map((problem) => {
    switch (problem) {
      case 'ai-off':
        return t('The AI receptionist is switched off.');
      case 'agent-disabled':
        return t('The AI agent is disabled. Turn it on in Settings → AI; the receptionist speaks with the same agent.');
      case 'no-llm-connection':
        return t('No model is connected. Paste an API key in Settings → AI and press Test connection.');
      case 'llm-not-proved':
        return t('The model has not passed Test connection yet. Run it in Settings → AI before the receptionist can answer.');
      case 'no-public-origin':
        return t('The CRM has no public address for Twilio to reach, so no call can be connected to the receptionist.');
      case 'cost-cap-reached':
        return t('The AI has spent ${spent} today, which is the daily ceiling of ${cap}. Calls go to the person or to voicemail until midnight.', { spent, cap });
      case 'minutes-cap-reached':
        return t('The receptionist has talked for {minutes} of the {cap} minutes allowed today. Calls go to the person or to voicemail until midnight.', { minutes, cap: minutesCap });
      case 'no-human-reachable':
        return t('Nobody would hear about the calls: add a transfer number, a hand-off person in Settings → AI, or a team member who gets alerts by e-mail.');
      case 'no-calendar':
        return t('No booking calendar is chosen for the agent, so the receptionist takes messages but cannot book.');
      case 'no-transfer-number':
        return t('No transfer number: the receptionist cannot connect a caller to a person, only take a message.');
      case 'languages-need-elevenlabs':
        return t('Answering in other languages needs ElevenLabs as the voice provider. With Amazon or Google the receptionist speaks English only.');
    }
  });
}
