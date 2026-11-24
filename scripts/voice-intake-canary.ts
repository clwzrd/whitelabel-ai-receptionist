/**
 * A recepcionista pede nome e empresa antes de transferir? Com o modelo de verdade.
 *
 *     npx --yes tsx scripts/voice-intake-canary.ts [--workspace <slug>] [--write]
 *
 * O canário da regra de 2026-09-15 (coletar nome, empresa e pedido antes de
 * passar a ligação; falar isso a quem atende; gravar no CRM se for lead).
 * Uma pessoa liga querendo falar com alguém sobre redes sociais; o roteiro
 * responde ao que a assistente perguntar — dá nome e empresa quando ela
 * pedir, insiste em falar com alguém quando não pedir — e o veredito é o
 * que a ferramenta `transfer_to_human` recebeu: sem nome e empresa no
 * `state.caller`, ou sem `isLead`, a regra não pegou no modelo da workspace.
 *
 * Roda numa workspace descartável (mesmo desenho de `voice-timing.ts`). Sem
 * `--write`, em modo `dry`: nenhuma escrita no CRM, nenhum SMS. Com
 * `--write`, as ferramentas escrevem de verdade NA DESCARTÁVEL e o script
 * confere o que `fileCallerIntake` deixou lá (nome e empresa no contato, a
 * tag "veio do telefone", a oportunidade no pipeline padrão e a nota "O que
 * o cliente quer") antes de apagar a workspace com tudo dentro. O que sai de
 * casa é só a pergunta ao modelo, cobrada como qualquer outra (alguns
 * centavos).
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
const { whisperBrief } = await import('../src/lib/voice/relay/brief.ts');
const { WANTS_NOTE_TITLE } = await import('../src/lib/voice/intake.ts');
const { TAG } = await import('../src/lib/tags.ts');
type Turn = import('../src/lib/voice/relay/types.ts').Turn;
type SessionState = import('../src/lib/voice/relay/types.ts').SessionState;

const db = getDb();

/** What the caller says, chosen by what the assistant just asked. */
function callerSays(lastReply: string, turn: number): string {
  const asked = /\b(your name|who('s| is) calling|name and (the )?(company|business|organization)|which (company|business|organization)|company (are you|you're) with)\b/i.test(lastReply);
  if (turn === 1) return "Hi, I'd like to speak with someone about getting help with our social media.";
  if (asked) return "Sure. This is Dana Carter, I'm with Riverside Community Church in Springfield, Texas. We need someone to run our Facebook and Instagram.";
  return 'Can you just put me through to a person, please?';
}

const args = process.argv.slice(2);
const wantedSlug = args.includes('--workspace') ? args[args.indexOf('--workspace') + 1] : null;
const write = args.includes('--write');

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
const ws = await createWorkspace(db, { name: `zz voice intake ${Math.random().toString(36).slice(2, 6)}`, ownerId: owner.id, timezone: source.timezone });
console.log(`workspace ${source.slug} → model ${connection.settings.model} (${connection.settings.provider}), key from ${connection.keySource}`);
console.log(`throwaway ${ws.slug}\n`);

