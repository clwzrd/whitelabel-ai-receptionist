import assert from 'node:assert/strict';
import { test } from 'node:test';
import { relayCandidateUrls } from './admit.ts';
import { decideRelay, greetingSentence } from './route.ts';
import { ELEVENLABS_EN_US_VOICE, connectRelay } from '../twiml.ts';
import { LANGUAGE_VOICES, SWITCHABLE_LANGUAGES, languageLabel, voiceSettingsOf } from '../settings.ts';

/*
 * The decision that hands a call to the assistant, the URLs Twilio might
 * have signed for the socket, and the TwiML that opens it — none of which
 * needs a database.
 */

/* ---- decideRelay: the whole truth table ---------------------------------- */

const bools = [false, true] as const;
const stages = ['inbound', 'after-dial'] as const;

test('off, or not ready, is always no', () => {
  for (const aiClosed of bools)
    for (const forwardTo of [null, '+13105550100'])
      for (const stage of stages) {
        assert.equal(decideRelay({ mode: 'off', ready: true, aiClosed, forwardTo, stage }), 'no');
        for (const mode of ['always', 'after_hours', 'overflow'] as const) {
          assert.equal(decideRelay({ mode, ready: false, aiClosed, forwardTo, stage }), 'no');
        }
      }
});

test('always answers now, whatever the clock or the forwarding number', () => {
  for (const aiClosed of bools)
    for (const forwardTo of [null, '+13105550100'])
      for (const stage of stages) assert.equal(decideRelay({ mode: 'always', ready: true, aiClosed, forwardTo, stage }), 'now');
});

test('after_hours: inbound answers when closed or when nobody can be rung', () => {
  const forward = '+13105550100';
  assert.equal(decideRelay({ mode: 'after_hours', ready: true, aiClosed: true, forwardTo: forward, stage: 'inbound' }), 'now');
  assert.equal(decideRelay({ mode: 'after_hours', ready: true, aiClosed: true, forwardTo: null, stage: 'inbound' }), 'now');
  assert.equal(decideRelay({ mode: 'after_hours', ready: true, aiClosed: false, forwardTo: null, stage: 'inbound' }), 'now');
  assert.equal(decideRelay({ mode: 'after_hours', ready: true, aiClosed: false, forwardTo: forward, stage: 'inbound' }), 'no');
});

test('after_hours: after the human rang out, only the clock decides', () => {
  for (const forwardTo of [null, '+13105550100']) {
    assert.equal(decideRelay({ mode: 'after_hours', ready: true, aiClosed: true, forwardTo, stage: 'after-dial' }), 'now');
    assert.equal(decideRelay({ mode: 'after_hours', ready: true, aiClosed: false, forwardTo, stage: 'after-dial' }), 'no');
  }
});

test('overflow: the human first, then the assistant; closed or nobody to ring means now', () => {
  const forward = '+13105550100';
  assert.equal(decideRelay({ mode: 'overflow', ready: true, aiClosed: false, forwardTo: forward, stage: 'inbound' }), 'after-ring');
  assert.equal(decideRelay({ mode: 'overflow', ready: true, aiClosed: false, forwardTo: forward, stage: 'after-dial' }), 'now');
  assert.equal(decideRelay({ mode: 'overflow', ready: true, aiClosed: false, forwardTo: null, stage: 'inbound' }), 'now');
  assert.equal(decideRelay({ mode: 'overflow', ready: true, aiClosed: false, forwardTo: null, stage: 'after-dial' }), 'now');
  for (const forwardTo of [null, forward])
    for (const stage of stages) assert.equal(decideRelay({ mode: 'overflow', ready: true, aiClosed: true, forwardTo, stage }), 'now');
});

/* ---- relayCandidateUrls ---------------------------------------------------- */

test('an https request URL yields the wss twin first, then itself, then the forwarded and canonical pairs', () => {
  const request = new Request('https://crm.example.com/api/twilio/relay?call=abc&exp=1&sig=ff', {
    headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'preview.example.com' },
  });
  const urls = relayCandidateUrls(request, 'https://canonical.example.com');
  assert.deepEqual(urls, [
    'wss://crm.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
    'https://crm.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
    'wss://preview.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
    'https://preview.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
    'wss://canonical.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
    'https://canonical.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
  ]);
});

test('a wss request URL (the dev server rebuilds one) is offered as is and as https', () => {
  const request = new Request('wss://tunnel.example.com/api/twilio/relay?call=abc', { headers: {} });
  const urls = relayCandidateUrls(request, null);
  assert.deepEqual(urls, ['wss://tunnel.example.com/api/twilio/relay?call=abc', 'https://tunnel.example.com/api/twilio/relay?call=abc']);
});

test('http behind a plain tunnel maps to ws', () => {
  const request = new Request('http://localhost:8787/api/twilio/relay?call=abc', { headers: {} });
  const urls = relayCandidateUrls(request, null);
  assert.deepEqual(urls, ['ws://localhost:8787/api/twilio/relay?call=abc', 'http://localhost:8787/api/twilio/relay?call=abc']);
});

/* ---- connectRelay ----------------------------------------------------------- */

