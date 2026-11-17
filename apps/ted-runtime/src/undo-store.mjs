import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export function createUndoStore({persistDir, filePath}={}) {
 const file=filePath||path.join(persistDir||'.','undo-proposals.json'); fs.mkdirSync(path.dirname(file),{recursive:true});
 let rows=[]; try { const parsed=JSON.parse(fs.readFileSync(file,'utf8')); if(Array.isArray(parsed)) rows=parsed; } catch(e){ if(e.code!=='ENOENT') throw Object.assign(new Error('undo store unavailable'),{code:'undo.unavailable'}); }
 function save(){const tmp=`${file}.${process.pid}.tmp`; fs.writeFileSync(tmp,JSON.stringify(rows)); fs.renameSync(tmp,file);}
 const same=(r,x)=>r.workspaceId===x.workspaceId&&r.actorId===x.actorId&&r.deviceId===x.deviceId;
  return {
   countByWorkspace(workspaceId){return rows.filter(r=>r.workspaceId===workspaceId).length;},
   proposeForConversation(x){
    const existing=rows.find(r=>r.workspaceId===x.workspaceId&&r.actorId===x.actorId&&r.conversationId===x.conversationId&&r.status==='proposed'&&Date.parse(r.expiresAt)>Date.now());
    if(existing)return structuredClone(existing);
    const r=this.create({...x,targetLastOperationId:null});
    const stored=rows.find(v=>v.requestId===r.requestId);
    stored.conversationId=x.conversationId;save();
    return structuredClone(stored);
   },
  create(x){const old=rows.find(r=>r.requestId===x.requestId); if(old){if(!same(old,x)) throw Object.assign(new Error('forbidden'),{code:'auth.workspace_forbidden'}); return structuredClone(old);} const now=Date.now(), r={requestId:x.requestId,workspaceId:x.workspaceId,actorId:x.actorId,deviceId:x.deviceId,...(x.targetLastOperationId?{targetLastOperationId:x.targetLastOperationId}:{}),idempotencyKey:randomUUID(),status:'proposed',expiresAt:new Date(now+600000).toISOString(),...(x.targetDisplay?{targetDisplay:x.targetDisplay}:{}),createdAt:new Date(now).toISOString()}; rows.push(r);save();return structuredClone(r);},
  active(x){const items=rows.filter(r=>same(r,x)&&['proposed','executing'].includes(r.status)&&Date.parse(r.expiresAt)>Date.now()).map(r=>({requestId:r.requestId,status:r.status,expiresAt:r.expiresAt,...(r.targetDisplay?{target:r.targetDisplay}:{})})); return {items,total:items.length};},
  get(id,x){const r=rows.find(r=>r.requestId===id); if(!r)return null; if(!same(r,x))throw Object.assign(new Error('forbidden'),{code:'auth.workspace_forbidden'});return structuredClone(r);},
  transition(id,x,from,to,patch={}){const r=rows.find(r=>r.requestId===id);if(!r)return null;if(!same(r,x))throw Object.assign(new Error('forbidden'),{code:'auth.workspace_forbidden'});if(r.status===to)return structuredClone(r);if(r.status!==from)return null;Object.assign(r,patch,{status:to});save();return structuredClone(r);},
  update(id,x,patch){const r=rows.find(r=>r.requestId===id);if(!r)return null;if(!same(r,x))throw Object.assign(new Error('auth.workspace_forbidden'),{code:'auth.workspace_forbidden'});Object.assign(r,patch);save();return structuredClone(r);}
 };
}
// Conversational undo cards exist only when a proposal record is created in
// this store. The PWA's global "undo" remains API-owned via /pending-operations/undo.
