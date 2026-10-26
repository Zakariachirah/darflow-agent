// Go live on WhatsApp from a laptop: starts the agent server, opens a free Cloudflare
// quick tunnel to it, and registers the tunnel URL as the app's WhatsApp webhook.
// Needs cloudflared (bin/cloudflared[.exe], $CLOUDFLARED or on PATH).
// Run: node scripts/live.js   — stop with Ctrl+C.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config, ROOT } from '../src/config.js';

const w = config.whatsapp;
const missing = ['token', 'phoneNumberId', 'verifyToken', 'appSecret', 'appId', 'businessAccountId'].filter((k) => !w[k]);
if (missing.length) { console.error('Missing in whatsapp.env:', missing.join(', ')); process.exit(1); }

await import('../src/server.js');

const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
const bin = process.env.CLOUDFLARED || [path.join(ROOT, 'bin', exe)].find((p) => fs.existsSync(p)) || exe;
const cf = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${config.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
cf.on('error', (e) => { console.error(`Cannot start cloudflared (${bin}): ${e.message}`); process.exit(1); });
process.on('SIGINT', () => { cf.kill(); process.exit(0); });

const url = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no tunnel URL after 60 s')), 60_000);
  const scan = (d) => { const m = String(d).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/); if (m) { clearTimeout(t); resolve(m[0]); } };
  cf.stdout.on('data', scan); cf.stderr.on('data', scan);
});
const callback = `${url}/webhook`;
console.log('Tunnel:', url);

// Wait until the tunnel actually reaches us (DNS can take a few seconds).
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${callback}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(w.verifyToken)}&hub.challenge=ping`);
    if ((await r.text()) === 'ping') break;
  } catch {}
  if (i > 30) { console.error('Tunnel not reachable.'); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2000));
}

const graph = (p, params, token) => fetch(`https://graph.facebook.com/${w.graphVersion}/${p}`, {
  method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(params),
}).then(async (r) => ({ ok: r.ok, body: await r.text() }));

// 1) the app's webhook for WhatsApp → this tunnel (Meta calls it once to verify)
const sub = await graph(`${w.appId}/subscriptions`, { object: 'whatsapp_business_account', callback_url: callback, verify_token: w.verifyToken, fields: 'messages' }, `${w.appId}|${w.appSecret}`);
// 2) the WhatsApp Business Account sends its events to this app
const waba = await graph(`${w.businessAccountId}/subscribed_apps`, {}, w.token);
console.log('Webhook registered:', sub.ok ? 'yes' : sub.body);
console.log('WhatsApp account subscribed:', waba.ok ? 'yes' : waba.body);
console.log(`\n✅ LIVE — write to the test number on WhatsApp. Manager inbox: http://127.0.0.1:${config.port}/manager\n   (keep this window open; Ctrl+C to stop)`);
