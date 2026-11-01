// Morning brief: every morning the agent looks at the riad's day on its own, decides what
// matters, sends the manager ONE WhatsApp message, and proposes actions. The manager answers
// with a number ("1", "1 2", "tout") and the agent carries them out.
//
// Verifiable by design:
// - the facts are collected by code from the store (no model involved);
// - Muse Spark only ranks and phrases them, each line citing one fact id;
// - code checks every line: unknown fact → dropped; a number not present in the fact → the
//   line is replaced by the fact's own text; an urgent fact the model left out → added back;
// - the actions are built by code, never by the model, and run only after the manager's reply.
import { config } from './config.js';
import { structured } from './meta.js';
import * as store from './store.js';
import * as wa from './whatsapp.js';

const DAY = 864e5;
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (dateStr, n) => iso(new Date(Date.parse(dateStr + 'T12:00:00Z') + n * DAY));
const first = (name) => String(name || '').split(' ')[0] || 'le client';
const dh = (n) => `${Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} DH`;
const ddmm = (d) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

/** Who receives the brief: the manager, else the first staff number, else the demo phone. */
export function managerPhone() {
  const list = (v) => String(v || '').split(',').map(store.normPhone).filter(Boolean);
  return list(config.managerPhone)[0] || list(process.env.STAFF_WHATSAPP)[0] || list(process.env.DEMO_WHATSAPP)[0] || '';
}

/** Deterministic: what is true about the riad today. Each fact has an id, an urgency floor and a French text. */
export function collectFacts(today = iso(new Date())) {
  const s = store.load();
  const tomorrow = addDays(today, 1);
  const facts = [];
  const add = (kind, text, extra = {}) => facts.push({ id: `f${facts.length + 1}`, kind, text, ...extra });

  for (const r of s.reservations) {
    if (r.status === 'cancelled') continue;
    if (r.checkin === today || r.checkin === tomorrow) {
      const when = r.checkin === today ? "aujourd'hui" : 'demain';
      const people = (r.adults || 0) + (r.children || 0);
      const late = r.arrivalTime && r.arrivalTime >= '22:00';
      const parts = [`Arrivée ${when} : ${first(r.guestName)}, ${r.room || 'chambre ?'}, ${people} pers.`];
      parts.push(r.arrivalTime ? `heure d'arrivée ${r.arrivalTime}${late ? ' (arrivée tardive)' : ''}` : "heure d'arrivée inconnue");
      parts.push(r.checkinStatus === 'done' ? 'check-in en ligne fait' : 'check-in en ligne PAS fait');
      add('arrival', parts.join(', '), { reservation: r.id, today: r.checkin === today, late: !!late, checkinPending: r.checkinStatus !== 'done', noArrivalTime: !r.arrivalTime });
    }
    if (r.checkout === today) add('departure', `Départ aujourd'hui : ${first(r.guestName)}, ${r.room || 'chambre ?'}`, { reservation: r.id });
  }
  for (const q of s.requests) {
    if (q.status === 'cancelled') continue;
    if (q.kind === 'dinner' && q.date === today) {
      const r = store.reservationById(q.reservation);
      add('dinner', `Dîner ce soir à ${q.time} : ${q.people} pers. (${first(r?.guestName)})${q.dietary ? `, ${q.dietary}` : ''}`, { request: q.id });
    }
    if (q.kind === 'transfer' && q.status === 'pending') {
      const r = store.reservationById(q.reservation);
      add('transfer', `Transfert à organiser pour ${first(r?.guestName)}${q.date ? ` le ${ddmm(q.date)}` : ''}${q.time ? ` à ${q.time}` : ''}${q.from ? ` depuis ${q.from}` : ''}`, { request: q.id });
    }
  }
  for (const h of s.handoffs.filter((x) => x.status === 'open')) {
    const r = store.reservationByPhone(h.phone);
    const hours = Math.max(1, Math.round((Date.now() - Date.parse(h.at)) / 36e5));
    add('handoff', `${first(r?.guestName || h.guestName)} attend ta réponse depuis ${hours} h : ${String(h.summary || h.reason || '').slice(0, 120)}`, { urgentFloor: true });
  }
  const drafts = s.expenses.filter((e) => e.status === 'draft');
  if (drafts.length) add('drafts', `${drafts.length} dépense(s) en attente de ton OK, total ${dh(drafts.reduce((t, e) => t + (Number(e.total) || 0), 0))}`);
  for (const e of s.expenses) {
    if (!e.dueDate || e.status === 'rejected' || e.paid) continue;
    if (!['utility_bill', 'supplier_invoice'].includes(e.docKind)) continue;
    const days = Math.round((Date.parse(e.dueDate) - Date.parse(today)) / DAY);
    if (days > 7) continue;
    const label = days < 0 ? `en retard de ${-days} jour(s)` : days === 0 ? "à payer aujourd'hui" : `à payer dans ${days} jour(s)`;
    add('bill', `Facture ${e.supplier || 'fournisseur'} ${dh(e.total)} ${label} (échéance ${ddmm(e.dueDate)})`, { urgentFloor: days <= 1 });
  }
  return facts;
}

