// DarFlow adapter: when the manager approves an expense on WhatsApp ("OK"), drop it into
// DarFlow's inbox folder (contract "darflow-agent/expense v1"). DarFlow imports each file
// through its own business functions (cash checks, duplicates, closed months, audit log),
// so the agent never writes into DarFlow's database.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Agent categories → DarFlow expense category codes (DarFlow's default chart).
const CATEGORY = {
  gas: 'ENERGY', food_beverage: 'FOOD', maintenance_repairs: 'MAINTENANCE', printing_marketing: 'MARKETING',
  linen_supplies: 'SUPPLIES', transport: 'TRANSPORT', salaries: 'SALARIES', taxes_fees: 'TAXES', other: 'OTHER',
};
function categoryFor(agentCategory, label = '') {
  if (agentCategory === 'energy_water_electricity') return /eau|water|ماء/i.test(label) ? 'WATER' : 'ENERGY';
  if (agentCategory === 'cleaning_laundry') return /linge|blanch|pressing|laundry/i.test(label) ? 'LAUNDRY' : 'CLEANING';
  return CATEGORY[agentCategory] || 'OTHER';
}
// Moroccan VAT on utility bills (water 7 %, electricity 14 %); otherwise 0 = amounts kept TTC.
const vatFor = (code, utility) => (utility ? { WATER: 700, ENERGY: 1400 }[code] || 0 : 0);
const cents = (dh) => Math.round(Number(dh) * 100);
const PAY = { cash: 'CASH', card: 'CARD', transfer: 'TRANSFER' };

/** Pure mapping: one approved agent expense → one DarFlow inbox item. */
export function toInboxItem(e, { attachment = null, today = new Date().toISOString().slice(0, 10) } = {}) {
  const utility = e.docKind === 'utility_bill';
  const lines = (e.lines || []).filter((l) => Number(l.amount) > 0);
  const sum = lines.reduce((s, l) => s + Number(l.amount), 0);
  // Use the detail lines only when they add up to the total (otherwise they may be HT or partial).
  const useLines = lines.length && e.total != null && Math.abs(sum - e.total) <= 1;
  const out = (useLines ? lines : [{ label: e.supplier || e.lines?.[0]?.label || 'Dépense', amount: e.total }]).map((l) => {
    const code = categoryFor(e.category, l.label);
    return { label: String(l.label).slice(0, 120), amount_cents: cents(l.amount), category_code: code, vat_rate_bp: vatFor(code, utility) };
  });
  const payment = PAY[e.paymentMethod] || null;
  // A supplier bill with a due date and no payment yet is a bill to pay (DarFlow "purchase"), not a paid expense.
  const unpaidBill = e.source === 'photo' && ['utility_bill', 'supplier_invoice'].includes(e.docKind) && !payment && (!e.dueDate || e.dueDate >= today);
  return {
    source: 'darflow-agent', version: 1, id: e.id,
    kind: unpaidBill ? 'purchase' : 'expense',
    date: e.date || today, due_date: e.dueDate || null, doc_number: e.docNumber || null,
    supplier: e.supplier || e.supplierIce ? { name: e.supplier || null, ice: e.supplierIce || null } : null,
    payment_method: unpaidBill ? null : payment || 'CASH',
    lines: out, attachment,
    notes: [...(e.anomalies || []), ...(e.reasons || [])].slice(0, 6),
    heard: e.heard || null,
  };
}

export function inboxDir() { return config.darflowInbox; }

/** Write the inbox file for an approved expense. Returns the file path. */
export function exportApproved(e) {
  const dir = inboxDir();
  fs.mkdirSync(dir, { recursive: true });
  let attachment = null;
  if (e.attachmentPath && fs.existsSync(e.attachmentPath)) attachment = `data:image/jpeg;base64,${fs.readFileSync(e.attachmentPath).toString('base64')}`;
  const file = path.join(dir, `${e.id}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(toInboxItem(e, { attachment }), null, 2));
  fs.renameSync(tmp, file); // DarFlow only ever sees complete files
  return file;
}
