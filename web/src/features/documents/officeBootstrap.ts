// Shared ONLYOFFICE script loader for the preview → editor transition.
// Prewarming downloads api.js only; it never creates a document session,
// obtains an edit lock or reads confidential file content.
declare global{
 interface Window{
  DocsAPI?:{DocEditor?:new (id:string,config:Record<string,unknown>)=>{destroyEditor?:()=>void}};
 }
}

function editorBrowserURL(internalURL?:string):string|undefined{
 if(window.location.protocol==="https:"&&window.location.port==="18443"){
  return "https://"+window.location.hostname+":18444";
 }
 if(window.location.protocol==="http:"&&window.location.port==="18091"){
  return "http://"+window.location.hostname+":18080";
 }
 return internalURL?.replace(/\/$/,"");
}

let pending:Promise<void>|null=null;
let pendingURL="";
export function warmOfficeEditor(internalURL?:string):Promise<void>|undefined{
 const origin=editorBrowserURL(internalURL);
 if(!origin)return undefined;
 if(window.DocsAPI?.DocEditor)return Promise.resolve();
 const src=origin+"/web-apps/apps/api/documents/api.js";
 if(pending&&pendingURL===src)return pending;
 pendingURL=src;
 pending=new Promise<void>((resolve,reject)=>{
  const existing=document.querySelector(`script[src="${src}"]`) as HTMLScriptElement|null;
  const script=existing??document.createElement("script");
  let settled=false;
  const cleanup=()=>{
   window.clearTimeout(timeout);
   script.removeEventListener("load",loaded);
   script.removeEventListener("error",failed);
  };
  const finish=(error?:Error)=>{
   if(settled)return;
   settled=true;
   cleanup();
   if(error){script.remove();reject(error);}else resolve();
  };
  const loaded=()=>finish(window.DocsAPI?.DocEditor?undefined:new Error("ONLYOFFICE DocsAPI unavailable"));
  const failed=()=>finish(new Error("ONLYOFFICE script load failed"));
  const timeout=window.setTimeout(()=>finish(new Error("ONLYOFFICE script load timed out")),15000);
  script.addEventListener("load",loaded);
  script.addEventListener("error",failed);
  if(!existing){script.src=src;script.async=true;document.head.appendChild(script);}
 }).catch(error=>{pending=null;throw error;});
 return pending;
}

export function prewarmOfficeEditor():void{
 // Prewarming is opportunistic; a rejected preload must not trigger an
 // unhandled rejection, user-visible error, or a locked editing session.
 void warmOfficeEditor()?.catch(()=>undefined);
}
