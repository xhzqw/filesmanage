import {authApi} from "../features/auth/api";
import {ApiError} from "../shared/http";
import {receiveRemoteResourceChanges,type WorkspaceScope} from "../shared/resourceSync";
import type {User} from "../entities/user/model";

const ALL_SCOPES:WorkspaceScope[]=["file","folder","trash","permissions","collaboration","organization","search","stats","review","lifecycle","approval-policy","presets"];

// Hints are never trusted as file data or authorization. An HTTP re-read
// reconciles every open view after missed, coalesced or reordered events.
export function connectSessionEvents(onIdentity:(user:User|null)=>void,userID=""):()=>void {
 let active=true;
 let socket:WebSocket|null=null;
 let retry:number|undefined;
 let flushTimer:number|undefined;
 let watchdog:number|undefined;
 let reconnectDelay=1000;
 let lastValidation=0;
 let validationSequence=0;
 let revoked=false;
 let lastFrameAt=Date.now();
 let connectingSince=Date.now();
 // Cursor is a receipt for applied invalidation hints, never a credential.
 // Partition it by authenticated user so account switching cannot skip state.
 const cursorKey=userID?"fm-live-cursor-v3:"+userID:"";
 const validCursor=(value:unknown):value is string=>typeof value==="string"&&/^(0|[1-9]\d{0,18})$/.test(value);
 let committedCursor="";
 try{if(cursorKey){const stored=window.localStorage.getItem(cursorKey);if(validCursor(stored))committedCursor=stored;}}catch{}
 let pendingCursor="";
 const pending=new Set<WorkspaceScope>();

 function revokeIdentity(){
  if(!active||revoked)return;
  revoked=true;
  validationSequence++;
  if(retry!==undefined){window.clearTimeout(retry);retry=undefined;}
  socket?.close();
  socket=null;
  onIdentity(null);
 }
 function validateSession(force=false){
  if(!active||revoked)return;
  const now=Date.now();
  if(!force&&now-lastValidation<2500)return;
  lastValidation=now;
  const sequence=++validationSequence;
  void authApi.me().then(user=>{
   if(active&&!revoked&&sequence===validationSequence)onIdentity(user);
  }).catch(error=>{
   if(active&&!revoked&&sequence===validationSequence&&error instanceof ApiError&&error.httpStatus===401)
    revokeIdentity();
  });
 }
 function flush(){
  flushTimer=undefined;
  if(!active||revoked)return;
  if(pending.size>0){
   const scopes=Array.from(pending);pending.clear();
   receiveRemoteResourceChanges(scopes);
  }
  if(pendingCursor){
   committedCursor=pendingCursor;pendingCursor="";
   try{if(cursorKey)window.localStorage.setItem(cursorKey,committedCursor);}catch{}
  }
 }
 function acknowledge(value:unknown){
  if(!validCursor(value))return;
  pendingCursor=value;
  if(flushTimer===undefined)flushTimer=window.setTimeout(flush,120);
 }
 function invalidate(scopes:WorkspaceScope[]){
  for(const scope of scopes)pending.add(scope);
  if(flushTimer===undefined)flushTimer=window.setTimeout(flush,120);
 }
 function fullResync(){
  invalidate(ALL_SCOPES);
  window.dispatchEvent(new Event("filesmanage:approvals-changed"));
  window.dispatchEvent(new Event("filesmanage:sessions-changed"));
  validateSession(true);
 }
 function reconnect(){
  if(!active||revoked||retry!==undefined)return;
  const delay=Math.round(reconnectDelay*(0.8+Math.random()*0.4));
  retry=window.setTimeout(()=>{retry=undefined;open();},delay);
  reconnectDelay=Math.min(reconnectDelay*2,30000);
 }
 function open(){
  if(!active||revoked||socket)return;
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  try{
   const path="/api/events/ws"+(committedCursor?"?cursor="+encodeURIComponent(committedCursor):"");
   const connection=new WebSocket(protocol+"//"+window.location.host+path);
   socket=connection;
   connectingSince=Date.now();
   connection.onopen=()=>{reconnectDelay=1000;lastFrameAt=Date.now();};
   connection.onmessage=event=>{
    if(!active||revoked||socket!==connection)return;
    lastFrameAt=Date.now();
    if(typeof event.data!=="string"||event.data.length>2048){fullResync();return;}
    let data:{type?:unknown;scopes?:unknown;resync?:unknown;cursor?:unknown;version?:unknown};
    try{data=JSON.parse(event.data) as typeof data;}catch{fullResync();return;}
    switch(data.type){
     case "session.revoked":revokeIdentity();break;
     case "approval.changed":
      window.dispatchEvent(new Event("filesmanage:approvals-changed"));
      acknowledge(data.cursor);break;
     case "session.changed":
      window.dispatchEvent(new Event("filesmanage:sessions-changed"));
      validateSession(true);acknowledge(data.cursor);break;
     case "workspace.changed":{
      if(!Array.isArray(data.scopes)||data.scopes.length>12){fullResync();break;}
      const scopes=data.scopes.filter((value):value is WorkspaceScope=>ALL_SCOPES.includes(value as WorkspaceScope));
      if(scopes.length)invalidate(scopes);else fullResync();
      acknowledge(data.cursor);
      break;
     }
     case "state.resync":fullResync();acknowledge(data.cursor);break;
     case "connection.ready":{
      if(data.version===3){
       if(data.resync===true){
        fullResync();
        acknowledge(data.cursor);
       }else if(!committedCursor){
        // A reconnect without a local bookmark must not silently
        // advance past changes that have not been reconciled.
        fullResync();
        acknowledge(data.cursor);
       }
      }else fullResync();
      break;
     }
     case "connection.heartbeat":break;
     case "server.unavailable":break;
     // Heartbeat and temporary DB errors are transport signals only.
     default:fullResync();
    }
   };
   connection.onclose=()=>{
    if(socket===connection)socket=null;
    if(active&&!revoked){validateSession();reconnect();}
   };
   connection.onerror=()=>connection.close();
  }catch{socket=null;reconnect();}
 }
 function online(){
  if(retry!==undefined){window.clearTimeout(retry);retry=undefined;}
  if(!socket)open();
 }
 window.addEventListener("online",online);
 // A half-open LAN or reverse-proxy connection may remain OPEN in the
 // browser even after the server disappears. Two missed server heartbeats
 // close it and engage the normal reconnect/reconciliation path.
 watchdog=window.setInterval(()=>{
  if(!active||revoked||!socket||document.visibilityState==="hidden")return;
  if(socket.readyState===WebSocket.OPEN&&Date.now()-lastFrameAt>40000)
   socket.close();
  else if(socket.readyState===WebSocket.CONNECTING&&Date.now()-connectingSince>25000)
   socket.close();
 },12000);
 open();
 return ()=>{
  active=false;
  window.removeEventListener("online",online);
  if(retry!==undefined)window.clearTimeout(retry);
  if(flushTimer!==undefined)window.clearTimeout(flushTimer);
  if(watchdog!==undefined)window.clearInterval(watchdog);
  validationSequence++;
  pending.clear();
  socket?.close();socket=null;
 };
}
