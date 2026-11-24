import assert from 'node:assert/strict';
import { test } from 'node:test';
import { summaryBrief, whisperBrief } from './brief.ts';

/*
 * What the colleague hears before the bridge, and what the summary carries,
 * from what the caller said before the transfer.
 */

test('the whisper: who, from where, what for — one sentence in spoken order', () => {
  assert.equal(
    whisperBrief({ name: 'Dana Carter', company: 'Riverside Community Church', wants: 'Managing their Facebook, YouTube and Instagram.', lead: true }),
    'New business: Dana Carter from Riverside Community Church, about managing their Facebook, YouTube and Instagram.',
  );
  assert.equal(whisperBrief({ name: 'Maria Lopez', wants: 'A question about her invoice.' }), 'Maria Lopez, about a question about her invoice.');
  assert.equal(whisperBrief({ name: 'Maria Lopez' }), 'Maria Lopez.');
  assert.equal(whisperBrief({ company: 'Acme Roofing', wants: 'A quote' }), 'Someone from Acme Roofing, about a quote.');
  assert.equal(whisperBrief({ wants: 'A callback about the contract.' }), 'The caller is asking about a callback about the contract.');
});

test('the whisper: nothing given is an empty string, so the old sentence stands alone', () => {
  assert.equal(whisperBrief(undefined), '');
  assert.equal(whisperBrief(null), '');
  assert.equal(whisperBrief({}), '');
  assert.equal(whisperBrief({ name: '  ', company: '', wants: ' ' }), '');
  assert.equal(whisperBrief({ lead: true }), '', 'a bare "new business" with nobody named says nothing');
});

test('the whisper: trailing punctuation, line breaks and length are tamed; an acronym keeps its capitals', () => {
  assert.equal(whisperBrief({ name: 'Bob.', wants: 'HVAC service for two units!!' }), 'Bob, about HVAC service for two units.');
  assert.equal(whisperBrief({ name: 'Ann', wants: 'Line one\nline two\t\ttabbed' }), 'Ann, about line one line two tabbed.');
  const long = whisperBrief({ name: 'Ann', wants: 'x'.repeat(400) });
  assert.ok(long.length < 200, `cut to something a colleague can wait through: ${long.length}`);
});

test('the whisper: the reason keeps its first clause, loses a "the caller wants" opening, and is cut at a word', () => {
  assert.equal(
    whisperBrief({ name: 'Dana Carter', company: 'Riverside Community Church', wants: 'Caller wants help running Facebook and Instagram for her church; social media management is outside the program scope.', lead: true }),
    'New business: Dana Carter from Riverside Community Church, about help running Facebook and Instagram for her church.',
  );
  assert.equal(whisperBrief({ name: 'Bob', wants: 'The caller is asking about a refund — he sounded upset.' }), 'Bob, about a refund.');
  assert.equal(whisperBrief({ name: 'Bob', wants: 'They would like to reschedule Tuesday.' }), 'Bob, would like to reschedule Tuesday.');
  assert.equal(whisperBrief({ name: 'Bob', wants: 'To reschedule Tuesday.' }), 'Bob, wants to reschedule Tuesday.');
  // The subject is optional: a model writes the reason both ways.
  assert.equal(whisperBrief({ name: 'Maria Lopez', company: 'Lopez Dental', wants: 'Wants to talk about an invoice.' }), 'Maria Lopez from Lopez Dental, wants to talk about an invoice.');
  assert.equal(whisperBrief({ name: 'Maria Lopez', wants: 'Needs a quote for social media management.' }), 'Maria Lopez, about a quote for social media management.');
  assert.equal(whisperBrief({ name: 'Maria Lopez', wants: 'Calling about a billing dispute.' }), 'Maria Lopez, about a billing dispute.');
  assert.equal(whisperBrief({ name: 'Maria Lopez', wants: 'Asking about a refund.' }), 'Maria Lopez, about a refund.');
  assert.equal(whisperBrief({ name: 'Maria Lopez', wants: 'Has a question about the contract.' }), 'Maria Lopez, about the contract.');
  assert.equal(whisperBrief({ name: 'Maria Lopez', wants: 'Interested in the Google Ads management.' }), 'Maria Lopez, about the Google Ads management.');
  assert.equal(whisperBrief({ wants: 'Wants to talk about an invoice.' }), 'The caller wants to talk about an invoice.');
  assert.equal(whisperBrief({ wants: 'The caller wants to cancel the contract.' }), 'The caller wants to cancel the contract.');
  const words = whisperBrief({ name: 'Ann', wants: 'a quote for ' + 'roof repair after the storm '.repeat(10) });
  assert.ok(words.length < 170 && !/\s$/.test(words) && words.endsWith('.'), words);
  assert.match(words, /(quote|for|roof|repair|after|the|storm)\.$/, 'cut between words, not inside one');
});

test('the whisper falls back to what the file had; the summary line does not', () => {
  const caller = { wants: 'A quote.', lead: false, onFile: { name: 'Maria Lopez', company: 'Lopez Dental' } };
  assert.equal(whisperBrief(caller), 'Maria Lopez from Lopez Dental, about a quote.');
  assert.equal(summaryBrief(caller), 'Asked for: A quote.');
  assert.equal(whisperBrief({ name: 'Ann', onFile: { name: 'Maria Lopez', company: 'Lopez Dental' } }), 'Ann from Lopez Dental.', 'what was said wins over the file');
});

test('the summary line: labelled fields, only the ones given', () => {
  assert.equal(
    summaryBrief({ name: 'Dana Carter', company: 'Riverside Community Church', wants: 'Managing their social media.', lead: true }),
    'Caller gave: Dana Carter, Riverside Community Church. Asked for: Managing their social media. New business.',
  );
  assert.equal(summaryBrief({ company: 'Acme Roofing' }), 'Caller gave: Acme Roofing.');
  assert.equal(summaryBrief({ wants: 'A quote', lead: false }), 'Asked for: A quote.');
  assert.equal(summaryBrief({}), '');
  assert.equal(summaryBrief(null), '');
});
