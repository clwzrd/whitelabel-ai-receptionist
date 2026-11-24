import { existsSync, readFileSync } from 'node:fs';
import { aiCreds } from './config';
import { MemoryCrm } from './crm/memory';
import { env } from './env';
import type { SessionState, Turn } from './engine/types';
import { createTurn } from './turn';

/**
 * Talk to the assistant in text, with no phone and no Twilio.
 *
 *   npm run try -- "Hi, I'd like to book a call. I'm Dana Whitfield." "The first one works." "That's all, bye."
 *
 * Each argument is one thing the caller says. The real model you configured
 * answers, calling its tools against an in-memory CRM, and the script prints
 * what it said, which tools it used and what ended up booked. It is the
 * quickest way to see whether a model is good enough for the phone before
 * putting a number in front of it: only AI_PROVIDER (or AI_BASE_URL),
 * AI_MODEL and a key are needed.
 */
if (existsSync('.env')) {
  for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
}

const said = process.argv.slice(2);
if (!said.length) {
  console.error('Give at least one thing the caller says, in quotes.');
  process.exit(1);
}

const crm = new MemoryCrm({ business: { name: env('BUSINESS_NAME') ?? 'Acme Plumbing', timezone: env('BUSINESS_TIMEZONE') ?? 'America/New_York', hours: env('BUSINESS_HOURS') ?? 'Monday to Friday, 9 a.m. to 5 p.m.', knowledge: env('BUSINESS_KNOWLEDGE') ?? '', appointmentName: env('APPOINTMENT_NAME') ?? 'a discovery call' } });
const creds = aiCreds();
const turn = createTurn({ crm, creds, phone: '+13105550142', persona: env('PERSONA') ?? '', transferTo: env('TRANSFER_TO') ?? null, languages: [], priceIn: Number(env('AI_PRICE_IN') ?? 0) || 0, priceOut: Number(env('AI_PRICE_OUT') ?? 0) || 0 });

const history: Turn[] = [{ role: 'assistant', text: 'Hi, thanks for calling. I am the AI assistant here. How can I help you today?', ts: Date.now() }];
let state: SessionState = { transferAttempts: 0 };
let cost = 0;
let failed = false;

for (const [index, words] of said.entries()) {
  console.log(`\ncaller    > ${words}`);
  history.push({ role: 'user', text: words, ts: Date.now() });
  try {
    const result = await turn({ history: [...history], state, turn: index + 1, budgetMs: 30_000, nowMs: Date.now() });
    state = result.state;
    cost += result.costUsd;
    for (const tool of result.tools ?? []) console.log(`  tool    : ${tool.name} → ${tool.result.slice(0, 160)}`);
    console.log(`assistant > ${result.reply || '(nothing spoken)'}${result.action ? `   [action: ${JSON.stringify(result.action)}]` : ''}`);
    console.log(`  model   : ${result.model} · ${result.latencyMs} ms`);
    history.push({ role: 'assistant', text: result.reply, ts: Date.now(), tools: result.tools });
    if (result.action?.kind === 'end' || result.action?.kind === 'transfer') break;
  } catch (error) {
    failed = true;
    console.log(`  ERROR   : ${error instanceof Error ? error.message : error}`);
    break;
  }
}

console.log('\n--- what the CRM holds now');
console.log(`callers      : ${[...crm.callers.values()].map((c) => `${c.name ?? '(no name)'} ${c.email ?? ''}`.trim()).join('; ') || 'none'}`);
console.log(`appointments : ${[...crm.appointments.values()].filter((a) => !a.canceled).map((a) => `${a.title} at ${a.startIso}`).join('; ') || 'none'}`);
console.log(`messages     : ${crm.messages.map((m) => m.text).join('; ') || 'none'}`);
if (cost) console.log(`cost         : US$ ${cost.toFixed(4)}`);
process.exit(failed ? 1 : 0);
