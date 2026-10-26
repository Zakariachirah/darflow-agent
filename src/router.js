// Routes every inbound WhatsApp message to the right agent:
// - staff numbers  → back-office (invoice photos, spoken expenses, "OK" to approve)
// - everyone else  → guest concierge (text or voice note in any language)
import fs from 'node:fs';
import { config } from './config.js';
import * as store from './store.js';
import * as wa from './whatsapp.js';
import { transcribeAudio } from './audio.js';
import { handleGuestMessage } from './agents/guest.js';
import { readDocuments, readExpenseText, decide } from './agents/expense.js';
import { exportApproved } from './adapters/darflow.js';
import path from 'node:path';

const staff = () => String(process.env.STAFF_WHATSAPP || config.managerPhone || '').split(',').map(store.normPhone).filter(Boolean);
// Demo numbers (DEMO_WHATSAPP) can switch role with "#staff" / "#client", so one phone
// can show both sides of the riad during a demo. Everyone else's role is fixed.
const demo = () => String(process.env.DEMO_WHATSAPP || '').split(',').map(store.normPhone).filter(Boolean);
const roleOverride = (phone) => (store.load().roles || {})[store.normPhone(phone)];
export const isStaff = (phone) => {
  const o = roleOverride(phone);
  if (o && demo().includes(store.normPhone(phone))) return o === 'staff';
  return staff().includes(store.normPhone(phone));
};

const ACTION_FR = {
  reject: '⛔ À ne PAS enregistrer',
  ask_new_photo: '📷 Photo à reprendre',
  track_quote: '📝 Devis enregistré pour suivi (pas une dépense)',
  not_an_expense_revenue: '↩️ Ce n\'est pas une dépense : facture émise par le riad (recette)',
  draft_needs_review: '⚠️ Brouillon de dépense — à vérifier',
  draft_ready: '✅ Brouillon de dépense prêt',
};

function money(n) { return n == null ? '?' : `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH`; }

function staffSummary({ doc, decision, expense }) {
  const lines = [`${ACTION_FR[decision.action] || decision.action}`];
  if (doc.supplier) lines.push(`Fournisseur : ${doc.supplier}`);
  if (doc.date) lines.push(`Date : ${doc.date}${doc.due_date ? ` · à payer avant le ${doc.due_date}` : ''}`);
  if (doc.lines?.length) lines.push(...doc.lines.slice(0, 6).map((l) => `• ${l.label} : ${money(l.amount)}`));
  lines.push(`Total TTC : ${money(doc.total_ttc ?? doc.total)}`);
  // The policy line already states quote / revenue / fake: drop the model's restatement of it.
  const restates = { track_quote: /devis|quote/i, not_an_expense_revenue: /émise par le riad|recette|revenue/i, reject: /fictif|sp[ée]cimen|fake/i }[decision.action];
  const notes = [...(decision.reasons || []), ...(doc.anomalies || []).filter((a) => !(restates && restates.test(a) && !/\d/.test(a)))];
  if (notes.length) lines.push('', 'À noter :', ...notes.slice(0, 5).map((a) => `– ${a}`));
  if (expense) lines.push('', 'Répondez « OK » pour l\'enregistrer dans DarFlow, ou « NON » pour l\'annuler.');
  return lines.join('\n');
}

