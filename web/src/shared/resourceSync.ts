// Hint-only invalidation for open file/trash views, including other tabs.
// Never cache file contents, permissions or names here: the server remains the
// authority and every recipient makes a fresh authorized request.
export type ResourceScope="file"|"trash"|"folder";
export type WorkspaceScope=ResourceScope|"permissions"|"collaboration"|"organization"|"search"|"stats"|"review"|"lifecycle"|"approval-policy"|"presets";
export type ResourceChange={scope:ResourceScope;id?:string};
const KEY="fm-workspace-change-v1";
const LIVE_EVENT="filesmanage:resource-changed";

// WebSocket data is an anonymous hint, not file metadata.
export function receiveRemoteResourceChanges(scopes:WorkspaceScope[]):void{
 if(typeof window==="undefined")return;
 for(const scope of new Set(scopes)){
  if(scope==="file"||scope==="folder"||scope==="trash")
   window.dispatchEvent(new CustomEvent<ResourceChange>(LIVE_EVENT,{detail:{scope}}));
 }
 window.dispatchEvent(new CustomEvent<{scopes:WorkspaceScope[]}>("filesmanage:workspace-changed",{detail:{scopes}}));
}

function validChange(input:unknown):input is ResourceChange{
 if(!input||typeof input!=="object")return false;
 const change=input as Partial<ResourceChange>;
 return (change.scope==="file"||change.scope==="trash"||change.scope==="folder")&&
  (change.id===undefined||(typeof change.id==="string"&&change.id.length<=256));
}

export function publishResourceChange(change:ResourceChange):void{
 if(typeof window==="undefined")return;
 try{
  // Storage events reach other tabs only. The mutation's own page already
  // handles its successful operation and should not unmount an editor/dialog
  // midway through its completion callback.
  window.localStorage.setItem(KEY,JSON.stringify({change,nonce:Date.now()+"-"+Math.random()}));
 }catch{/* session-local notification still works in restricted browsers */}
}

export function observeResourceChange(scope:ResourceScope,callback:(change:ResourceChange)=>void):()=>void{
 const live=(event:Event)=>{
  const change=(event as CustomEvent<unknown>).detail;
  if(validChange(change)&&change.scope===scope)callback(change);
 };
 const storage=(event:StorageEvent)=>{
  if(event.key!==KEY||!event.newValue)return;
  try{
   const parsed=JSON.parse(event.newValue) as {change?:unknown};
   if(validChange(parsed.change)&&parsed.change.scope===scope)callback(parsed.change);
  }catch{/* malformed or unrelated storage writes cannot break the view */}
 };
 window.addEventListener("storage",storage);
 window.addEventListener(LIVE_EVENT,live);
 return()=>{window.removeEventListener("storage",storage);window.removeEventListener(LIVE_EVENT,live);};
}

export function observeWorkspaceChange(callback:()=>void,scopes?:WorkspaceScope[]):()=>void{
 const listener=(event:Event)=>{
  const changed=(event as CustomEvent<{scopes?:WorkspaceScope[]}>).detail?.scopes;
  if(!scopes||!changed||changed.some(value=>scopes.includes(value)))callback();
 };
 window.addEventListener("filesmanage:workspace-changed",listener);
 return()=>window.removeEventListener("filesmanage:workspace-changed",listener);
}

// A user can return to a stale tab after another device or an external API
// changed a file; those writes cannot publish browser notifications. Focus
// and visibility revalidation covers that case without polling the server.
export function observeWindowReturn(callback:()=>void):()=>void{
 let last=0;
 const refresh=()=>{
  if(document.visibilityState==="hidden")return;
  const now=Date.now();
  if(now-last<800)return;
  last=now;callback();
 };
 const visible=()=>{if(document.visibilityState==="visible")refresh();};
 window.addEventListener("focus",refresh);
 window.addEventListener("pageshow",refresh);
 document.addEventListener("visibilitychange",visible);
 return()=>{
  window.removeEventListener("focus",refresh);
  window.removeEventListener("pageshow",refresh);
  document.removeEventListener("visibilitychange",visible);
 };
}
