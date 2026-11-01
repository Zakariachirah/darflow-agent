// Morning brief: the facts, the actions and the checks on the model's output are all code,
// so they are tested here without any API call (the model is replaced by a fake).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-brief-'));
process.env.MANAGER_WHATSAPP = '212611111111';
delete process.env.WHATSAPP_TOKEN;

const store = await import('../src/store.js');
const wa = await import('../src/whatsapp.js');
const { collectFacts, proposeActions, verifyItems, parseChoice, runBrief, handleBriefReply } = await import('../src/brief.js');
const { demoSeed, demoDay } = await import('../examples/demo-seed.js');
const today = new Date().toISOString().slice(0, 10);
const reset = () => store.reset(demoDay(demoSeed('212600000000')));

test('brief facts come from the store, not the model', () => {
  reset();
  const f = collectFacts(today);
  const kinds = f.map((x) => x.kind);
  for (const k of ['arrival', 'dinner', 'handoff', 'bill', 'drafts']) assert.ok(kinds.includes(k), `missing ${k}`);
  const giulia = f.find((x) => x.reservation === 'R-1004');
  assert.ok(giulia.checkinPending && giulia.noArrivalTime && giulia.today);
  assert.ok(f.find((x) => x.reservation === 'R-1005').late, '23:30 is a late arrival');
  assert.ok(f.find((x) => x.kind === 'handoff').urgentFloor, 'a waiting guest is always urgent');
  assert.match(f.find((x) => x.kind === 'bill').text, /509,80 DH à payer dans 2 jour/);
});

test('actions are proposed by code: only guests who still owe check-in or an arrival time', () => {
  reset();
  const a = proposeActions(collectFacts(today), today);
  assert.deepEqual(a.map((x) => x.reservation), ['R-1004', 'R-1003'], 'missing check-in first; James (done, 23:30 given) needs nothing');
  assert.match(a[0].label, /Giulia \(it\) : check-in en ligne \+ heure d'arrivée/);
});

test("the model's brief is checked against the facts", () => {
  reset();
  const facts = collectFacts(today);
  const bill = facts.find((x) => x.kind === 'bill');
  const dinner = facts.find((x) => x.kind === 'dinner');
  const { items, fixes } = verifyItems([
    { fact: dinner.id, urgency: 'today', line: 'Dîner 20:00 pour 3, sans gluten' },
    { fact: bill.id, urgency: 'info', line: 'Eau : 590,80 DH à payer' },          // wrong amount
    { fact: 'f99', urgency: 'urgent', line: 'Piscine à nettoyer' },               // no such fact
  ], facts);
  assert.equal(items.find((i) => i.fact === dinner.id).line, 'Dîner 20:00 pour 3, sans gluten');
  assert.equal(items.find((i) => i.fact === bill.id).line, bill.text, 'invented number → fact text');
  assert.ok(!items.some((i) => i.fact === 'f99'));
  const ho = items.find((i) => facts.find((f) => f.id === i.fact).kind === 'handoff');
  assert.equal(ho?.urgency, 'urgent', 'a waiting guest left out by the model is added back as urgent');
  assert.equal(fixes.length, 3);
});

test('manager reply parsing', () => {
  assert.deepEqual(parseChoice('1', 2), [1]);
  assert.deepEqual(parseChoice('1 et 2', 2), [1, 2]);
  assert.deepEqual(parseChoice('2,1', 2), [2, 1]);
  assert.deepEqual(parseChoice('tout', 3), [1, 2, 3]);
  assert.equal(parseChoice('3', 2), null);
  assert.equal(parseChoice('OK', 2), null);
  assert.equal(parseChoice('1 chambre double svp', 2), null);
});

test('brief → manager answers "1" → the agent writes to the guest, once', async () => {
  reset();
  const fake = async (facts) => ({ headline: 'Journée chargée.', items: facts.map((f) => ({ fact: f.id, urgency: 'today', line: f.text })) });
  const r = await runBrief({ today, compose: fake });
  assert.equal(r.to, '212611111111');
  assert.match(wa.outbox.at(-1).text, /Réponds avec le\(s\) numéro\(s\)|réponds avec le\(s\) numéro\(s\)/);
  assert.equal(await handleBriefReply('212699999999', '1', { today, compose: async () => 'x' }), null, 'only the manager can trigger actions');
  const reply = await handleBriefReply('212611111111', '1', { today, compose: async () => 'Buongiorno Giulia…' });
  assert.match(reply, /Message envoyé à Giulia/);
  assert.equal(wa.outbox.find((o) => o.to === '393400000000')?.text, 'Buongiorno Giulia…');
  assert.ok(store.reservationById('R-1004').outreach.some((o) => o.kind === 'brief'));
  assert.equal(await handleBriefReply('212611111111', '1', { today, compose: async () => 'again' }), 'Déjà fait ✔');
});
