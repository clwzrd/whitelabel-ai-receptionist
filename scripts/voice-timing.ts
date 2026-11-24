/**
 * Quanto tempo a recepcionista leva para responder, com o modelo de verdade.
 *
 *     npx --yes tsx scripts/voice-timing.ts [--workspace <slug>]
 *
 * O canário do §8.4.3 do plano: antes da primeira ligação real, cinco frases
 * de quem liga passam pela volta de modelo de produção (`runVoiceTurn`, com
 * prompt, ferramentas e gravação em `ai_runs`) contra o provedor que a
 * workspace escolheu. Mede-se o que a pessoa ao telefone sente — do fim da
 * frase dela ao início da resposta — e o veredito é um número: p50 acima de
 * 4 s é um modelo lento demais para telefone, e a workspace troca o modelo
 * antes de atender alguém.
 *
 * Tudo roda numa workspace descartável que copia da escolhida só o que a
 * volta precisa (a conexão com o modelo e o agente) e é apagada no fim, para
 * que as cinco execuções não apareçam em "O que a assistente fez" da
 * workspace de verdade. Modo `dry`: nenhuma ferramenta manda SMS ou e-mail.
 * O que sai de casa é só a pergunta ao modelo, cobrada como qualquer outra.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { asc, eq } from 'drizzle-orm';

function loadEnv(path: string): Record<string, string> {
  try {
    const out: Record<string, string> = {};
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
    }
    return out;
  } catch {
    return {};
  }
}
const here = resolve(import.meta.dirname ?? '.', '..');
for (const [k, v] of Object.entries(loadEnv(resolve(here, '.env')))) if (!process.env[k]) process.env[k] = v;

const { getDb, schema } = await import('../src/db/index.ts');
const { createWorkspace, findOrCreateContact } = await import('../src/lib/core.ts');
const { getIntegration, saveIntegration } = await import('../src/lib/integrations/index.ts');
const { loadAgent, loadConnection, enableBlockedReason } = await import('../src/lib/ai/config.ts');
const { voiceTurnFor } = await import('../src/lib/ai/voice.ts');
const { loadVoiceSettings } = await import('../src/lib/voice/settings.ts');
type Turn = import('../src/lib/voice/relay/types.ts').Turn;
type SessionState = import('../src/lib/voice/relay/types.ts').SessionState;

const db = getDb();

/** The five things a caller says most, in the order a booking call goes. Fixed, so two runs compare. */
const PROMPTS = [
  'Hi, what are your hours?',
  'How much does the first consultation cost?',
  "I'd like to book a call sometime this week.",
  'Can you text me the link instead?',
  "Thanks, that's all. Goodbye.",
];

/** Anything slower than this at the median is a caller listening to silence. */
const P50_LIMIT_MS = 4000;

const args = process.argv.slice(2);
const wantedSlug = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;

const [source] = wantedSlug
  ? await db.select().from(schema.workspaces).where(eq(schema.workspaces.slug, wantedSlug)).limit(1)
  : await db.select().from(schema.workspaces).orderBy(asc(schema.workspaces.createdAt)).limit(1);
if (!source) throw new Error(wantedSlug ? `no workspace with slug ${wantedSlug}` : 'no workspace in the database');

const connection = await loadConnection(db, source.id);
const blocked = enableBlockedReason(connection);
if (blocked) throw new Error(`the workspace ${source.slug} cannot run the model: ${blocked.key}`);
const sourceAgent = await loadAgent(db, source.id);
if (!sourceAgent) throw new Error(`the workspace ${source.slug} has no agent; open Settings → AI once`);
const modelRow = await getIntegration(db, source.id, 'anthropic');

const [owner] = await db.select().from(schema.user).orderBy(asc(schema.user.createdAt)).limit(1);
if (!owner) throw new Error('no user to own the throwaway workspace');
const ws = await createWorkspace(db, { name: `zz voice timing ${Math.random().toString(36).slice(2, 6)}`, ownerId: owner.id, timezone: source.timezone });
console.log(`workspace ${source.slug} → model ${connection.settings.model} (${connection.settings.provider}), key from ${connection.keySource}`);
console.log(`throwaway ${ws.slug}\n`);

