// Boîte de réception de l'agent WhatsApp : import via les fonctions métier habituelles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupApp } from './helpers';

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function inbox(items: any[]) {
  const dir = mkdtempSync(join(tmpdir(), 'darflow-inbox-'));
  for (const it of items) writeFileSync(join(dir, `${it.id}.json`), JSON.stringify(it));
  process.env.DARFLOW_AGENT_INBOX = dir;
  return dir;
}

test('agent inbox: bill split water/electricity becomes an unpaid purchase, voice expense becomes an expense', async () => {
  const { app } = await setupApp({ date: '2027-01-15' });
  const dir = inbox([
    { source: 'darflow-agent', version: 1, id: 'exp_bill', kind: 'purchase', date: '2027-01-06', due_date: '2027-02-12', doc_number: 'D2601',
      supplier: { name: 'SRM Marrakech-Safi', ice: null }, payment_method: null, attachment: PNG, notes: ['Ombre en bas'],
      lines: [{ label: 'Eau 18 m3', amount_cents: 18182, category_code: 'WATER', vat_rate_bp: 700 }, { label: 'Électricité 427 kWh', amount_cents: 69839, category_code: 'ENERGY', vat_rate_bp: 1400 }] },
    { source: 'darflow-agent', version: 1, id: 'exp_gas', kind: 'expense', date: '2027-01-15', payment_method: 'CARD', supplier: null,
      lines: [{ label: '3 × bouteille de gaz', amount_cents: 12000, category_code: 'ENERGY' }], heard: 'chrit 3 qnani dyal gaz b 120' },
    { source: 'other', version: 1, id: 'junk', kind: 'expense', lines: [] },
  ]);
  const before = await app.call('agentInbox.list');
  assert.equal(before.items.length, 3);
  assert.equal(before.items.find((i: any) => i.id === 'exp_bill').total, 88021);

  const r = await app.call('agentInbox.import', {});
  assert.equal(r.imported, 2);
  assert.equal(r.results.find((x: any) => x.file === 'junk.json').ok, false);

  const purchases = await app.call('purchases.list', {});
  const p = purchases.find((x: any) => x.invoice_number === 'D2601');
  assert.ok(p, 'purchase created');
  assert.equal(p.status, 'UNPAID');
  assert.equal(p.total_ttc, 88021); // 181.82 water (7 %) + 698.39 electricity (14 %), to the centime

  const exps = await app.call('expenses.list', { from: '2027-01-01', to: '2027-01-31' });
  const gas = exps.find((e: any) => /bouteille de gaz/.test(e.description));
  assert.equal(gas.amount_ttc, 12000);
  assert.equal(gas.payment_method, 'CARD');

  // imported files move away: a second import does nothing
  assert.ok(existsSync(join(dir, 'imported', 'exp_bill.json')));
  const again = await app.call('agentInbox.import', {});
  assert.equal(again.imported, 0);
  assert.ok(readdirSync(join(dir, 'imported')).some((f) => f.endsWith('.result.json')));
});

test('agent inbox: a future date never books a future expense, bad amounts are refused', async () => {
  const { app } = await setupApp({ date: '2027-01-15' });
  inbox([{ source: 'darflow-agent', version: 1, id: 'exp_bad', kind: 'expense', payment_method: 'CARD', lines: [{ label: 'x', amount_cents: -5, category_code: 'FOOD' }] },
         { source: 'darflow-agent', version: 1, id: 'exp_future', kind: 'expense', date: '2030-01-01', payment_method: 'CARD', lines: [{ label: 'pain', amount_cents: 500, category_code: 'FOOD' }] }]);
  const r = await app.call('agentInbox.import', {});
  assert.equal(r.results.find((x: any) => x.file === 'exp_bad.json').ok, false);
  const ok = r.results.find((x: any) => x.file === 'exp_future.json');
  assert.equal(ok.ok, true);
  const exps = await app.call('expenses.list', { from: '2027-01-01', to: '2027-01-31' });
  assert.equal(exps.find((e: any) => /pain/.test(e.description)).date, '2027-01-15');
});
