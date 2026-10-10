import {authApi} from "../features/auth/api";
import {ApiError} from "../shared/http";
import type {User} from "../entities/user/model";

// Only a single socket belongs to a logged-in browser tab. All CRUD requests
// remain HTTP so that connectivity issues never block file operations.
export function connectSessionEvents(onIdentity:(user:User|null)=>void):()=>void {
 let active=true;
 let socket:WebSocket|null=null;
 let retry:number|undefined;
 let reconnectDelay=1000;
 let lastValidation=0;

 function validateSession(){
  const now=Date.now();
  if(now-lastValidation<2500)return;
  lastValidation=now;
  authApi.me().then(user=>{if(active)onIdentity(user)}).catch(error=>{
   if(active && error instanceof ApiError && error.httpStatus===401)onIdentity(null);
  });
 }
 function reconnect(){
  if(!active)return;
  retry=window.setTimeout(open,reconnectDelay);
  reconnectDelay=Math.min(reconnectDelay*2,30000);
 }
 function open(){
  if(!active)return;
  const protocol=window.location.protocol==="https:"?"wss:":"ws:";
  try{
   const connection=new WebSocket(protocol+"//"+window.location.host+"/api/events/ws");
   socket=connection;
   connection.onopen=()=>{reconnectDelay=1000};
   connection.onmessage=event=>{
    if(!active || typeof event.data!=="string" || event.data.length>2048)return;
    let data:{type?:string};
    try{data=JSON.parse(event.data) as {type?:string}}catch{return}
    switch(data.type){
     case "session.revoked":onIdentity(null);break;
     case "session.changed":
      window.dispatchEvent(new Event("filesmanage:sessions-changed"));
      validateSession();break;
     // connection.ready and connection.heartbeat are transport signals only.
    }
   };
   connection.onclose=()=>{
    if(socket===connection)socket=null;
    if(active){validateSession();reconnect()}
   };
   connection.onerror=()=>connection.close();
  }catch{
   reconnect();
  }
 }
 open();
 return ()=>{
  active=false;
  if(retry!==undefined)window.clearTimeout(retry);
  socket?.close();
 };
}
