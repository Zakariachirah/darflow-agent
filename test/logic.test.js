// Deterministic guardrails: these run without any API call.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-test-'));
process.env.WHATSAPP_APP_SECRET = 'test-secret';
process.env.OUTREACH_DAYS_BEFORE = '3';

const store = await import('../src/store.js');
const { decide } = await import('../src/agents/expense.js');
const { toolsFor } = await import('../src/agents/guest.js');
const wa = await import('../src/whatsapp.js');
const { dueOutreach } = await import('../src/outreach.js');

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };
const PHONE = '212600000001';
const tool = (name) => toolsFor(PHONE).find((t) => t.name === name);

function seed() {
  store.reset({
    reservations: [
      { id: 'R1', guestName: 'Ana López', phone: PHONE, lang: 'es', checkin: day(3), checkout: day(6), room: 'Double', adults: 2, checkinStatus: 'pending' },
      { id: 'R2', guestName: 'Done Guest', phone: '33600000002', lang: 'fr', checkin: day(2), checkout: day(4), room: 'Simple', adults: 1, checkinStatus: 'done' },
      { id: 'R3', guestName: 'Far Guest', phone: '33600000003', lang: 'fr', checkin: day(20), checkout: day(22), room: 'Simple', adults: 1, checkinStatus: 'pending' },
    ],
  });
}

test('expense policy: specimen, quote, revenue are never booked', () => {
  const base = { supplier: 'X', total_ttc: 100, lines: [], anomalies: [], arithmetic_ok: true, confidence: 0.9 };
  assert.equal(decide({ ...base, doc_kind: 'specimen_or_fake' }).action, 'reject');
  assert.equal(decide({ ...base, doc_kind: 'quote' }).action, 'track_quote');
  assert.equal(decide({ ...base, doc_kind: 'sales_invoice_issued_by_us' }).action, 'not_an_expense_revenue');
  assert.equal(decide({ ...base, doc_kind: 'supplier_invoice', confidence: 0.3 }).action, 'ask_new_photo');
});

test('expense policy: arithmetic error, duplicate and unusual amount need review', () => {
  seed();
  const inv = { doc_kind: 'utility_bill', supplier: 'SRM', doc_number: 'D1', total_ttc: 500, lines: [], anomalies: [], arithmetic_ok: true, confidence: 0.9 };
  assert.equal(decide(inv).action, 'draft_ready');
  assert.equal(decide({ ...inv, arithmetic_ok: false }).action, 'draft_needs_review');
  store.addExpense({ supplier: 'SRM', docNumber: 'D1', total: 500 });
  const dup = decide(inv);
  assert.equal(dup.action, 'draft_needs_review');
  assert.match(dup.reasons.join(' '), /Doublon/);
  store.addExpense({ supplier: 'Gaz', total: 120 });
  store.addExpense({ supplier: 'Gaz', total: 130 });
  const high = decide({ ...inv, supplier: 'Gaz', doc_number: null, total_ttc: 400 });
  assert.match(high.reasons.join(' '), /inhabituel/);
});

test('guest tools only expose the caller\'s own reservation', () => {
  seed();
  const r = tool('get_reservation').run({});
  assert.equal(r.found, true);
  assert.equal(r.id, 'R1');
  assert.equal(r.phone, undefined, 'phone number is not echoed to the model');
  const other = toolsFor('999999').find((t) => t.name === 'get_reservation').run({});
  assert.equal(other.found, false);
});

test('dinner: 3h notice and stay dates are enforced in code, not by the model', () => {
  seed();
  const order = tool('order_dinner');
  const soon = new Date(Date.now() + 60 * 60 * 1000);
  const tooLate = order.run({ date: soon.toISOString().slice(0, 10), time: soon.toTimeString().slice(0, 5), people: 2 });
  assert.equal(tooLate.error, 'too_late');
  assert.match(tooLate.earliestPossible, /^\d\d:\d\d$/);
  const outside = order.run({ date: day(10), time: '20:00', people: 2 });
  assert.equal(outside.error, 'outside_stay');
  const ok = order.run({ date: day(4), time: '20:00', people: 3, dietary: 'vegetarian' });
  assert.equal(ok.booked, true);
  assert.equal(ok.totalDH, 450);
  // confirming again or changing the time updates the same dinner
  order.run({ date: day(4), time: '20:00', people: 3, dietary: 'vegetarian' });
  const moved = order.run({ date: day(4), time: '21:30', people: 2 });
  assert.equal(moved.requestId, ok.requestId);
  const dinners = store.load().requests.filter((q) => q.kind === 'dinner' && q.date === day(4));
  assert.equal(dinners.length, 1);
  assert.equal(dinners[0].time, '21:30');
  assert.equal(dinners[0].totalDH, 300);
});

test('arrival time: format validated, night arrival flagged for the manager', () => {
  seed();
  const t = tool('set_arrival_time');
  assert.equal(t.run({ time: '9pm' }).error, 'time must be HH:MM');
  assert.equal(t.run({ time: '21:30' }).saved, true);
  assert.match(t.run({ time: '02:00' }).warning, /manager/);
});

test('check-in link not sent twice once completed', () => {
  seed();
  assert.match(tool('send_checkin_link').run({}).link, /R1|demo/);
  store.updateReservation('R1', { checkinStatus: 'done' });
  assert.equal(tool('send_checkin_link').run({}).alreadyDone, true);
});

test('handoff pauses the agent for that guest only', () => {
  seed();
  tool('handoff_to_manager').run({ reason: 'pricing', summary: 'test' });
  assert.equal(store.isHandedOff(PHONE), true);
  assert.equal(store.isHandedOff('33600000002'), false);
  store.closeHandoff(PHONE);
  assert.equal(store.isHandedOff(PHONE), false);
});

test('outreach: only pending check-ins within the window, never twice a day', () => {
  seed();
  assert.deepEqual(dueOutreach().map((r) => r.id), ['R1']);
  store.updateReservation('R1', { outreach: [{ date: day(0), kind: 'first' }] });
  assert.deepEqual(dueOutreach().map((r) => r.id), []);
});

test('webhook: signature check and payload parsing', () => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { contacts: [{ wa_id: '34600', profile: { name: 'Ana' } }], messages: [
    { id: 'a', from: '34600', type: 'text', text: { body: 'hola' } },
    { id: 'b', from: '34600', type: 'audio', audio: { id: 'm1', voice: true } },
    { id: 'c', from: '34600', type: 'image', image: { id: 'm2', caption: 'factura' } },
  ] } }] }] });
  const sig = 'sha256=' + crypto.createHmac('sha256', 'test-secret').update(body).digest('hex');
  assert.equal(wa.validSignature(Buffer.from(body), sig), true);
  assert.equal(wa.validSignature(Buffer.from(body), 'sha256=' + '0'.repeat(64)), false);
  const msgs = wa.parseWebhook(JSON.parse(body));
  assert.deepEqual(msgs.map((m) => m.type), ['text', 'audio', 'image']);
  assert.equal(msgs[0].name, 'Ana');
  assert.equal(msgs[1].mediaId, 'm1');
});
