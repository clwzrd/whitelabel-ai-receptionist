import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryCrm } from './crm/memory.ts';
import { runTool, spokenTime, toolDefs, type ToolContext } from './tools.ts';

/* The rules that hold whatever the model decides. */

async function context(over: Partial<ToolContext> = {}): Promise<ToolContext & { crm: MemoryCrm }> {
  const crm = new MemoryCrm({ business: { name: 'Acme', timezone: 'America/New_York', appointmentName: 'a discovery call' } });
  return { crm, facts: await crm.business(), state: { transferAttempts: 0 }, caller: null, phone: '+13105550142', transferTo: null, languages: ['es-US'], nowMs: Date.now(), ...over } as ToolContext & { crm: MemoryCrm };
}

test('a time is booked only if it was offered on this call, the caller has a name, and it is still open', async () => {
  const ctx = await context();
  const anyTime = (await ctx.crm.openSlots({ fromIso: new Date().toISOString(), toIso: new Date(Date.now() + 14 * 86_400_000).toISOString(), limit: 1 }))[0]!.startIso;
  assert.match((await runTool(ctx, 'book_appointment', { start: anyTime })).text, /not offered on this call/);

  const listed = await runTool(ctx, 'list_open_times', {});
  assert.match(listed.text, /^Open times/);
  const start = ctx.state.offered![0]!.startIso;
  assert.match(listed.text, new RegExp(`\\[${start.replace(/[.]/g, '\\.')}\\]`), 'the exact instant travels with the spoken time');
  assert.match((await runTool(ctx, 'book_appointment', { start })).text, /A name is needed/);

  assert.match((await runTool(ctx, 'save_caller_details', { email: 'not-an-email' })).text, /does not look like an e-mail/);
  assert.match((await runTool(ctx, 'save_caller_details', { name: 'Dana Whitfield', email: 'Dana@Example.com' })).text, /^Saved/);
  assert.equal(ctx.caller?.email, 'dana@example.com');

  const booked = await runTool(ctx, 'book_appointment', { start });
  assert.match(booked.text, /^Booked a discovery call for /);
  assert.ok(booked.booked?.appointmentId);
  assert.equal(ctx.crm.appointments.size, 1);

  // Somebody else took the next one between the offer and the yes.
  const second = ctx.state.offered![1]!.startIso;
  const other = await ctx.crm.saveCaller({ name: 'Somebody Else', phone: '+13105550143' });
  await ctx.crm.book({ callerId: other.id, startIso: second });
  assert.match((await runTool(ctx, 'book_appointment', { start: second })).text, /just taken/);
});

test('moving and canceling act on the caller’s own upcoming appointment and say what the engine listens for', async () => {
  const ctx = await context();
  await runTool(ctx, 'save_caller_details', { name: 'Dana Whitfield' });
  assert.match((await runTool(ctx, 'cancel_appointment', {})).text, /no upcoming appointment/);
  await runTool(ctx, 'list_open_times', {});
  const [first, second] = ctx.state.offered!;
  await runTool(ctx, 'book_appointment', { start: first!.startIso });
  assert.match((await runTool(ctx, 'look_up_caller', {})).text, /On file: Dana Whitfield.*Upcoming: a discovery call with Dana Whitfield/);
  assert.match((await runTool(ctx, 'reschedule_appointment', { start: second!.startIso })).text, /^Moved\b/);
  assert.equal((await ctx.crm.appointmentsFor(ctx.caller!.id))[0]!.startIso, second!.startIso);
  assert.match((await runTool(ctx, 'cancel_appointment', { reason: 'changed plans' })).text, /^Canceled\b/);
  assert.equal((await ctx.crm.appointmentsFor(ctx.caller!.id)).length, 0);
});

test('the tool list follows the line: no look-up for a hidden number, no language switch on an English-only line', async () => {
  const names = (ctx: Pick<ToolContext, 'phone' | 'languages'>) => toolDefs(ctx).map((t) => t.name);
  assert.ok(names({ phone: '+13105550142', languages: ['es-US'] }).includes('look_up_caller'));
  assert.ok(names({ phone: '+13105550142', languages: ['es-US'] }).includes('switch_language'));
  assert.equal(names({ phone: null, languages: [] }).includes('look_up_caller'), false);
  assert.equal(names({ phone: null, languages: [] }).includes('switch_language'), false);

  const ctx = await context();
  assert.deepEqual((await runTool(ctx, 'switch_language', { code: 'es-US' })).action, { kind: 'language', code: 'es-US' });
  assert.deepEqual((await runTool(ctx, 'switch_language', { code: 'en-US' })).action, { kind: 'language', code: 'en-US' }, 'English is always allowed back');
  assert.equal((await runTool(ctx, 'switch_language', { code: 'ja-JP' })).action, undefined);
  assert.match((await runTool(ctx, 'transfer_to_human', { reason: 'x' })).text, /Nobody can take the call/);
  assert.deepEqual((await runTool({ ...ctx, transferTo: '+13105550199' }, 'transfer_to_human', { reason: 'x' })).action, { kind: 'transfer', to: '+13105550199' });
  assert.match((await runTool(ctx, 'normalize_spoken_email', { spoken: 'jane dot doe at example dot com' })).text, /Written: jane\.doe@example\.com/);
});

test('times are spoken in the business’s own timezone', () => {
  assert.equal(spokenTime('2026-06-01T13:00:00.000Z', 'America/New_York'), 'Monday, June 1 at 9:00 AM');
  assert.equal(spokenTime('2026-06-01T13:00:00.000Z', 'America/Los_Angeles'), 'Monday, June 1 at 6:00 AM');
});
