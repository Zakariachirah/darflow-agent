// WhatsApp Cloud API: send messages, download media, verify and parse webhooks.
// Without credentials every send is printed instead (simulator mode), so the whole
// agent can be developed and demoed before the business number is approved.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import * as store from './store.js';

const live = () => Boolean(config.whatsapp.token && config.whatsapp.phoneNumberId);
const graph = (p) => `https://graph.facebook.com/${config.whatsapp.graphVersion}/${p}`;
export const outbox = []; // simulator: last messages "sent"

async function graphPost(p, body) {
  const res = await fetch(graph(p), {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp ${res.status}: ${json?.error?.message || res.statusText}`);
  return json;
}

function record(to, kind, payload) {
  const m = { at: new Date().toISOString(), to: store.normPhone(to), kind, ...payload };
  outbox.push(m);
  if (outbox.length > 200) outbox.shift();
  store.log('wa_out', m);
  return m;
}

export async function sendText(to, text) {
  record(to, 'text', { text });
  if (!live()) { console.log(`📤 [WA sim → ${to}] ${text}`); return { simulated: true }; }
  return graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', to: store.normPhone(to), type: 'text', text: { body: text, preview_url: true },
  });
}

/** Business-initiated message outside the 24h window: must use an approved template. */
export async function sendTemplate(to, name, lang, params = [], fallbackText = '') {
  record(to, 'template', { template: name, lang, params, text: fallbackText });
  if (!live()) { console.log(`📤 [WA sim template ${name}/${lang} → ${to}] ${fallbackText}`); return { simulated: true }; }
  return graphPost(`${config.whatsapp.phoneNumberId}/messages`, {
    messaging_product: 'whatsapp', to: store.normPhone(to), type: 'template',
    template: { name, language: { code: lang }, components: params.length ? [{ type: 'body', parameters: params.map((t) => ({ type: 'text', text: String(t) })) }] : [] },
  });
}

export async function markRead(messageId) {
  if (!live() || !messageId) return;
  await graphPost(`${config.whatsapp.phoneNumberId}/messages`, { messaging_product: 'whatsapp', status: 'read', message_id: messageId }).catch(() => {});
}

/** Download an inbound media (voice note, photo) to a temp file. */
export async function downloadMedia(mediaId, ext = '') {
  const metaRes = await fetch(graph(mediaId), { headers: { Authorization: `Bearer ${config.whatsapp.token}` } });
  const meta = await metaRes.json();
  if (!meta.url) throw new Error('media url missing');
  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${config.whatsapp.token}` } });
  const buf = Buffer.from(await fileRes.arrayBuffer());
  const guess = ext || ({ 'audio/ogg': '.ogg', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' }[String(meta.mime_type).split(';')[0]] || '');
  const out = path.join(os.tmpdir(), `wa-${mediaId}${guess}`);
  fs.writeFileSync(out, buf);
  return { path: out, mime: meta.mime_type };
}

/** GET verification handshake. */
export function verifyChallenge(query) {
  if (query['hub.mode'] === 'subscribe' && query['hub.verify_token'] && query['hub.verify_token'] === config.whatsapp.verifyToken) return query['hub.challenge'];
  return null;
}

/** X-Hub-Signature-256 check (skipped only when no app secret is configured, e.g. simulator). */
export function validSignature(rawBody, header) {
  if (!config.whatsapp.appSecret) return true;
  if (!header?.startsWith('sha256=')) return false;
  const expected = crypto.createHmac('sha256', config.whatsapp.appSecret).update(rawBody).digest('hex');
  const a = Buffer.from(header.slice(7)); const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Flatten a webhook payload into simple inbound messages. */
export function parseWebhook(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map((c) => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const base = { id: m.id, from: m.from, name: names[m.from] || '', timestamp: m.timestamp, type: m.type };
        if (m.type === 'text') out.push({ ...base, text: m.text?.body || '' });
        else if (m.type === 'audio') out.push({ ...base, mediaId: m.audio?.id, voice: Boolean(m.audio?.voice) });
        else if (m.type === 'image') out.push({ ...base, mediaId: m.image?.id, caption: m.image?.caption || '' });
        else if (m.type === 'document') out.push({ ...base, mediaId: m.document?.id, caption: m.document?.caption || '', filename: m.document?.filename });
        else if (m.type === 'button') out.push({ ...base, type: 'text', text: m.button?.text || '' });
        else if (m.type === 'interactive') out.push({ ...base, type: 'text', text: m.interactive?.button_reply?.title || m.interactive?.list_reply?.title || '' });
        else out.push(base);
      }
    }
  }
  return out;
}
