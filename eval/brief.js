// Live evaluation of the morning brief (calls Meta Model API).
// Builds the brief for the fictional demo day several times and measures what the code
// checks had to do: lines citing an unknown fact, numbers the model changed, urgent facts it
// left out. Then writes the guest messages for the proposed actions and checks each one
// (right language, check-in link exactly as given). Run: node eval/brief.js [runs]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dfa-eval-brief-'));
process.env.MANAGER_WHATSAPP = '212611111111';
delete process.env.WHATSAPP_TOKEN; // simulator: nothing is really sent

const store = await import('../src/store.js');
const wa = await import('../src/whatsapp.js');
const { runBrief, handleBriefReply } = await import('../src/brief.js');
const { usageTotals } = await import('../src/meta.js');
const { demoSeed, demoDay } = await import('../examples/demo-seed.js');

const RUNS = Number(process.argv[2] || 3);
const LANG = { it: /\b(Gentile|Buongiorno|arrivo|grazie|Suo)\b/i, fr: /\b(Bonjour|arrivée|vous|merci)\b/i };
let ok = 0; const totals = { lines: 0, dropped: 0, numberFixed: 0, urgentRestored: 0 };

for (let i = 1; i <= RUNS; i++) {
  store.reset(demoDay(demoSeed('212600000000')));
  wa.outbox.length = 0;
  const r = await runBrief();
  const fails = [];
  const urgentFacts = r.facts.filter((f) => f.kind === 'handoff' || (f.kind === 'arrival' && f.today && f.checkinPending));
  const urgentBlock = r.text.split("📅 Aujourd'hui")[0];
  for (const f of urgentFacts) if (!urgentBlock.includes(f.kind === 'handoff' ? 'Thomas' : 'Giulia')) fails.push(`${f.id} absent du bloc urgent`);
  if (!/509,80 DH/.test(r.text)) fails.push('facture 509,80 DH absente');
  totals.lines += (r.text.match(/^• /gm) || []).length;
  for (const fx of r.fixes) {
    if (fx.startsWith('dropped')) totals.dropped++;
    else if (fx.includes('not in fact')) totals.numberFixed++;
    else if (fx.startsWith('added')) totals.urgentRestored++;
  }
  // The manager answers "tout": each guest message must be in their language, with the exact link.
  await handleBriefReply('212611111111', 'tout');
  for (const a of r.actions) {
    const res = store.reservationById(a.reservation);
    const msg = wa.outbox.find((o) => o.to === res.phone)?.text || '';
    if (!LANG[res.lang]?.test(msg)) fails.push(`message à ${res.guestName} pas en ${res.lang}`);
    if (a.checkin && !msg.includes(`https://checkin.example/c/${res.checkinToken}`)) fails.push(`lien de check-in absent ou modifié (${res.guestName})`);
  }
  if (!fails.length) ok++;
  console.log(`${fails.length ? '❌' : '✅'} run ${i}: ${(r.text.match(/^• /gm) || []).length} lignes, ${r.actions.length} actions, corrections du code: ${r.fixes.join(' · ') || 'aucune'}${fails.length ? `\n   échec: ${fails.join(' ; ')}` : ''}`);
}
console.log(`\n${ok}/${RUNS} briefs corrects · ${totals.lines} lignes au total · corrigées par le code : ${totals.dropped} fait inconnu, ${totals.numberFixed} chiffre modifié, ${totals.urgentRestored} urgence oubliée`);
console.log(`${usageTotals.calls} appels API, ${usageTotals.input} tokens entrée / ${usageTotals.output} sortie`);
