// Minimal manager inbox (local only): who needs a human, what the agent did, drafts to approve.
export function managerPage() {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DarFlow Agent — gérant</title>
<style>
:root{--bg:#f4f6f2;--card:#fff;--fg:#1b2a22;--mut:#5f6f65;--line:#dde3db;--green:#1f5a41;--gold:#a9771c;--red:#b0382c}
@media (prefers-color-scheme:dark){:root{--bg:#101814;--card:#17221c;--fg:#e6eee8;--mut:#9aab9f;--line:#2a3a31;--green:#6cc195;--gold:#e0b15a;--red:#ec7f72}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,Segoe UI,sans-serif;padding:16px}
h1{font-size:20px;margin:0 0 12px}h2{font-size:15px;margin:0 0 8px;color:var(--mut);text-transform:uppercase;letter-spacing:.05em}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px}
.item{border-top:1px solid var(--line);padding:8px 0}.item:first-of-type{border-top:0}
.tag{font-size:12px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);margin-right:6px}
.urgent{color:var(--red);border-color:var(--red)}.ok{color:var(--green);border-color:var(--green)}.warn{color:var(--gold);border-color:var(--gold)}
.msg{white-space:pre-wrap;margin:2px 0}.g{color:var(--mut)}textarea{width:100%;min-height:54px;margin-top:6px;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px}
button{margin-top:4px;border:1px solid var(--green);background:var(--green);color:var(--card);border-radius:6px;padding:5px 10px;cursor:pointer}
</style></head><body>
<h1>DarFlow Agent — boîte du gérant</h1>
<div class="grid">
<section><h2>À traiter par vous</h2><div id="ho"></div></section>
<section><h2>Demandes créées par l'agent</h2><div id="rq"></div></section>
<section><h2>Dépenses</h2><div id="ex"></div></section>
<section><h2>Conversations</h2><div id="cv"></div></section>
</div>
<script>
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
async function load(){
 const d=await (await fetch('/manager/data')).json();
 const open=d.handoffs.filter(h=>h.status==='open').reverse();
 // never wipe a reply the manager is typing (the page refreshes every 4 s)
 const typing=[...ho.querySelectorAll('textarea')].some(t=>t.value||t===document.activeElement);
 if(!typing) ho.innerHTML=open.length?open.map(h=>'<div class="item"><span class="tag '+(h.urgent?'urgent':'warn')+'">'+esc(h.reason)+'</span><b>+'+esc(h.phone)+'</b><div class="msg">'+esc(h.summary)+'</div><textarea id="r'+h.id+'" placeholder="Votre réponse au client"></textarea><button onclick="reply(\\''+h.phone+'\\',\\''+h.id+'\\')">Envoyer et rendre la main à l\\'agent</button></div>').join(''):'<p class="g">Rien à traiter.</p>';
 rq.innerHTML=d.requests.slice().reverse().map(r=>'<div class="item"><span class="tag ok">'+esc(r.kind)+'</span>'+esc(r.date||'')+' '+esc(r.time||'')+' · '+esc(r.people||'')+' pers. '+(r.totalDH?'· '+r.totalDH+' DH':'')+(r.dietary?'<div class="g">'+esc(r.dietary)+'</div>':'')+(r.from?'<div class="g">depuis '+esc(r.from)+'</div>':'')+'</div>').join('')||'<p class="g">Aucune.</p>';
 ex.innerHTML=d.expenses.slice().reverse().map(e=>'<div class="item"><span class="tag '+(e.status==='approved'?'ok':e.status==='rejected'?'urgent':'warn')+'">'+esc(e.status)+'</span><b>'+esc(e.supplier||'?')+'</b> · '+esc(e.total??'?')+' DH <span class="g">('+esc(e.source)+')</span>'+((e.reasons||[]).length?'<div class="g">'+esc(e.reasons.join(' · '))+'</div>':'')+'</div>').join('')||'<p class="g">Aucune.</p>';
 cv.innerHTML=Object.entries(d.conversations).map(([p,m])=>'<div class="item"><b>+'+esc(p)+'</b>'+m.slice(-6).map(x=>'<div class="msg"><span class="g">'+esc(x.role)+' :</span> '+esc(x.text)+'</div>').join('')+'</div>').join('')||'<p class="g">Aucune.</p>';
}
async function reply(phone,id){const t=document.getElementById('r'+id).value.trim();if(!t)return;
 await fetch('/manager/reply',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,text:t,release:true})});document.getElementById('r'+id).value='';document.activeElement.blur();load();}
load();setInterval(load,4000);
</script></body></html>`;
}
