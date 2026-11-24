import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../../../db';
import { schema } from '../../../db';
import { credsOf, enableBlockedReason, loadAgent, loadConnection } from '../../ai/config';
import { VOICE_KIND, costUsd, priceFor } from '../../ai/cost';
import { providerFor } from '../../ai/provider';
import { record } from '../../ai/run';
import { todaysRunTotals } from '../../ai/totals';
import type { Ctx } from '../../core';
import { setActivityBody } from '../../core';
import { workspaceLang } from '../../i18n';
import { enterLang, scopedTranslator } from '../../i18n/scope';
import { backfillTranscript, callById, callerLabel } from '../store';
import { renderTranscript } from './close';
import { notifyTeamAboutCall, type NotifyOutcome } from './notify';
import { languageName, primaryTag, type SessionRow } from './types';
import { summaryBrief } from './brief';

/**
 * The call in three sentences, a minute after it ended.
 *
 * The transcript is the record; the summary is what a person reads on a
 * phone between two other calls. It is written by the same model that took
 * the call, off the critical path — this runs as a job, so a slow model
 * costs nobody a second of silence on the line — with a fixed prompt, no
 * tools and a small ceiling, and it is stored twice: on the call row, where
 * the calls screen shows it under the transcript, and on the session row,
 * where it belongs to the conversation that produced it.
 *
 * Whatever happens to the model, the team is told. A summary that could not
 * be written (no key, cap reached, timeout) is recorded as such and the
 * notice goes out with the caller's own first words instead; the one
 * failure this job must never have is a call nobody hears about.
 *
 * The summary is written in English whatever the team's interface language
 * and whatever language the call was in. Every workspace on this CRM is an
 * American business and its notes are English; the interface language is
 * one person's browser, not the record's. A call the assistant took in
 * Spanish says so on its last line ("Language: Spanish"), which is the one
 * fact about the call the transcript alone does not make obvious to someone
 * skimming three sentences.
 */

export type SummaryOutcome =
  | { done: true; summary: string; model: string; latencyMs: number; notified: NotifyOutcome }
  | { done: false; reason: 'call gone' | 'no session' | 'already summarized' | 'nothing said' | 'model unavailable' | 'cap reached' | 'model failed'; detail?: string; notified?: NotifyOutcome };

/** The system prompt is fixed so a provider cache can hit it on every call of the day. */
const SUMMARISER_FIXED = [
  'You summarize phone calls that an automated receptionist answered for a small business.',
  'Write exactly three short sentences: who called, what they wanted, what was done on the call.',
  'Then one final line that starts with "Next step:" saying what a person on the team should do now, or "Next step: nothing" if there is nothing to do.',
  'Use only what the transcript says. Never invent a name, a time, a price or a promise. Do not quote the transcript back.',
  'No headings, no lists, no markdown.',
].join('\n');

const SUMMARY_MAX_TOKENS = 200;
const SUMMARY_TIMEOUT_MS = 20_000;

