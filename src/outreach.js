// Proactive pre-arrival outreach: N days before check-in, send each guest who has not
// completed online check-in a short message in their language with their personal link.
// Re-sends once, the day before arrival, if still not done. Never more than twice.
import { config } from './config.js';
import { structured } from './meta.js';
import * as store from './store.js';
import * as wa from './whatsapp.js';

const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const SCHEMA = { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string' } } };

async function compose(r, link, isReminder) {
  const { message } = await structured({
    model: config.meta.agentModel,
    instructions: `Write ONE short WhatsApp message from a small riad in Safi, Morocco, to a guest, in the guest's language (ISO code given). Warm but polite hospitality register (formal address: vous / usted / Sie / Lei), 2-3 sentences, at most one emoji. ${isReminder ? 'This is a gentle reminder: they arrive tomorrow.' : 'They arrive soon.'} Ask them to complete the online check-in (2 minutes, passport/ID) with the link, and to reply with their arrival time. Include the link exactly as given. Sign as "the team" of the riad, no riad name. Do not mention prices or anything else.`,
    content: [{ type: 'input_text', text: JSON.stringify({ lang: r.lang || 'en', firstName: (r.guestName || '').split(' ')[0], checkin: r.checkin, link }) }],
    schema: SCHEMA, name: 'outreach', effort: 'minimal',
  });
  return message.trim();
}

export function dueOutreach(today = day(0)) {
  const target = day(config.outreachDaysBefore);
  const tomorrow = day(1);
  return store.load().reservations.filter((r) => {
    if (r.status === 'cancelled' || r.checkinStatus === 'done' || !r.phone) return false;
    const sent = r.outreach || [];
    if (sent.length >= 2 || sent.some((s) => s.date === today)) return false;
    if (!sent.length) return r.checkin <= target && r.checkin >= today;
    return r.checkin === tomorrow; // single reminder the day before
  });
}

export async function runOutreach({ dryRun = false } = {}) {
  const results = [];
  for (const r of dueOutreach()) {
    const link = config.checkinBaseUrl + (r.checkinToken || r.id);
    const isReminder = (r.outreach || []).length > 0;
    const text = await compose(r, link, isReminder);
    if (!dryRun) {
      // Outside the 24h customer-service window WhatsApp requires an approved template;
      // in simulator mode (no credentials) the composed text is shown instead.
      if (config.whatsapp.checkinTemplate) await wa.sendTemplate(r.phone, config.whatsapp.checkinTemplate, r.lang || 'en', [(r.guestName || '').split(' ')[0], link], text);
      else await wa.sendText(r.phone, text);
      store.append(r.phone, 'agent', text, { outreach: true });
      store.updateReservation(r.id, { outreach: [...(r.outreach || []), { date: day(0), kind: isReminder ? 'reminder' : 'first' }] });
    }
    results.push({ reservation: r.id, guest: r.guestName, lang: r.lang, text });
  }
  return results;
}