try {
  await db.update(schema.workspaces).set({ name: source.name, settings: source.settings }).where(eq(schema.workspaces.id, ws.id));
  await saveIntegration(db, ws.id, 'anthropic', { enabled: true, config: modelRow?.config ?? {}, secrets: { apiKey: connection.apiKey ?? '' } });
  await saveIntegration(db, ws.id, 'twilio', { enabled: true, secrets: { accountSid: 'ACtiming', authToken: 'timing' } });
  /* The agent as the workspace wrote it — persona, goal, knowledge, rules —
   * minus what belongs to the other workspace's rows (its calendar, its
   * hand-off person). `canBook` is off so `list_free_slots` cannot run
   * against a calendar this copy does not have. */
  const { id: _id, workspaceId: _ws, createdAt: _c, updatedAt: _u, bookingCalendarId: _cal, handoffUserId: _h, ...agentFields } = sourceAgent;
  await db.insert(schema.aiAgents).values({ ...agentFields, workspaceId: ws.id, enabled: true, canBook: false, handoffUserId: owner.id });
  await db.insert(schema.phoneNumbers).values({ workspaceId: ws.id, number: '+13102009999', voice: true, sms: true, isDefault: true, trial: false });

  const ctx = { db, workspaceId: ws.id, actorId: null };
  const { contact } = await findOrCreateContact(ctx, { phone: '+13102000001', source: 'phone' });
  const [call] = await db
    .insert(schema.calls)
    .values({ workspaceId: ws.id, contactId: contact.id, direction: 'in', fromNumber: '+13102000001', toNumber: '+13102009999', status: 'in-progress', providerId: 'CAtiming', meta: { routed: 'ai' } })
    .returning();

  const settings = await loadVoiceSettings(db, ws.id);
  const bundle = await voiceTurnFor(db, call!, { ...settings, ai: { ...settings.ai, enabled: true, mode: 'always' } }, { dry: true });

  const history: Turn[] = [{ role: 'assistant', text: bundle.greeting, ts: Date.now() }];
  let state: SessionState = { transferAttempts: 0 };
  const latencies: number[] = [];

  for (const [i, prompt] of PROMPTS.entries()) {
    history.push({ role: 'user', text: prompt, ts: Date.now() });
    const started = Date.now();
    let rounds = 0;
    const result = await bundle.turn({ history, state, turn: i + 1, budgetMs: 60_000, nowMs: Date.now(), onRound: () => void rounds++ });
    const felt = Date.now() - started;
    latencies.push(felt);
    state = result.state;
    history.push({ role: 'assistant', text: result.reply, ts: Date.now() });
    const action = result.action ? ` → ${result.action.kind}` : '';
    console.log(`${String(i + 1)}. "${prompt}"`);
    console.log(`   ${(felt / 1000).toFixed(1)} s felt · ${(result.latencyMs / 1000).toFixed(1)} s in the turn · ${rounds} round(s) · ${result.model} · $${result.costUsd.toFixed(4)}${action}`);
    console.log(`   ${result.reply.slice(0, 160)}${result.reply.length > 160 ? '…' : ''}\n`);
    if (result.action) break;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  const p50 = p(0.5);
  const p90 = p(0.9);
  console.log(`p50 ${(p50 / 1000).toFixed(1)} s · p90 ${(p90 / 1000).toFixed(1)} s · ${latencies.length} turn(s)`);
  if (p50 > P50_LIMIT_MS) {
    console.log(`\nTOO SLOW: the median is above ${P50_LIMIT_MS / 1000} s. Switch the workspace's model in Settings → AI before the first real call (a non-reasoning model, or Amazon-only TTS).`);
    process.exitCode = 1;
  } else {
    console.log('\nok: fast enough for the phone at the median; the filler covers the tail.');
  }
} finally {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
  console.log('throwaway workspace deleted');
}