/** Deterministic: actions the agent may take, each needing the manager's go-ahead. */
export function proposeActions(facts, today = iso(new Date())) {
  const actions = [];
  const todo = facts.filter((x) => x.kind === 'arrival' && (x.checkinPending || x.noArrivalTime))
    .sort((a, b) => (b.checkinPending - a.checkinPending) || (b.today - a.today)); // missing check-in first, then today's
  for (const f of todo) {
    const r = store.reservationById(f.reservation);
    if (!r?.phone || (r.outreach || []).some((o) => o.date === today)) continue;
    const asks = [f.checkinPending && 'check-in en ligne', f.noArrivalTime && "heure d'arrivée"].filter(Boolean);
    actions.push({ n: actions.length + 1, kind: 'guest_nudge', reservation: r.id, checkin: !!f.checkinPending, arrivalTime: !!f.noArrivalTime, label: `Écrire à ${first(r.guestName)} (${r.lang || 'en'}) : ${asks.join(' + ')}` });
  }
  return actions;
}

const SCHEMA = {
  type: 'object', additionalProperties: false, required: ['headline', 'items'],
  properties: {
    headline: { type: 'string' },
    items: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['fact', 'urgency', 'line'], properties: {
      fact: { type: 'string' }, urgency: { type: 'string', enum: ['urgent', 'today', 'info'] }, line: { type: 'string' } } } },
  },
};

const nums = (t) => (String(t).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => x.replace(',', '.').replace(/^0+(?=\d)/, ''));

/** Code checks the model's brief against the facts. Returns the cleaned items. */
export function verifyItems(items, facts) {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const out = []; const seen = new Set(); const fixes = [];
  for (const it of items || []) {
    const f = byId.get(it.fact);
    if (!f || seen.has(f.id)) { fixes.push(`dropped ${it.fact}`); continue; }
    seen.add(f.id);
    const allowed = new Set(nums(f.text));
    const invented = nums(it.line).filter((n) => !allowed.has(n));
    const urgency = f.urgentFloor ? 'urgent' : it.urgency;
    if (invented.length) fixes.push(`${f.id}: ${invented.join(',')} not in fact`);
    out.push({ fact: f.id, urgency, line: invented.length || !it.line.trim() ? f.text : it.line.trim() });
  }
  for (const f of facts) if (f.urgentFloor && !seen.has(f.id)) { out.push({ fact: f.id, urgency: 'urgent', line: f.text }); fixes.push(`added ${f.id}`); }
  return { items: out, fixes };
}

export function render({ today, headline, items, actions }) {
  const lines = [`☀️ Brief du ${ddmm(today)}`, headline || ''];
  const group = (u, title) => { const g = items.filter((i) => i.urgency === u); if (g.length) lines.push('', title, ...g.map((i) => `• ${i.line}`)); };
  group('urgent', '🔴 Urgent'); group('today', "📅 Aujourd'hui"); group('info', 'ℹ️ À savoir');
  if (actions.length) lines.push('', 'Je peux m\'en occuper — réponds avec le(s) numéro(s), ou « tout » :', ...actions.map((a) => `${a.n}. ${a.label}`));
  return lines.filter((l, i) => l !== '' || i > 1).join('\n').trim();
}

/** Build the brief (one Muse Spark call), save the proposed actions, send it to the manager. */
export async function runBrief({ today = iso(new Date()), dryRun = false, compose = composeWithModel } = {}) {
  const facts = collectFacts(today);
  const actions = proposeActions(facts, today);
  let headline = 'Journée calme : rien à signaler.'; let items = []; let fixes = [];
  if (facts.length) {
    const draft = await compose(facts, today);
    ({ items, fixes } = verifyItems(draft.items, facts));
    headline = draft.headline;
  }
  const text = render({ today, headline, items, actions });
  const to = managerPhone();
  if (!dryRun) {
    const s = store.load(); s.brief = { date: today, sentAt: new Date().toISOString(), to, actions }; store.save();
    store.log('brief', { facts: facts.length, actions: actions.length, fixes });
    if (to) { await wa.sendText(to, text); store.append(to, 'agent', text, { brief: true }); }
  }
  return { text, facts, actions, fixes, to };
}

