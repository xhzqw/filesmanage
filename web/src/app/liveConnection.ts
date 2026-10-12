import {authApi} from "../features/auth/api";
import {ApiError} from "../shared/http";
import {receiveRemoteResourceChanges,type WorkspaceScope} from "../shared/resourceSync";
import type {User} from "../entities/user/model";

const ALL_SCOPES:WorkspaceScope[]=["file","folder","trash","permissions","collaboration","organization","search","stats","review","lifecycle"];

// Hints are never trusted as file data or authorization. An HTTP re-read
// reconciles every open view after missed, coalesced or reordered events.
export function connectSessionEvents(onIdentity:(user:User|null)=>void):()=>void {
 let active=true;
 let socket:WebSocket|null=null;
 let retry:number|undefined;
 let flushTimer:number|undefined;
 let reconnectDelay=1000;
 let lastValidation=0;
 const pending=new Set<WorkspaceScope>();

 function validateSession(){
  const now=Date.now();
  if(now-lastValidation<2500)return;
  lastValidation=now;
  void authApi.me().then(user=>{if(active)onIdentity(user)}).catch(error=>{
   if(active&&error instanceof ApiError&&error.httpStatus===401)onIdentity(null);
  });
 }
 function flush(){
  flushTimer=undefined;
  if(!active||pending.size===0)return;
  const scopes=Array.from(pending);pending.clear();
  receiveRemoteResourceChanges(scopes);
 }
 function invalidate(scopes:WorkspaceScope[]){
  for(const scope of scopes)pending.add(scope);
  if(flushTimer===undefined)flushTimer=window.setTimeout(flush,120);
 }
 function fullResync(){
  invalidate(ALL_SCOPES);
  window.dispatchEvent(new Event("filesmanage:approvals-changed"));
  window.dispatchEvent(new Event("filesmanage:sessions-changed"));
  validateSession();
 }
 function reconnect(){
  if(!active||retry!==undefined)return;
  const delay=Math.round(reconnectDelay*(0.8+Math.random()*0.4));
  retry=window.setTimeout(()=>{retry=undefined;open();},delay);
  reconnectDelay=Math.min(reconnectDelay*2,30000);
 }
 function open(){
  if(!active||socket)return;
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  try{
   const connection=new WebSocket(protocol+"//"+window.location.host+"/api/events/ws");
   socket=connection;
   connection.onopen=()=>{reconnectDelay=1000;};
   connection.onmessage=event=>{
    if(!active||typeof event.data!=="string"||event.data.length>2048)return;
    let data:{type?:unknown;scopes?:unknown;resync?:unknown};
    try{data=JSON.parse(event.data) as typeof data;}catch{return;}
    switch(data.type){
     case "session.revoked":onIdentity(null);break;
     case "approval.changed":window.dispatchEvent(new Event("filesmanage:approvals-changed"));break;
     case "session.changed":
      window.dispatchEvent(new Event("filesmanage:sessions-changed"));
      validateSession();break;
     case "workspace.changed":{
      if(!Array.isArray(data.scopes)||data.scopes.length>12){fullResync();break;}
      const scopes=data.scopes.filter((value):value is WorkspaceScope=>ALL_SCOPES.includes(value as WorkspaceScope));
      if(scopes.length)invalidate(scopes);else fullResync();
      break;
     }
     case "state.resync":fullResync();break;
     case "connection.ready":if(data.resync===true)fullResync();break;
     // Heartbeat and temporary DB errors are transport signals only.
    }
   };
   connection.onclose=()=>{
    if(socket===connection)socket=null;
    if(active){validateSession();reconnect();}
   };
   connection.onerror=()=>connection.close();
  }catch{socket=null;reconnect();}
 }
 function online(){
  if(retry!==undefined){window.clearTimeout(retry);retry=undefined;}
  if(!socket)open();
 }
 window.addEventListener("online",online);
 open();
 return ()=>{
  active=false;
  window.removeEventListener("online",online);
  if(retry!==undefined)window.clearTimeout(retry);
  if(flushTimer!==undefined)window.clearTimeout(flushTimer);
  pending.clear();
  socket?.close();socket=null;
 };
}