async function handleStaff(msg) {
  const from = msg.from;
  if (msg.type === 'image' || msg.type === 'document') {
    const media = msg.localPath ? { path: msg.localPath } : await wa.downloadMedia(msg.mediaId);
    const { segmentation, results } = await readDocuments(media.path);
    store.log('segmentation', { by: from, prompt: segmentation, documents: results.length });
    const many = results.length > 1;
    if (many) await wa.sendText(from, `📄 ${results.length} documents trouvés sur la photo, je les lis un par un.`);
    for (const [i, { doc, decision, crop }] of results.entries()) {
      const draftable = decision.action.startsWith('draft');
      const expense = draftable ? store.addExpense({ source: 'photo', by: from, docKind: doc.doc_kind, supplier: doc.supplier, supplierIce: doc.supplier_ice, docNumber: doc.doc_number, date: doc.date, dueDate: doc.due_date, total: doc.total_ttc, category: doc.category, lines: doc.lines, anomalies: doc.anomalies, reasons: decision.reasons }) : null;
      if (expense && crop) { // keep the cropped sheet as the voucher DarFlow attaches to the expense
        const dir = path.join(config.dataDir, 'attachments'); fs.mkdirSync(dir, { recursive: true });
        expense.attachmentPath = path.join(dir, `${expense.id}.jpg`); fs.copyFileSync(crop, expense.attachmentPath); store.save();
      }
      if (!draftable) store.log('document_not_booked', { by: from, kind: doc.doc_kind, action: decision.action, supplier: doc.supplier, total: doc.total_ttc });
      await wa.sendText(from, (many ? `Document ${i + 1}/${results.length}\n` : '') + staffSummary({ doc, decision, expense }));
    }
    return null;
  }
  let text = msg.text || '';
  if (msg.type === 'audio') {
    const audioPath = msg.localPath || (await wa.downloadMedia(msg.mediaId, '.ogg')).path;
    text = (await transcribeAudio(audioPath)).text;
    if (!text) return wa.sendText(from, "Je n'ai pas compris la note vocale. Pouvez-vous la renvoyer ?");
  }
  const cmd = text.trim().toUpperCase();
  // OK / NON answers every draft this person is currently looking at (one photo can hold several).
  const recent = Date.now() - 2 * 3600e3;
  const drafts = store.load().expenses.filter((e) => e.status === 'draft' && store.normPhone(e.by) === store.normPhone(from) && Date.parse(e.at || e.createdAt || 0) >= recent);
  const pending = drafts.at(-1);
  if (['OK', 'OUI', 'WAKHA', 'واخا'].includes(cmd) && pending) {
    const at = new Date().toISOString();
    for (const d of drafts) Object.assign(d, { status: 'approved', approvedAt: at });
    // Hand each approved expense to DarFlow (inbox file); DarFlow imports it with its own checks.
    let sent = 0;
    for (const d of drafts) {
      try { d.darflowFile = exportApproved(d); sent++; } catch (e) { store.log('darflow_export_failed', { expense: d.id, message: e.message }); }
    }
    store.save();
    const label = (d) => `${d.supplier || d.lines?.map((l) => l.label).join(', ') || 'Dépense'} — ${money(d.total)}`;
    const toDarFlow = sent === drafts.length ? '\n📥 Envoyé à DarFlow (Dépenses → WhatsApp).' : '';
    return wa.sendText(from, (drafts.length === 1 ? `Enregistré ✔ ${label(pending)}.` : `Enregistrés ✔\n${drafts.map((d) => `• ${label(d)}`).join('\n')}`) + toDarFlow);
  }
  if (['NON', 'NO', 'LA', 'لا'].includes(cmd) && pending) {
    for (const d of drafts) d.status = 'rejected';
    store.save();
    return wa.sendText(from, drafts.length === 1 ? 'Brouillon annulé.' : `${drafts.length} brouillons annulés.`);
  }
  const r = await readExpenseText(text);
  if (!r.is_expense) return wa.sendText(from, `Note reçue : « ${text} ». Ce n'est pas une dépense, je la transmets au gérant.`);
  const doc = { supplier: r.supplier, date: r.date, total_ttc: r.total, lines: r.items.map((i) => ({ label: `${i.qty ?? '?'} × ${i.label}`, amount: i.qty != null && i.unit_price != null ? i.qty * i.unit_price : null })), anomalies: r.missing, arithmetic_ok: true, doc_kind: 'receipt', confidence: 1, category: r.category };
  const decision = r.total == null ? { action: 'draft_needs_review', reasons: ['Montant total manquant.'] } : decide(doc);
  const expense = store.addExpense({ source: msg.type === 'audio' ? 'voice' : 'text', heard: text, by: from, supplier: r.supplier, date: r.date, total: r.total, category: r.category, paymentMethod: r.payment_method, lines: doc.lines });
  const heard = msg.type === 'audio' ? `🎙️ J'ai compris : « ${text} »\n\n` : '';
  return wa.sendText(from, heard + staffSummary({ doc, decision, expense }));
}

async function handleGuest(msg) {
  let text = msg.text || '';
  if (msg.type === 'audio') {
    const audioPath = msg.localPath || (await wa.downloadMedia(msg.mediaId, '.ogg')).path;
    const t = await transcribeAudio(audioPath, { languageBias: [] });
    text = t.text ? `[voice note] ${t.text}` : '';
  } else if (msg.type === 'image' || msg.type === 'document') {
    text = `[the guest sent a ${msg.type}${msg.caption ? ` with the caption: "${msg.caption}"` : ''}; you cannot see it — hand off to the manager if it needs a human]`;
  } else if (msg.type !== 'text') {
    text = `[unsupported message type: ${msg.type}]`;
  }
  if (!text) return null;
  const reply = await handleGuestMessage(msg.from, text);
  if (reply) await wa.sendText(msg.from, reply);
  return reply;
}

export async function handleInbound(msg) {
  try {
    await wa.markRead(msg.id);
    store.log('wa_in', { from: store.normPhone(msg.from), type: msg.type, text: msg.text?.slice(0, 200) });
    const sw = (msg.text || '').trim().toLowerCase();
    if ((sw === '#staff' || sw === '#client') && demo().includes(store.normPhone(msg.from))) {
      const s = store.load(); s.roles = { ...(s.roles || {}), [store.normPhone(msg.from)]: sw.slice(1) }; store.save();
      return wa.sendText(msg.from, sw === '#staff'
        ? '🔧 Mode employé : envoyez une photo de facture ou une note vocale de dépense. « OK » pour valider.'
        : '🛎️ Mode client : vous parlez au concierge du riad.');
    }
    return isStaff(msg.from) ? await handleStaff(msg) : await handleGuest(msg);
  } catch (e) {
    store.log('error', { from: msg.from, message: String(e.message || e) });
    console.error('inbound error:', e);
    if (!isStaff(msg.from)) await wa.sendText(msg.from, 'Merci pour votre message 🙏 Le gérant vous répond très vite.').catch(() => {});
    return null;
  } finally {
    if (msg.localPath && msg.cleanup) fs.rm(msg.localPath, { force: true }, () => {});
  }
}