export async function summarizeAiCall(db: Db, workspaceId: string, callId: string): Promise<SummaryOutcome> {
  const call = await callById(db, callId);
  // The workspace is checked against the row rather than trusted from the job: a job payload is data.
  if (!call || call.workspaceId !== workspaceId) return { done: false, reason: 'call gone' };

  const [session] = await db
    .select()
    .from(schema.voiceSessions)
    .where(and(eq(schema.voiceSessions.workspaceId, workspaceId), eq(schema.voiceSessions.callId, call.id)))
    .limit(1);
  if (!session) return { done: false, reason: 'no session' };
  const row = session as SessionRow;
  if (row.summary) return { done: false, reason: 'already summarized' };

  const [wsRow] = await db.select().from(schema.workspaces).where(eq(schema.workspaces.id, workspaceId)).limit(1);
  const teamLang = workspaceLang(wsRow?.settings);
  // The labels around the summary (the audit row's reason) follow the team's
  // language; the summary itself is English, see the note at the top.
  enterLang(teamLang);
  const t = scopedTranslator();
  const callLang = primaryTag(row.state.lang) && primaryTag(row.state.lang) !== 'en' ? languageName(row.state.lang) : null;

  const transcript = renderTranscript(row.turns);
  const spoke = row.turns.some((turn) => turn.role === 'user' && turn.text.trim());
  if (!spoke) {
    // Nothing to summarise, but a failed session is still worth a person's attention.
    const notified = await notifyTeamAboutCall(db, workspaceId, { call, session: row, summary: null });
    return { done: false, reason: 'nothing said', notified };
  }

  const [connection, agent] = await Promise.all([loadConnection(db, workspaceId), loadAgent(db, workspaceId)]);
  const blocked = enableBlockedReason(connection);
  if (blocked) return await giveUp(db, workspaceId, call, row, 'model unavailable', blocked.key);

  const { settings } = connection;
  if (settings.dailyCostCapCents > 0) {
    const totals = await todaysRunTotals(db, workspaceId, wsRow?.timezone ?? 'America/Los_Angeles', settings);
    if (totals.costCents >= settings.dailyCostCapCents) return await giveUp(db, workspaceId, call, row, 'cap reached');
  }

  const started = Date.now();
  const who = callerLabel(call);
  // What the caller said before a transfer, kept on the session by `transfer_to_human`.
  const intake = summaryBrief(row.state.caller);
  const variable = [
    `Business: ${wsRow?.name ?? ''}.`,
    `Caller: ${who}${call.fromNumber ? ` (${call.fromNumber})` : ''}.`,
    ...(intake ? [`Before the transfer the caller said: ${intake}`] : []),
    `Outcome recorded by the system: ${row.outcome ?? 'unknown'}${row.endReason ? `, ended because: ${row.endReason}` : ''}.`,
    callLang
      ? `The call was conducted in ${callLang}. Write the summary in US English anyway; keep names, e-mail addresses and times as spoken.`
      : 'Write the summary in US English.',
  ].join('\n');

  try {
    const creds = credsOf(connection);
    const provider = await providerFor(creds.provider);
    const result = await provider.complete(creds, {
      systemFixed: SUMMARISER_FIXED,
      systemVariable: variable,
      messages: [{ role: 'user', content: [{ type: 'text', text: `Transcript:\n${transcript.slice(0, 12_000)}` }] }],
      tools: [],
      maxTokens: SUMMARY_MAX_TOKENS,
      timeoutMs: SUMMARY_TIMEOUT_MS,
      reasoning: 'off',
    });
    const written = result.text.trim().slice(0, 1400);
    // Stamped by the code, not asked of the model: the language and what the
    // caller gave before the transfer are facts the session recorded, and a
    // model that forgot the line would hide them.
    const stamped = [written, ...(written && intake ? [intake] : []), ...(written && callLang ? [`Language: ${callLang}`] : [])];
    const summary = stamped.join('\n');
    const latencyMs = Date.now() - started;
    const model = result.model || creds.model;
    const usd = costUsd(result.usage, priceFor(model, settings));
    if (!summary) throw new Error('The model returned an empty summary.');

    await db.update(schema.calls).set({ summary }).where(eq(schema.calls.id, call.id));
    await db
      .update(schema.voiceSessions)
      .set({ summary, costCents: sql`${schema.voiceSessions.costCents} + ${Math.round(usd * 100)}` })
      .where(and(eq(schema.voiceSessions.workspaceId, workspaceId), eq(schema.voiceSessions.id, row.id)));
    await record({
      db,
      workspaceId,
      agentId: agent?.id ?? null,
      contactId: call.contactId,
      conversationId: call.conversationId,
      messageId: null,
      decision: 'ignored',
      reason: t('Summary of the call with {who}', { who }),
      prompt: { kind: VOICE_KIND, stage: 'summary', callId: call.id, sessionId: row.id, costUsd: usd, transcriptChars: transcript.length },
      output: summary,
      model,
      usage: result.usage,
      costUsd: usd,
      latencyMs,
    });

    /*
     * The timeline entry and the inbox message were filed the moment the
     * call ended, the entry without a body (the transcript reaches the call
     * row a beat later). The entry gets the summary first, with the
     * transcript under it, because a timeline is read top-down and the three
     * sentences are the point; `backfillTranscript` then fills whatever was
     * left empty by a write that failed at `relay-done` — it only writes an
     * empty body, so the summary just placed is not touched.
     */
    await putSummaryOnActivity(db, workspaceId, call.id, summary, transcript);
    await backfillTranscript(db, call, transcript);

    const fresh = (await callById(db, call.id)) ?? call;
    const notified = await notifyTeamAboutCall(db, workspaceId, { call: fresh, session: { ...row, summary }, summary });
    return { done: true, summary, model, latencyMs, notified };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await record({
      db,
      workspaceId,
      agentId: agent?.id ?? null,
      contactId: call.contactId,
      conversationId: call.conversationId,
      messageId: null,
      decision: 'failed',
      reason: t('Summary of the call with {who}', { who }),
      prompt: { kind: VOICE_KIND, stage: 'summary', callId: call.id, sessionId: row.id },
      model: settings.model,
      latencyMs: Date.now() - started,
      error: detail.slice(0, 500),
    }).catch(() => undefined);
    return await giveUp(db, workspaceId, call, row, 'model failed', detail);
  }
}

/** No summary, but the transcript is on the record and the team hears about the call anyway. */
async function giveUp(
  db: Db,
  workspaceId: string,
  call: NonNullable<Awaited<ReturnType<typeof callById>>>,
  row: SessionRow,
  reason: 'model unavailable' | 'cap reached' | 'model failed',
  detail?: string,
): Promise<SummaryOutcome> {
  try {
    await backfillTranscript(db, call, renderTranscript(row.turns));
  } catch (error) {
    console.error('[relay/summary] backfill', error);
  }
  const fresh = (await callById(db, call.id)) ?? call;
  const notified = await notifyTeamAboutCall(db, workspaceId, { call: fresh, session: row, summary: null });
  return { done: false, reason, ...(detail ? { detail } : {}), notified };
}

/**
 * The summary first, then the transcript, on the one timeline entry the
 * call has. `setActivityBody` writes only an empty body, which is the usual
 * case; when the entry already carries the bare transcript (a retry of this
 * job after the backfill ran, or `voice-status` filing it with the words
 * already on the row) the same text is replaced. Anything else in the body
 * was typed by a person and stays.
 */
async function putSummaryOnActivity(db: Db, workspaceId: string, callId: string, summary: string, transcript: string): Promise<boolean> {
  const [activity] = await db
    .select({ id: schema.activities.id, body: schema.activities.body })
    .from(schema.activities)
    .where(and(eq(schema.activities.workspaceId, workspaceId), eq(schema.activities.type, 'call'), sql`${schema.activities.meta} ->> 'callId' = ${callId}`))
    .orderBy(sql`${schema.activities.createdAt} desc`)
    .limit(1);
  if (!activity) return false;
  const body = `${summary}\n\n${transcript}`.slice(0, 2000);
  const ctx: Ctx = { db, workspaceId, actorId: null };
  if (await setActivityBody(ctx, activity.id, body)) return true;
  if (activity.body !== transcript.slice(0, 2000)) return false;
  const changed = await db
    .update(schema.activities)
    .set({ body })
    .where(and(eq(schema.activities.id, activity.id), eq(schema.activities.workspaceId, workspaceId), eq(schema.activities.body, activity.body)))
    .returning({ id: schema.activities.id });
  return changed.length > 0;
}
