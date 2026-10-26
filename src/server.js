// HTTP server: WhatsApp webhook + local simulator + small manager inbox.
import http from 'node:http';
import { config } from './config.js';
import * as wa from './whatsapp.js';
import * as store from './store.js';
import { handleInbound } from './router.js';
import { runOutreach } from './outreach.js';
import { managerPage } from './manager-page.js';

function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
// A tunnel (cloudflared) connects from localhost too: anything carrying proxy headers is remote.
const localOnly = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
  && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/webhook' && req.method === 'GET') {
      const ch = wa.verifyChallenge(Object.fromEntries(url.searchParams));
      if (ch) { res.writeHead(200); return res.end(ch); }
      res.writeHead(403); return res.end();
    }
    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      if (!wa.validSignature(raw, req.headers['x-hub-signature-256'])) { res.writeHead(401); return res.end(); }
      res.writeHead(200); res.end(); // acknowledge fast, process after
      for (const m of wa.parseWebhook(JSON.parse(raw.toString('utf8') || '{}'))) handleInbound(m).catch((e) => console.error('inbound failed:', e.message));
      return;
    }
    // ---- simulator & manager tools: local machine only ----
    if (!localOnly(req)) { res.writeHead(404); return res.end(); }
    if (url.pathname === '/sim/message' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      const msg = { id: `sim-${Date.now()}`, from: b.from, type: b.type || 'text', text: b.text, localPath: b.path };
      await handleInbound(msg);
      return json(res, 200, { sent: wa.outbox.filter((o) => o.to === store.normPhone(b.from)).slice(-3) });
    }
    if (url.pathname === '/sim/outreach' && req.method === 'POST') return json(res, 200, await runOutreach());
    if (url.pathname === '/manager/reply' && req.method === 'POST') {
      const b = JSON.parse((await readBody(req)).toString('utf8'));
      await wa.sendText(b.phone, b.text);
      store.append(b.phone, 'manager', b.text);
      if (b.release) store.closeHandoff(b.phone);
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/manager/data') return json(res, 200, { ...store.load(), outbox: wa.outbox.slice(-50) });
    if (url.pathname === '/' || url.pathname === '/manager') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(managerPage()); }
    res.writeHead(404); res.end();
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.log(`DarFlow Agent on http://127.0.0.1:${config.port}  (WhatsApp ${config.whatsapp.token ? 'LIVE' : 'simulator'})`);
});

// One failed WhatsApp call (expired token, missing permission, network) must never stop the agent.
process.on('unhandledRejection', (e) => { console.error('⚠️ ', e?.message || e); store.log('error', { message: String(e?.message || e) }); });
process.on('uncaughtException', (e) => { console.error('⚠️ ', e?.message || e); store.log('error', { message: String(e?.message || e) }); });

// Daily pre-arrival outreach at 10:00 local time (checks every 15 minutes).
setInterval(async () => {
  const now = new Date();
  if (now.getHours() === 10 && now.getMinutes() < 15) {
    try { const r = await runOutreach(); if (r.length) console.log('outreach sent:', r.length); } catch (e) { console.error('outreach', e.message); }
  }
}, 15 * 60 * 1000);
