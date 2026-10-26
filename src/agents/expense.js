// Expense back-office agent: reads a document photo, decides what it is, checks the
// arithmetic and history, and proposes an action. It never books anything by itself:
// the manager approves every draft.
import fs from 'node:fs';
import path from 'node:path';
import { structured } from '../meta.js';
import * as store from '../store.js';

const CATEGORIES = ['energy_water_electricity', 'gas', 'food_beverage', 'cleaning_laundry', 'maintenance_repairs', 'printing_marketing', 'linen_supplies', 'transport', 'salaries', 'taxes_fees', 'other'];

const SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['doc_kind', 'supplier', 'supplier_ice', 'doc_number', 'date', 'due_date', 'currency', 'lines', 'total_ht', 'vat', 'total_ttc', 'category', 'arithmetic_ok', 'anomalies', 'confidence'],
  properties: {
    doc_kind: { type: 'string', enum: ['supplier_invoice', 'utility_bill', 'receipt', 'quote', 'sales_invoice_issued_by_us', 'specimen_or_fake', 'unreadable', 'other'] },
    supplier: { type: ['string', 'null'] },
    supplier_ice: { type: ['string', 'null'], description: 'Moroccan ICE, 15 digits' },
    doc_number: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'YYYY-MM-DD' },
    due_date: { type: ['string', 'null'], description: 'YYYY-MM-DD payment deadline if printed' },
    currency: { type: ['string', 'null'] },
    lines: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['label', 'amount', 'category'], properties: { label: { type: 'string' }, amount: { type: 'number' }, category: { type: 'string', enum: CATEGORIES } } } },
    total_ht: { type: ['number', 'null'] },
    vat: { type: ['number', 'null'] },
    total_ttc: { type: ['number', 'null'] },
    category: { type: 'string', enum: CATEGORIES },
    arithmetic_ok: { type: 'boolean' },
    anomalies: { type: 'array', items: { type: 'string' }, description: 'short, factual, in French' },
    confidence: { type: 'number', minimum: 0, maximum: 1 },
  },
};

const INSTRUCTIONS = `You are the back-office assistant of a small riad (guesthouse) in Morocco.
You receive a phone photo of a document. Decide what it is, extract the fields, and CHECK it like a careful accountant:
- recompute each line (qty x unit price), the sum, any discount, VAT (Moroccan rates 7/10/14/20 %) and the total; report every inconsistency with the correct figure;
- a quote/devis/proforma is NOT an expense; an invoice issued BY the riad to a guest is revenue, not an expense; a document marked specimen/fictitious/test must never be booked;
- utility bills (water/electricity) may contain several contracts: give one line per contract with its amount;
- if part of the photo is unreadable (shadow, blur, crop), say which part in anomalies and lower the confidence.
Write anomalies in French, short and factual. Never invent a value you cannot read: use null.`;

const MIME = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

export async function readDocument(imagePath) {
  const mime = MIME[path.extname(imagePath).toLowerCase()] || 'image/jpeg';
  const b64 = fs.readFileSync(imagePath).toString('base64');
  return readDocumentData(`data:${mime};base64,${b64}`);
}

export async function readDocumentData(dataUrl) {
  const doc = await structured({
    instructions: INSTRUCTIONS,
    content: [{ type: 'input_text', text: 'Read and check this document.' }, { type: 'input_image', image_url: dataUrl }],
    schema: SCHEMA, name: 'riad_document',
  });
  return { doc, decision: decide(doc) };
}

/** Deterministic policy on top of the model's reading: what the riad should do with it. */
export function decide(doc) {
  const reasons = [];
  if (doc.doc_kind === 'specimen_or_fake') return { action: 'reject', reasons: ['Document fictif ou spécimen : ne jamais enregistrer.'] };
  if (doc.doc_kind === 'unreadable' || doc.confidence < 0.5) return { action: 'ask_new_photo', reasons: ['Photo illisible : reprendre la photo à plat, sans ombre.'] };
  if (doc.doc_kind === 'quote') return { action: 'track_quote', reasons: ['Devis : à suivre, pas encore une dépense.'] };
  if (doc.doc_kind === 'sales_invoice_issued_by_us') return { action: 'not_an_expense_revenue', reasons: ['Facture émise par le riad : recette, pas dépense.'] };
  const dup = store.findSimilarExpenses({ supplier: doc.supplier, total: doc.total_ttc, docNumber: doc.doc_number });
  if (dup.length) reasons.push(`Doublon possible : déjà saisi le ${dup[0].at.slice(0, 10)} (${dup[0].total} DH).`);
  const past = store.supplierHistory(doc.supplier).map((e) => e.total).filter(Number.isFinite);
  if (past.length >= 2 && doc.total_ttc) {
    const avg = past.reduce((a, b) => a + b, 0) / past.length;
    if (doc.total_ttc > avg * 1.4) reasons.push(`Montant inhabituel : ${doc.total_ttc} DH contre ${avg.toFixed(0)} DH en moyenne chez ce fournisseur.`);
  }
  if (!doc.arithmetic_ok) reasons.push('Erreur de calcul détectée : vérifier avec le fournisseur avant de payer.');
  return { action: reasons.length ? 'draft_needs_review' : 'draft_ready', reasons };
}
