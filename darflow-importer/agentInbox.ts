/**
 * DarFlow — boîte de réception de l'agent WhatsApp (darflow-agent).
 *
 * Quand le gérant valide une dépense sur WhatsApp (« OK »), l'agent dépose un fichier JSON dans un dossier
 * (contrat « darflow-agent/expense v1 »). DarFlow ne fait JAMAIS confiance au fichier : chaque élément repasse
 * par les fonctions métier habituelles (createExpense / createPurchase) avec leurs contrôles (montant, date,
 * caisse, doublons, justificatif) et leur journal d'audit. Un fichier importé est déplacé dans « imported/ ».
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Ctx } from '../context';
import { fail, int, isDate, str, today } from '../lib/util';
import { audit, getSetting } from './base';
import { checkAttachment, createExpense, createPurchase, saveSupplier } from './purchasing';

export interface AgentLine { label: string; amount_cents: number; category_code: string; vat_rate_bp?: number }
export interface AgentItem {
  source: 'darflow-agent'; version: 1; id: string;
  kind: 'expense' | 'purchase';
  date?: string | null; due_date?: string | null; doc_number?: string | null;
  supplier?: { name?: string | null; ice?: string | null } | null;
  payment_method?: 'CASH' | 'CARD' | 'TRANSFER' | null;
  lines: AgentLine[];
  attachment?: string | null;
  notes?: string[]; heard?: string | null;
}

export function inboxDir(ctx: Ctx): string {
  return String(getSetting<string>(ctx.db, 'agent_inbox_dir') || process.env.DARFLOW_AGENT_INBOX || join(homedir(), 'darflow-agent', 'data', 'darflow-inbox'));
}

function readItems(dir: string): { file: string; item?: AgentItem; error?: string }[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((file) => {
    try {
      const item = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      if (item?.source !== 'darflow-agent' || item?.version !== 1 || !Array.isArray(item.lines) || !item.lines.length) return { file, error: 'Fichier non reconnu' };
      return { file, item };
    } catch { return { file, error: 'Fichier illisible' }; }
  });
}

/** Aperçu de ce qui attend dans la boîte de réception (rien n'est écrit). */
export function listInbox(ctx: Ctx) {
  const dir = inboxDir(ctx);
  return { dir, items: readItems(dir).map(({ file, item, error }) => ({
    file, error: error ?? null, id: item?.id, kind: item?.kind, date: item?.date ?? null, supplier: item?.supplier?.name ?? null,
    total: item ? item.lines.reduce((s, l) => s + int(l.amount_cents), 0) : 0,
    lines: item?.lines.map((l) => ({ label: l.label, amount: int(l.amount_cents), category_code: l.category_code })) ?? [],
    has_attachment: !!item?.attachment, notes: item?.notes ?? [],
  })) };
}

function categoryId(ctx: Ctx, code: string): number {
  const c = ctx.db.get<any>('SELECT id FROM expense_categories WHERE code = ? AND active = 1', [code])
    ?? ctx.db.get<any>("SELECT id FROM expense_categories WHERE code = 'OTHER'");
  if (!c) fail('INVALID', `Catégorie inconnue : ${code}`);
  return c.id;
}

function supplierId(ctx: Ctx, s: AgentItem['supplier']): number | null {
  const name = str(s?.name); const ice = str(s?.ice);
  if (!name && !ice) return null;
  const found = ctx.db.get<any>('SELECT id FROM suppliers WHERE (? IS NOT NULL AND ice = ?) OR lower(name) = lower(?) LIMIT 1', [ice, ice, name ?? '']);
  if (found) return found.id;
  return Number(saveSupplier(ctx, { name: name || `ICE ${ice}`, ice, notes: "Créé par l'agent WhatsApp" }).id);
}

