// Standalone maintenance page (inline HTML/CSS/JS, bilingual de/en). Served by the launcher while the app is
// unreachable, and by the app itself during maintenance mode. It polls /api/maintenance (connection errors, e.g.
// during a container swap, are tolerated) and reloads the original address as soon as the app answers normally.
// The language is chosen server-side from Accept-Language (English fallback) and passed via <html lang>.
// Script and style are static, so a strict CSP with hashes is used instead of 'unsafe-inline' (maintenanceHeaders()).
import { createHash } from 'node:crypto'

const STYLE = `:root{--bg:#faf6f1;--card:#fffdf9;--fg:#2b2521;--muted:#7a6e65;--accent:#d9653b;--track:#efe5da;--border:#eadfd3}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--card:#262220;--fg:#f3ece6;--muted:#a89b90;--accent:#f08a5d;--track:#3a332e;--border:#3a332e}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;padding:16px}
.card{width:100%;max-width:440px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:32px 28px;box-shadow:0 10px 30px rgba(60,40,20,.08);text-align:center}
.logo{font-weight:800;font-size:28px;letter-spacing:-.02em;margin:0 0 4px}.logo span{color:var(--accent)}
h1{font-size:19px;margin:18px 0 6px}p{margin:0;color:var(--muted)}
.bar{height:8px;border-radius:99px;background:var(--track);overflow:hidden;margin:22px 0 8px}
.bar i{display:block;height:100%;width:30%;background:var(--accent);border-radius:99px;transition:width .6s ease}
.bar.indet i{animation:slide 1.4s ease-in-out infinite}
@keyframes slide{0%{margin-left:-30%}100%{margin-left:100%}}
.step{font-size:14px;color:var(--muted);min-height:21px}
@media (prefers-reduced-motion:reduce){.bar.indet i{animation:none;width:100%;opacity:.5}}`

const SCRIPT = `(function(){
var en=document.documentElement.lang!=='de';
var T={
 de:{maintenance:'Wartung läuft',updating:'Wishy wird aktualisiert',restoring:'Sicherung wird wiederhergestellt',starting:'Wishy startet',restart_required:'Neustart erforderlich',failed:'Wishy ist gerade nicht erreichbar',
     sub:'Gleich geht es weiter. Diese Seite lädt sich automatisch neu.',subFailed:'Die Administration wurde informiert. Diese Seite versucht es weiter.',
     swap:'Container wird ausgetauscht – kurz keine Verbindung, das ist normal.',
     steps:{preflight:'Prüfe Voraussetzungen',metadata:'Prüfe Signatur',pull:'Lade neues Image',download:'Lade Update herunter',verify:'Prüfe Signatur',extract:'Entpacke',stop:'Stoppe App',backup:'Erstelle Sicherung',handover:'Übergebe an Update-Helfer',swap:'Tausche Container aus',create:'Erstelle neuen Container',start_new:'Starte neuen Container',start:'Starte neue Version',health:'Prüfe Funktion',activate:'Schließe ab',rollback:'Stelle vorherige Version wieder her',restore:'Spiele Sicherung ein'}},
 en:{maintenance:'Maintenance in progress',updating:'Wishy is updating',restoring:'Restoring a backup',starting:'Wishy is starting',restart_required:'Restart required',failed:'Wishy is currently unavailable',
     sub:'This will only take a moment. The page reloads automatically.',subFailed:'The administrator has been notified. This page keeps retrying.',
     swap:'Swapping containers – a short connection drop is expected.',
     steps:{preflight:'Checking requirements',metadata:'Verifying signature',pull:'Pulling new image',download:'Downloading update',verify:'Verifying signature',extract:'Unpacking',stop:'Stopping app',backup:'Creating backup',handover:'Handing over to update helper',swap:'Swapping containers',create:'Creating new container',start_new:'Starting new container',start:'Starting new version',health:'Checking health',activate:'Finishing',rollback:'Restoring previous version',restore:'Restoring backup'}}
}[en?'en':'de'];
function $(i){return document.getElementById(i)}
var lastState='maintenance';
function show(d){
 var st=d.state||lastState;lastState=st;
 $('t').textContent=T[st]||T.maintenance;
 $('m').textContent=st==='failed'?T.subFailed:T.sub;
 var step=d.step&&T.steps[d.step]?T.steps[d.step]:'';
 $('s').textContent=step+(d.target_version?(step?' · ':'')+'v'+d.target_version:'');
 var p=typeof d.progress==='number'?d.progress:null;
 $('b').className='bar'+(p===null?' indet':'');
 $('bi').style.width=p===null?'30%':Math.max(4,Math.round(p*100))+'%';
}
show({state:document.body.getAttribute('data-state')||'maintenance'});
var fails=0;
function poll(){
 fetch('/api/maintenance',{cache:'no-store',headers:{'Accept':'application/json'}}).then(function(r){return r.json()}).then(function(d){
  fails=0;
  if(d&&d.maintenance===false){location.reload();return}
  show(d||{});
 }).catch(function(){fails++;if(fails>1&&lastState==='updating')$('s').textContent=T.swap}).then(function(){setTimeout(poll,fails>20?5000:2000)});
}
setTimeout(poll,1500);
})();`

const hash = (s) => `'sha256-${createHash('sha256').update(s, 'utf8').digest('base64')}'`
const CSP = `default-src 'none'; script-src ${hash(SCRIPT)}; style-src ${hash(STYLE)}; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`

/** Security headers for the maintenance page (equivalent to server/headers.js, but with a hash-based CSP). */
export function maintenanceHeaders() {
  return { 'content-security-policy': CSP, 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'same-origin', 'cache-control': 'no-store' }
}

/** Picks 'de' or 'en' from an Accept-Language header value; English is the fallback. */
export function pickLang(acceptLanguage) {
  const items = String(acceptLanguage || '')
    .split(',')
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(';')
      const q = params.map((x) => x.trim()).find((x) => x.startsWith('q='))
      return { lang: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1, i }
    })
    .filter((x) => (x.lang === 'de' || x.lang === 'en') && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
  return items[0]?.lang || 'en'
}

export function maintenancePage({ state = 'maintenance', message = '', lang = 'en' } = {}) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
  return `<!doctype html>
<html lang="${lang === 'de' ? 'de' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${lang === 'de' ? 'Wishy – Wartung' : 'Wishy – Maintenance'}</title>
<style>${STYLE}</style></head>
<body data-state="${esc(state)}"><main class="card" role="status" aria-live="polite">
<div class="logo">Wishy<span>.</span></div>
<h1 id="t"></h1><p id="m"></p>
<div class="bar indet" id="b"><i id="bi"></i></div>
<div class="step" id="s"></div>
</main>
<script>${SCRIPT}</script>
<noscript><p>${esc(message || (lang === 'de' ? 'Wartung läuft – bitte später neu laden.' : 'Maintenance in progress – please reload later.'))}</p></noscript>
</body></html>`
}

/** CSP for plain HTML pages without script (emergency view) with exactly one inline style. */
export const staticPageCsp = (style) => `default-src 'none'; style-src ${hash(style)}; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`
