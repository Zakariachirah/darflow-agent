// Live evaluation of the expense agent on real document photos.
// Photos are private (never committed): put them in private/invoices/ and list the
// expected outcome in private/invoices/expected.json, e.g.
//   { "01-bill.jpg": { "kind": "utility_bill", "action": "draft_ready", "total": 870.83 } }
// The script also re-submits the first booked document to check duplicate detection.
// Run: node eval/documents.js [dir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-eval-docs-'));
const store = await import('../src/store.js');
const { readDocument, decide } = await import('../src/agents/expense.js');
const { usageTotals } = await import('../src/meta.js');

const dir = path.resolve(process.argv[2] || 'private/invoices');
const expectedFile = path.join(dir, 'expected.json');
if (!fs.existsSync(expectedFile)) { console.error(`Missing ${expectedFile}`); process.exit(1); }
const expected = JSON.parse(fs.readFileSync(expectedFile, 'utf8'));
store.reset({});

let passed = 0, total = 0, firstBooked = null;
const book = (doc) => store.addExpense({ supplier: doc.supplier, docNumber: doc.doc_number, total: doc.total_ttc, category: doc.category });

for (const [file, exp] of Object.entries(expected)) {
  total++;
  const t0 = Date.now();
  const { doc, decision } = await readDocument(path.join(dir, file));
  const fails = [];
  if (exp.kind && doc.doc_kind !== exp.kind) fails.push(`type ${doc.doc_kind} ≠ ${exp.kind}`);
  if (exp.action && decision.action !== exp.action) fails.push(`action ${decision.action} ≠ ${exp.action}`);
  if (exp.total != null && Math.abs((doc.total_ttc ?? 0) - exp.total) > 0.05) fails.push(`total ${doc.total_ttc} ≠ ${exp.total}`);
  if (exp.arithmetic_ok != null && doc.arithmetic_ok !== exp.arithmetic_ok) fails.push(`arithmétique ${doc.arithmetic_ok} ≠ ${exp.arithmetic_ok}`);
  if (fails.length === 0) passed++;
  if (decision.action.startsWith('draft')) { book(doc); firstBooked ??= { file, doc }; }
  console.log(`${fails.length ? '❌' : '✅'} ${file} (${((Date.now() - t0) / 1000).toFixed(1)} s)
   ${doc.doc_kind} · ${doc.supplier} · ${doc.total_ttc} ${doc.currency} · ${decision.action}
   lignes: ${doc.lines.map((l) => `${l.label} ${l.amount} [${l.category}]`).join(' | ') || '—'}
   anomalies: ${doc.anomalies.join(' | ') || '—'}${fails.length ? `\n   échec: ${fails.join(' ; ')}` : ''}\n`);
}

if (firstBooked) {
  total++;
  const again = decide(firstBooked.doc);
  const ok = again.action === 'draft_needs_review' && /Doublon/.test(again.reasons.join(' '));
  if (ok) passed++;
  console.log(`${ok ? '✅' : '❌'} doublon: ${firstBooked.file} soumis deux fois → ${again.action} (${again.reasons.join(' ')})\n`);
}
console.log(`${passed}/${total} vérifications réussies · ${usageTotals.calls} appels API, ${usageTotals.input} tokens entrée / ${usageTotals.output} sortie`);