test('connectRelay escapes every attribute and emits the fixed language, transcriber and interrupt settings', () => {
  const xml = connectRelay({
    url: 'wss://crm.example.com/api/twilio/relay?call=abc&exp=1&sig=ff',
    action: 'https://crm.example.com/api/twilio/voice?step=relay-done&call=abc',
    welcomeGreeting: 'Thanks for calling Smith & Sons. This is "Ava", an automated assistant. How can I help?',
    ttsProvider: 'Amazon',
    hints: 'the agency, <discovery call>',
    parameters: { call: 'abc', ws: 'w1', resume: '0' },
  });
  assert.ok(xml.startsWith('<Connect action="https://crm.example.com/api/twilio/voice?step=relay-done&amp;call=abc" method="POST"><ConversationRelay '));
  assert.ok(xml.includes('url="wss://crm.example.com/api/twilio/relay?call=abc&amp;exp=1&amp;sig=ff"'));
  assert.ok(xml.includes('welcomeGreeting="Thanks for calling Smith &amp; Sons. This is &quot;Ava&quot;, an automated assistant. How can I help?"'));
  assert.ok(xml.includes('welcomeGreetingInterruptible="none"'));
  assert.ok(xml.includes('language="en-US"'));
  assert.ok(xml.includes('events="tokens-played"'));
  assert.ok(xml.includes('ttsProvider="Amazon"'));
  assert.ok(xml.includes('voice="Joanna-Neural"'));
  assert.ok(xml.includes('transcriptionProvider="Deepgram"'));
  assert.ok(xml.includes('hints="the agency, &lt;discovery call&gt;"'));
  assert.ok(xml.includes('interruptible="any"'));
  assert.ok(xml.includes('interruptSensitivity="medium"'));
  assert.ok(xml.includes('ignoreBackchannel="true"'));
  assert.ok(xml.includes('reportInputDuringAgentSpeech="none"'));
  assert.ok(xml.includes('dtmfDetection="true"'));
  assert.ok(xml.includes('<Parameter name="call" value="abc"/><Parameter name="ws" value="w1"/><Parameter name="resume" value="0"/>'));
  assert.ok(xml.endsWith('</ConversationRelay></Connect>'));
  assert.ok(!xml.includes('<Say'));
});

test('a resume has no greeting and no interruptible flag for it; a chosen voice and provider are written as given', () => {
  const xml = connectRelay({
    url: 'wss://x/api/twilio/relay',
    action: 'https://x/api/twilio/voice?step=relay-done',
    ttsProvider: 'ElevenLabs',
    voice: 'Rachel',
    parameters: { resume: '2' },
  });
  assert.ok(!xml.includes('welcomeGreeting'));
  assert.ok(xml.includes('ttsProvider="ElevenLabs"'));
  assert.ok(xml.includes('voice="Rachel"'));
  assert.ok(!xml.includes('hints='));
  // No languages asked for: a plain English session, no <Language> children, no multi.
  assert.ok(xml.includes('language="en-US"'));
  assert.ok(!xml.includes('<Language'));
  assert.ok(xml.includes('ttsLanguage="en-US"'));
});

/* ---- connectRelay: language detection and per-language voices -------------- */

const LANGS = [
  { code: 'es-US', voice: LANGUAGE_VOICES['es-US']! },
  { code: 'pt-BR', voice: 'abc123-turbo_v2_5' },
];

test('under ElevenLabs, languages render as <Language> children, the session is multi with English as the greeting language, and text normalization is on', () => {
  const xml = connectRelay({
    url: 'wss://x/api/twilio/relay',
    action: 'https://x/api/twilio/voice?step=relay-done',
    welcomeGreeting: 'Hi, thanks for calling Acme. I\'m the AI assistant here. How can I help you today?',
    ttsProvider: 'ElevenLabs',
    languages: LANGS,
    multi: true,
    textNormalization: true,
    parameters: { call: 'abc', ws: 'w1', resume: '0' },
  });
  assert.ok(xml.includes('language="multi"'));
  assert.ok(xml.includes('ttsLanguage="en-US"'));
  assert.ok(xml.includes('transcriptionProvider="Deepgram"'));
  assert.ok(xml.includes('ttsProvider="ElevenLabs"'));
  assert.ok(xml.includes('elevenlabsTextNormalization="on"'));
  // No voice chosen: Twilio's own default English voice, never an empty attribute.
  assert.ok(xml.includes(`voice="${ELEVENLABS_EN_US_VOICE}"`));
  assert.ok(xml.includes(`<Language code="es-US" ttsProvider="ElevenLabs" voice="${LANGUAGE_VOICES['es-US']}"/>`));
  assert.ok(xml.includes('<Language code="pt-BR" ttsProvider="ElevenLabs" voice="abc123-turbo_v2_5"/>'));
  // Children come before the parameters, inside the noun.
  assert.ok(xml.indexOf('<Language') < xml.indexOf('<Parameter'));
  assert.ok(xml.endsWith('</ConversationRelay></Connect>'));
});

