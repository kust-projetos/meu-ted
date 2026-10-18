// offline-shell.js — SW fallback shell for offline navigation
// Reads location.pathname + IndexedDB snapshot, renders stale/read-only.
//
// T07b offline policy (SPEC §10, ADR-015; V4.1 Closure Phase 3 AUTH-02):
// mirrors the app's lock logic in plain JS (no bundle here). Preference is
// the V3 single-slot envelope (key "v3"): before rendering ANY financial
// data the shell requires (a) a non-empty offlinePrincipalId in localStorage
// (same key as the app, `pi-finance:offline-principal`), (b) a valid
// offlineWorkspaceId (same key as the app, `pi-finance:offline-workspace`)
// matching the envelope partition AND ownerKey ("v3:" + principal + ":" +
// workspace) — owner divergente → lock, nunca re-atribuição; (c) a fresh
// lastOnlineAuthenticatedAt within MAX_OFFLINE_AUTH_AGE (default 72h, same
// default as NEXT_PUBLIC_MAX_OFFLINE_AUTH_AGE_HOURS) plus the clock-skew
// allowance max(5min, 5% of max age). Legacy V2 envelopes (key "v2",
// subject partition `pi-finance:offline-subject`) keep their pre-existing
// T2.6 gates as fallback — never re-attributed, never promoted to V3.
// Expired/mismatched/corrupt envelopes → lock screen, never data. The shell
// NEVER writes: no age renewal offline (revalidation is online-only). No
// bearer, token, or secret value is read: identity keys partition,
// never authenticate.
(function(){
"use strict";
var DB="pi-finance-snapshot",STORE="snapshots",V3_KEY="v3",V2_KEY="v2";
var PRINCIPAL_KEY="pi-finance:offline-principal",WORKSPACE_KEY="pi-finance:offline-workspace";
var SUBJECT_KEY="pi-finance:offline-subject";
var MAX_AGE_HOURS=72;
var SKEW_FLOOR_MS=5*60*1000;
var LOCK_MESSAGE="offline session locked — reconecte para revalidar";
var TITLE={
  "/":"Resumo Financeiro","/registros":"Últimos Registros","/contas":"Contas",
  "/categorias":"Categorias","/a-pagar":"Contas a Pagar","/orcamentos":"Orçamentos",
  "/metas":"Metas Financeiras","/cartoes":"Faturas do Cartão","/assinaturas":"Assinaturas",
  "/patrimonio":"Patrimônio","/relatorios":"Relatórios","/perfil":"Perfil",
  "/compromissos":"Compromissos",
  "/hub":"Hub","/hub/patrimonio":"Contas e Cartões","/hub/planejamento":"Metas e Orçamento",
  "/hub/relatorios":"Relatórios","/hub/alertas":"Avisos e Lembretes",
  "/hub/categorias":"Organizar Gastos","/hub/configuracoes":"Configurações",
};
var DOMAIN={
  "/":"accounts","/registros":"transactions","/contas":"accounts",
  "/categorias":"categories","/a-pagar":"payables","/orcamentos":"budgets",
  "/metas":"goals","/cartoes":"cardStatements","/assinaturas":"subscriptions",
  "/patrimonio":"accounts","/relatorios":"transactions","/perfil":"accounts",
  "/compromissos":"payables",
  "/hub":"accounts","/hub/patrimonio":"accounts","/hub/planejamento":"budgets",
  "/hub/relatorios":"transactions","/hub/alertas":"payables",
  "/hub/categorias":"categories","/hub/configuracoes":"accounts",
};
function e(s){return(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")}
function f(c){return"R$ "+(Math.abs(c)/100).toLocaleString("pt-BR",{minimumFractionDigits:2})}
function r(){return window.location.pathname.split(/[?#]/)[0]}
function o(){
  return new Promise(function(res,rej){
    var r=indexedDB.open(DB,1);
    r.onupgradeneeded=function(){r.result.createObjectStore(STORE)};
    r.onsuccess=function(){res(r.result)};r.onerror=function(){rej(r.error)};
  });
}
function getEnv(db,key){
  // NOTE: never closes db here. The caller keeps the SAME connection open
  // through the whole V3→V2 selection and closes it once the decision
  // completes — closing after the V3 read would break the legacy fallback
  // (a transaction on a closed connection throws InvalidStateError).
  return new Promise(function(res){
    var req;
    try{req=db.transaction(STORE,"readonly").objectStore(STORE).get(key)}
    catch(e){res(null);return}
    req.onsuccess=function(){res(req.result||null)};
    req.onerror=function(){res(null)};
  });
}
/**
 * Strict V3 read (three-state): resolves {present,env} on success and
 * REJECTS on any read/open error (thrown exception or req.onerror). A failed
 * read NEVER coerces to "absent": falha não comprova ausência (main locks
 * instead of releasing V2). The error event is not swallowed: no
 * preventDefault/stopPropagation, the original error (or equivalent)
 * propagates to the caller.
 *
 * Presence is probed with openCursor(key) — NOT with get(): a stored
 * undefined value and a missing key BOTH make get() return undefined, so a
 * get()-based read cannot tell corruption apart from absence. A cursor is
 * null ONLY on true absence; otherwise cursor.value is returned verbatim
 * (even undefined/null/false/0/"") and falls through to the v3Ok validation
 * path, which locks it. No cursor.continue needed (single key); the
 * read-only transaction auto-completes.
 */
function getEnvStrict(db,key){
  return new Promise(function(res,rej){
    var req;
    try{req=db.transaction(STORE,"readonly").objectStore(STORE).openCursor(key)}
    catch(e){rej(e);return}
    req.onsuccess=function(){
      var cur=req.result||null;
      if(cur===null)res({present:false,env:null});
      else res({present:true,env:cur.value});
    };
    req.onerror=function(){rej(req.error||new Error("v3-read-error"))};
  });
}
function ls(k){
  try{return window.localStorage?window.localStorage.getItem(k):null}
  catch(e){return null}
}
function uuidOk(v){
  return typeof v==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}
function lock(){
  document.getElementById("content").innerHTML='<div class="empty">'+e(LOCK_MESSAGE)+'</div>';
  document.getElementById("synced-at").textContent="";
}
/** Fail-closed age check. Returns true only when the envelope may render. */
function ageOk(env){
  // Mirror the app reader (snapshot-db.ts evaluateOfflineLock): the stamp
  // must be a string BEFORE parsing — Date.parse coerces non-strings
  // (e.g. [validIso] → validIso) and would render corrupted envelopes.
  if(!env||typeof env.lastOnlineAuthenticatedAt!=="string")return false;
  var at=Date.parse(env.lastOnlineAuthenticatedAt);
  if(isNaN(at))return false;
  var maxMs=MAX_AGE_HOURS*3600*1000;
  var skew=Math.max(SKEW_FLOOR_MS,maxMs*0.05);
  var age=Math.max(0,Date.now()-at);
  return age<=maxMs+skew;
}
/**
 * V3 gate (T07b): the envelope may render only for the online-linked
 * principal/workspace pair. Any present-but-unrenderable V3 (divergent
 * owner, invalid age, corrupt shape) fails closed to the lock screen —
 * never served, never re-attributed, never renewed offline.
 */
function v3Ok(env,principal,workspace){
  if(!env||env.schema!==3||!env.domains)return false;
  if(typeof principal!=="string"||!principal)return false;
  if(!uuidOk(workspace))return false;
  if(env.offlinePrincipalId!==principal)return false;
  if(env.offlineWorkspaceId!==workspace)return false;
  if(env.ownerKey!==("v3:"+principal+":"+workspace))return false;
  return ageOk(env);
}
function render(env,route,title,dom){
  var synced=env.syncedAt&&env.syncedAt[dom];
  document.getElementById("synced-at").textContent="Sincronizado em: "+(synced?new Date(synced).toLocaleString("pt-BR"):"—");
  var data=env.domains[dom];
  if(!data)data=env.domains.accounts;
  if(Array.isArray(data&&data.items))data=data.items;
  if(!data||!data.length){document.getElementById("content").innerHTML='<div class="empty">Nenhum registro offline</div>';return}
  var c=document.getElementById("content");c.innerHTML="";
  for(var i=0;i<Math.min(data.length,50);i++){
    var it=data[i],d=document.createElement("div");d.className="item";
    var h='<div class="label">'+e(it.description||it.name||it.id)+'</div>';
    if(it.amountCents!==void 0)h+='<div class="amount">'+f(it.amountCents)+'</div>';
    if(it.status)h+='<div class="sub">Status: '+e(it.status)+'</div>';
    if(it.dueDate)h+='<div class="sub">Venc: '+e(it.dueDate)+'</div>';
    d.innerHTML=h;c.appendChild(d);
  }
  if(data.length>50){var p=document.createElement("p");p.className="sub";p.style.cssText="text-align:center;padding:12px";p.textContent="… e mais "+(data.length-50)+" itens";c.appendChild(p);}
}
async function main(){
  var route=r(),title=TITLE[route],dom=DOMAIN[route];
  if(title===void 0&&route.indexOf("/hub/")===0){title="Hub";dom=dom||"accounts"}
  if(title===void 0){title="Desconhecido"}
  document.getElementById("page-title").textContent=title;
  document.getElementById("page-route").textContent=route;
  var db;
  try{db=await o()}catch{document.getElementById("content").innerHTML='<div class="empty">Snapshot não disponível</div>';return}
  // V3 single-slot first: only the online-linked principal/workspace renders.
  // The SAME IndexedDB connection stays open through the entire V3→V2
  // decision; it is closed exactly once when selection completes (finally).
  // Three-state V3 read: genuine absence (present:false) is the ONLY state
  // that enables the V2 fallback — a read ERROR locks (no render, no V2).
  var v3=null,env=null,v3Verified=false,v3Present=false;
  try{
    var got=await getEnvStrict(db,V3_KEY);
    v3Verified=true;
    v3Present=got.present;
    if(got.present)v3=got.env;
    else env=await getEnv(db,V2_KEY);
  }catch(e){v3Verified=false}
  finally{try{db.close()}catch(e){}}
  if(!v3Verified){lock();return}
  if(v3Present){
    if(v3Ok(v3,ls(PRINCIPAL_KEY),ls(WORKSPACE_KEY))){render(v3,route,title,dom);return}
    lock();return;
  }
  // Legacy V2 fallback (T2.6 gates unchanged): subject partition + age
  // BEFORE any financial render. Never re-attributed, never promoted to V3.
  if(!env||!env.domains){document.getElementById("content").innerHTML='<div class="empty">Nenhum dado offline</div>';return}
  var subject=ls(SUBJECT_KEY);
  if(!uuidOk(subject)){lock();return}
  if(env.offlineSubjectId!==subject){lock();return}
  if(!ageOk(env)){lock();return}
  render(env,route,title,dom);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",main);else main();
})();
