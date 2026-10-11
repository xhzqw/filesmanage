// Hint-only invalidation for open file/trash views, including other tabs.
// Never cache file contents, permissions or names here: the server remains the
// authority and every recipient makes a fresh authorized request.
export type ResourceScope="file"|"trash"|"folder";
export type ResourceChange={scope:ResourceScope;id?:string};
const KEY="fm-workspace-change-v1";

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
 const storage=(event:StorageEvent)=>{
  if(event.key!==KEY||!event.newValue)return;
  try{
   const parsed=JSON.parse(event.newValue) as {change?:unknown};
   if(validChange(parsed.change)&&parsed.change.scope===scope)callback(parsed.change);
  }catch{/* malformed or unrelated storage writes cannot break the view */}
 };
 window.addEventListener("storage",storage);
 return()=>{window.removeEventListener("storage",storage);};
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