async function composeWithModel(facts, today) {
  return structured({
    model: config.meta.agentModel,
    instructions: `You are the assistant of the manager of a small riad (guesthouse) in Morocco. It is the morning of ${today}.
Below are today's facts, each with an id. Decide what matters most and write the manager's morning brief in French, informal ("tu"), short WhatsApp style.
- headline: one sentence that sums up the day (e.g. how busy it is, the one thing not to forget).
- items: one per fact worth mentioning, most important first, each citing exactly one fact id in "fact".
  urgency "urgent" = needs action before noon (a guest waiting for an answer, a bill due today or overdue, an arrival today without online check-in, a late arrival with no one to welcome);
  "today" = happens today; "info" = good to know.
- line: rewrite the fact as one natural French sentence with normal punctuation, at most 15 words (e.g. "Giulia arrive aujourd'hui (Suite Patio, 2 pers.) : check-in pas fait, heure inconnue."). Translate anything not in French. Use ONLY information from that fact; keep its numbers, names, times and amounts exactly; never add anything.`,
    content: [{ type: 'input_text', text: JSON.stringify(facts.map(({ id, kind, text }) => ({ id, kind, text }))) }],
    schema: SCHEMA, name: 'morning_brief', effort: 'low',
  });
}

const NUDGE_SCHEMA = { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } };

async function composeNudge(r, a) {
  const { message } = await structured({
    model: config.meta.agentModel,
    instructions: `Write ONE short WhatsApp message from a small riad in Morocco to a guest, in the guest's language (ISO code given), formal address (vous / usted / Sie / Lei), 2 sentences, at most one emoji. They arrive on the date given. ${a.checkin ? 'Ask them to complete the online check-in (2 minutes) with the link, included exactly as given. ' : ''}${a.arrivalTime ? 'Ask them what time they expect to arrive, so someone can welcome them. ' : ''}Sign as "the team". Nothing else.`,
    content: [{ type: 'input_text', text: JSON.stringify({ lang: r.lang || 'en', firstName: first(r.guestName), checkin: r.checkin, link: a.checkin ? config.checkinBaseUrl + (r.checkinToken || r.id) : undefined }) }],
    schema: NUDGE_SCHEMA, name: 'nudge', effort: 'minimal',
  });
  return message.trim();
}

/** "1", "1 3", "1,2", "1 et 2", "tout" → action numbers; null if the text is not an answer to the brief. */
export function parseChoice(text, count) {
  const t = String(text || '').trim().toLowerCase();
  if (!count) return null;
  if (['tout', 'tous', 'all', 'koulchi', 'kolchi', 'كلشي'].includes(t)) return Array.from({ length: count }, (_, i) => i + 1);
  if (!/^\d+(\s*(,|et|and|w|و|\+|&|\s)\s*\d+)*$/.test(t)) return null;
  const picked = [...new Set((t.match(/\d+/g) || []).map(Number))];
  return picked.every((n) => n >= 1 && n <= count) ? picked : null;
}

/** Called by the router for the manager's reply. Returns null if it isn't an answer to today's brief. */
export async function handleBriefReply(from, text, { today = iso(new Date()), compose = composeNudge } = {}) {
  const b = store.load().brief;
  if (!b || b.date !== today || store.normPhone(from) !== store.normPhone(b.to)) return null;
  const open = b.actions.filter((a) => !a.done);
  const picked = parseChoice(text, b.actions.length);
  if (!picked) return null;
  const done = [];
  for (const n of picked) {
    const a = b.actions.find((x) => x.n === n);
    if (!a || a.done) continue;
    const r = store.reservationById(a.reservation);
    if (!r?.phone) continue;
    const msg = await compose(r, a);
    if (a.checkin && config.whatsapp.checkinTemplate) await wa.sendTemplate(r.phone, config.whatsapp.checkinTemplate, r.lang || 'en', [first(r.guestName), config.checkinBaseUrl + (r.checkinToken || r.id)], msg);
    else await wa.sendText(r.phone, msg);
    store.append(r.phone, 'agent', msg, { brief: true });
    store.updateReservation(r.id, { outreach: [...(r.outreach || []), { date: today, kind: 'brief' }] });
    a.done = new Date().toISOString();
    done.push(`✔ ${a.label.replace(/^Écrire à/, 'Message envoyé à')}`);
  }
  store.save();
  store.log('brief_actions', { picked, done: done.length, open: open.length });
  const reply = done.length ? done.join('\n') : 'Déjà fait ✔';
  await wa.sendText(from, reply);
  return reply;
}
