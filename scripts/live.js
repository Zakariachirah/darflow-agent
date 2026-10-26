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

// Quick tunnels are free and occasionally fail to start: retry a few times, and never mistake
// cloudflared's own API address (api.trycloudflare.com, printed in its errors) for the tunnel.
let cf;
function openTunnel() {
  return new Promise((resolve, reject) => {
    cf = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${config.port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const errors = [];
    const t = setTimeout(() => { cf.kill(); reject(new Error(errors.slice(-3).join(' | ') || 'no tunnel URL after 45 s')); }, 45_000);
    const scan = (d) => {
      const s = String(d);
      for (const line of s.split('\n')) if (/\b(ERR|error|failed)\b/i.test(line)) errors.push(line.trim().slice(0, 200));
      const m = s.match(/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/);
      if (m) { clearTimeout(t); resolve(m[0]); }
    };
    cf.stdout.on('data', scan); cf.stderr.on('data', scan);
    cf.on('error', (e) => { clearTimeout(t); reject(new Error(`cannot start cloudflared (${bin}): ${e.message}`)); });
    cf.on('exit', (code) => { clearTimeout(t); reject(new Error(errors.slice(-3).join(' | ') || `cloudflared exited (${code})`)); });
  });
}
process.on('SIGINT', () => { cf?.kill(); process.exit(0); });

let url;
for (let attempt = 1; !url; attempt++) {
  try { url = await openTunnel(); }
  catch (e) {
    console.error(`Tunnel attempt ${attempt} failed: ${e.message}`);
    if (attempt >= 4) { console.error('Cloudflare quick tunnel unavailable right now. Try again in a few minutes.'); process.exit(1); }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
}
const callback = `${url}/webhook`;
console.log('Tunnel:', url);

// Wait until the tunnel actually reaches us (DNS can take a few seconds).
for (let i = 0; ; i++) {
  try {
    const r = await fetch(`${callback}?hub.mode=subscribe&hub.verify_token=${encodeURIComponent(w.verifyToken)}&hub.challenge=ping`);
    if ((await r.text()) === 'ping') break;
  } catch {}
  if (i > 45) { console.error('Tunnel not reachable (DNS not ready). Close this window and run go-live.cmd again.'); process.exit(1); }
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