let ok = false;
try {
  await db.update(schema.workspaces).set({ name: source.name, settings: source.settings }).where(eq(schema.workspaces.id, ws.id));
  await saveIntegration(db, ws.id, 'anthropic', { enabled: true, config: modelRow?.config ?? {}, secrets: { apiKey: connection.apiKey ?? '' } });
  await saveIntegration(db, ws.id, 'twilio', { enabled: true, secrets: { accountSid: 'ACintake', authToken: 'intake' } });
  const { id: _id, workspaceId: _ws, createdAt: _c, updatedAt: _u, bookingCalendarId: _cal, handoffUserId: _h, ...agentFields } = sourceAgent;
  await db.insert(schema.aiAgents).values({ ...agentFields, workspaceId: ws.id, enabled: true, canBook: false, handoffUserId: owner.id });
  await db.insert(schema.phoneNumbers).values({ workspaceId: ws.id, number: '+13102009999', voice: true, sms: true, isDefault: true, trial: false });

  const ctx = { db, workspaceId: ws.id, actorId: null };
  // A nameless contact, the way a first-time caller arrives without caller-name lookup.
  const { contact } = await findOrCreateContact(ctx, { phone: '+13102000002', source: 'call' });
  const [call] = await db
    .insert(schema.calls)
    .values({ workspaceId: ws.id, contactId: contact.id, direction: 'in', fromNumber: '+13102000002', toNumber: '+13102009999', status: 'in-progress', providerId: 'CAintake', meta: { routed: 'ai' } })
    .returning();

  const settings = await loadVoiceSettings(db, ws.id);
  // Somebody to transfer to, so the tool is offered; the number is never dialled in a dry run.
  const bundle = await voiceTurnFor(db, call!, { ...settings, ai: { ...settings.ai, enabled: true, mode: 'always', transferTo: '+13102000199' } }, { dry: !write });
  if (!bundle.transferTo) throw new Error('no transfer target: the tool would not be offered');

  const history: Turn[] = [{ role: 'assistant', text: bundle.greeting, ts: Date.now() }];
  let state: SessionState = { transferAttempts: 0 };
  let lastReply = bundle.greeting;
  let total = 0;
  console.log(`   assistant: ${bundle.greeting}\n`);

  for (let turn = 1; turn <= 6; turn++) {
    const said = callerSays(lastReply, turn);
    history.push({ role: 'user', text: said, ts: Date.now() });
    const result = await bundle.turn({ history, state, turn, budgetMs: 60_000, nowMs: Date.now() });
    state = result.state;
    total += result.costUsd;
    history.push({ role: 'assistant', text: result.reply, ts: Date.now() });
    lastReply = result.reply;
    console.log(`${turn}. caller: ${said}`);
    for (const t of result.tools ?? []) console.log(`   tool ${t.name} → ${t.result.slice(0, 140).replace(/\n/g, ' ')}`);
    console.log(`   assistant: ${result.reply || '(no words)'}${result.action ? `  → ${result.action.kind}` : ''}  [${(result.latencyMs / 1000).toFixed(1)} s, $${result.costUsd.toFixed(4)}]\n`);
    if (result.action) break;
  }

  const caller = state.caller;
  console.log(`state.caller: ${JSON.stringify(caller ?? null)}`);
  console.log(`whisper: "${whisperBrief(caller)}"`);
  console.log(`cost: $${total.toFixed(4)}`);
  const problems: string[] = [];
  if (!caller) problems.push('the transfer never happened, or happened without the intake');
  else {
    if (!/dana/i.test(caller.name ?? '')) problems.push(`name not captured: ${JSON.stringify(caller.name ?? null)}`);
    if (!/well/i.test(caller.company ?? '')) problems.push(`company not captured: ${JSON.stringify(caller.company ?? null)}`);
    if (!caller.wants) problems.push('no reason for the person picking up');
    if (caller.lead !== true) problems.push('a prospect asking about the services was not marked as a lead');
  }
  if (write && caller) {
    // What the tool left on the throwaway CRM, read back the way the team would see it.
    const [row] = await db.select().from(schema.contacts).where(eq(schema.contacts.id, contact.id)).limit(1);
    const opps = await db.select({ title: schema.opportunities.title, status: schema.opportunities.status }).from(schema.opportunities).where(eq(schema.opportunities.contactId, contact.id));
    const notes = await db
      .select({ title: schema.activities.title, body: schema.activities.body, opportunityId: schema.activities.opportunityId })
      .from(schema.activities)
      .where(eq(schema.activities.contactId, contact.id));
    const wants = notes.filter((n) => n.title === WANTS_NOTE_TITLE);
    console.log(`\nfiled: contact "${row?.firstName} ${row?.lastName}" · company ${JSON.stringify(row?.company ?? null)} · tags ${JSON.stringify(row?.tags ?? [])}`);
    console.log(`filed: ${opps.length} opportunity(ies) ${JSON.stringify(opps)}`);
    console.log(`filed: ${wants.length} "${WANTS_NOTE_TITLE}" note(s) ${JSON.stringify(wants.map((n) => n.body))}`);
    if (!/dana/i.test(row?.firstName ?? '')) problems.push('the name was not written on the contact');
    if (!/well/i.test(row?.company ?? '')) problems.push('the company was not written on the contact');
    if (!(row?.tags ?? []).includes(TAG.FROM_PHONE)) problems.push(`the tag "${TAG.FROM_PHONE}" was not added`);
    if (opps.length !== 1 || opps[0]!.status !== 'open') problems.push('no open opportunity in the default pipeline');
    if (wants.length !== 1 || !wants[0]!.body) problems.push(`no "${WANTS_NOTE_TITLE}" note`);
    else if (!wants[0]!.opportunityId) problems.push('the note is not attached to the opportunity');
  }
  if (problems.length) {
    console.log(`\nNOT OK:\n- ${problems.join('\n- ')}`);
    process.exitCode = 1;
  } else {
    ok = true;
    console.log('\nok: the assistant asked, the caller answered, and the transfer carried name, company, reason and lead.');
  }
} finally {
  await db.delete(schema.workspaces).where(eq(schema.workspaces.id, ws.id));
  console.log(`throwaway workspace deleted${ok ? '' : ' (see above)'}`);
}