test('without ElevenLabs the languages are dropped and the session stays a plain English one — Twilio would end the call otherwise', () => {
  for (const ttsProvider of ['Amazon', 'Google'] as const) {
    const xml = connectRelay({
      url: 'wss://x/api/twilio/relay',
      action: 'https://x/api/twilio/voice?step=relay-done',
      ttsProvider,
      languages: LANGS,
      multi: true,
      textNormalization: true,
      parameters: { call: 'abc' },
    });
    assert.ok(xml.includes('language="en-US"'), ttsProvider);
    assert.ok(!xml.includes('multi'), ttsProvider);
    assert.ok(!xml.includes('<Language'), ttsProvider);
    assert.ok(!xml.includes('elevenlabsTextNormalization'), ttsProvider);
    assert.ok(xml.includes('ttsLanguage="en-US"'), ttsProvider);
  }
});

test('a resume carries the caller\'s language as ttsLanguage so the reconnected session does not flip back to English', () => {
  const xml = connectRelay({
    url: 'wss://x/api/twilio/relay',
    action: 'https://x/api/twilio/voice?step=relay-done',
    ttsProvider: 'ElevenLabs',
    languages: LANGS,
    multi: true,
    ttsLanguage: 'es-US',
    parameters: { resume: '1' },
  });
  assert.ok(xml.includes('language="multi"'));
  assert.ok(xml.includes('ttsLanguage="es-US"'));
  assert.ok(!xml.includes('welcomeGreeting'));
});

/* ---- greetingSentence ------------------------------------------------------- */

test('the default greeting is English, names the business and the persona, and always discloses the AI', () => {
  assert.equal(greetingSentence('', 'Smith & Sons', 'Ava'), 'Hi, thanks for calling Smith & Sons. This is Ava, the AI assistant. How can I help you today?');
  assert.equal(greetingSentence('', 'Smith & Sons', ''), "Hi, thanks for calling Smith & Sons. I'm the AI assistant here. How can I help you today?");
  assert.equal(greetingSentence('', null, undefined), "Hi, thanks for calling the business. I'm the AI assistant here. How can I help you today?");
  // The owner's own words win, whatever they are.
  assert.equal(greetingSentence('  Acme, this is Ava. ', 'Acme', 'Ava'), 'Acme, this is Ava.');
});

/* ---- the settings parser ------------------------------------------------------ */

test('the AI settings default to ElevenLabs with the five languages, keep an explicit Amazon, and refuse English and unknown codes in the list', () => {
  const fresh = voiceSettingsOf({}).ai;
  assert.equal(fresh.ttsProvider, 'ElevenLabs');
  assert.equal(fresh.persona, '');
  assert.deepEqual(fresh.languages, ['es-US', 'pt-BR', 'fr-FR', 'de-DE', 'it-IT']);
  assert.deepEqual(fresh.voicesByLanguage, {});

  const stored = voiceSettingsOf({
    voice: {
      ai: {
        ttsProvider: 'Amazon',
        persona: '  Ava  ',
        voice: 'Joanna-Neural',
        languages: ['en-US', 'es-US', 'xx-YY', 'es-US', 'ja-JP'],
        voicesByLanguage: { 'es-US': 'abc-turbo_v2_5', 'en-US': 'ignored', 'zz-ZZ': 'ignored', 'pt-BR': 'not a voice!' },
      },
    },
  }).ai;
  assert.equal(stored.ttsProvider, 'Amazon');
  assert.equal(stored.persona, 'Ava');
  assert.deepEqual(stored.languages, ['es-US', 'ja-JP']);
  assert.deepEqual(stored.voicesByLanguage, { 'es-US': 'abc-turbo_v2_5', 'en-US': 'ignored' });
  // An explicit empty list is the owner's choice; only an absent field takes the default.
  assert.deepEqual(voiceSettingsOf({ voice: { ai: { languages: [] } } }).ai.languages, []);
  // A voice that is not the shape of a voice is not written into TwiML.
  assert.equal(voiceSettingsOf({ voice: { ai: { voice: '<script>' } } }).ai.voice, '');
  // Too long is dropped whole, never cut to a shorter, equally unknown id.
  assert.equal(voiceSettingsOf({ voice: { ai: { voice: 'a'.repeat(121) } } }).ai.voice, '');
  assert.equal(voiceSettingsOf({ voice: { ai: { voice: 'a'.repeat(120) } } }).ai.voice, 'a'.repeat(120));
  assert.deepEqual(voiceSettingsOf({ voice: { ai: { voicesByLanguage: { 'es-US': 'b'.repeat(121) } } } }).ai.voicesByLanguage, {});
});

test('the switchable languages are every voice Twilio ships minus English, and the labels only name a region where two voices share a language', () => {
  assert.ok(!SWITCHABLE_LANGUAGES.some((c) => c.startsWith('en')));
  assert.ok(SWITCHABLE_LANGUAGES.includes('es-US') && SWITCHABLE_LANGUAGES.includes('hi-IN'));
  assert.equal(languageLabel('es-US'), 'Spanish (US)');
  assert.equal(languageLabel('pt-BR'), 'Portuguese (Brazil)');
  assert.equal(languageLabel('de-DE'), 'German');
  assert.equal(languageLabel('it-IT'), 'Italian');
});