function importOne(ctx: Ctx, it: AgentItem) {
  const attachment = checkAttachment(it.attachment ?? null) ?? undefined;
  const date = it.date && isDate(it.date) && it.date <= today() ? it.date : today();
  const supplier_id = supplierId(ctx, it.supplier);
  const tag = `WhatsApp ${it.id}`;
  if (it.kind === 'purchase') {
    if (!supplier_id) fail('INVALID', 'Facture fournisseur sans fournisseur');
    // DarFlow computes purchases from HT: pick each HT so the VAT lands on the TTC read on the bill. A rate can make
    // an exact TTC impossible for one line (7 % of 169.93 rounds to 181.83); the last line absorbs that centime.
    const ttcOf = (h: number, bp: number) => h + Math.round(h * bp / 10000);
    const items = it.lines.map((l) => {
      const bp = Math.max(0, int(l.vat_rate_bp ?? 0)); const ttc = int(l.amount_cents); const r = Math.round(ttc * 10000 / (10000 + bp));
      const ht = [r, r - 1, r + 1].find((h) => ttcOf(h, bp) === ttc) ?? r;
      return { product: str(l.label) || 'Facture', qty: 1, unit_price_ht: ht, vat_rate_bp: bp };
    });
    const target = it.lines.reduce((s, l) => s + int(l.amount_cents), 0);
    const last = items[items.length - 1];
    const others = items.slice(0, -1).reduce((s, i) => s + ttcOf(i.unit_price_ht, i.vat_rate_bp), 0);
    const fix = [0, -1, 1, -2, 2].map((d) => last.unit_price_ht + d).find((h) => others + ttcOf(h, last.vat_rate_bp) === target);
    if (fix !== undefined) last.unit_price_ht = fix;
    const r = createPurchase(ctx, { supplier_id: supplier_id!, date, invoice_number: str(it.doc_number) ?? undefined, category_id: categoryId(ctx, [...it.lines].sort((a, b) => int(b.amount_cents) - int(a.amount_cents))[0].category_code),
      due_date: it.due_date && isDate(it.due_date) ? it.due_date : undefined, notes: [tag, ...(it.notes ?? [])].join(' · ').slice(0, 500), items, payment: 'CREDIT' });
    if (attachment) ctx.db.run('UPDATE purchases SET attachment = ? WHERE id = ?', [attachment, r.id]);
    return [{ type: 'purchase', ref: r.ref, total: r.ttc }];
  }
  return it.lines.map((l, i) => {
    const r = createExpense(ctx, { date, supplier_id, category_id: categoryId(ctx, l.category_code), description: `${str(l.label) ?? ''} (${tag})`.trim(),
      amount: int(l.amount_cents), amount_is: 'TTC', vat_rate_bp: Math.max(0, int(l.vat_rate_bp ?? 0)), payment_method: it.payment_method || 'CASH',
      attachment: i === 0 ? attachment : undefined, ocr: { engine: 'darflow-agent (Meta Muse)', supplier: it.supplier?.name ?? undefined, amount: int(l.amount_cents), date: it.date ?? undefined } });
    return { type: 'expense', ref: r.ref, total: r.ttc };
  });
}

/** Importe les fichiers en attente. Chaque fichier est une transaction : tout ou rien. */
export function importInbox(ctx: Ctx, a: { files?: string[] } = {}) {
  const dir = inboxDir(ctx);
  const done = join(dir, 'imported');
  const results: any[] = [];
  for (const { file, item, error } of readItems(dir)) {
    if (a.files && !a.files.includes(file)) continue;
    if (error || !item) { results.push({ file, ok: false, error }); continue; }
    try {
      const created = ctx.db.tx(() => importOne(ctx, item));
      mkdirSync(done, { recursive: true });
      renameSync(join(dir, file), join(done, file));
      writeFileSync(join(done, file.replace(/\.json$/, '.result.json')), JSON.stringify({ importedAt: new Date().toISOString(), created }, null, 2));
      audit(ctx, 'AGENT_INBOX_IMPORTED', 'agent_inbox', item.id, undefined, { created: created.map((c) => c.ref) });
      results.push({ file, ok: true, created });
    } catch (e: any) {
      results.push({ file, ok: false, error: e?.message || String(e), code: e?.code });
    }
  }
  return { dir, results, imported: results.filter((r) => r.ok).length };
}

/** Dates comptables que l'import toucherait (garde des mois clôturés). */
export function pendingDates(ctx: Ctx, a: { files?: string[] } = {}): string[] {
  return readItems(inboxDir(ctx)).filter((x) => x.item && (!a.files || a.files.includes(x.file)))
    .map((x) => (x.item!.date && isDate(x.item!.date) && x.item!.date <= today() ? x.item!.date : today()));
}
