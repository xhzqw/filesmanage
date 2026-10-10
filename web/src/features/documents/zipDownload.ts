import {reportSessionResponse} from "../../shared/http";

// Small archives have bounded memory buffering with precise received-byte
// progress. Large archives stream directly to disk in secure browsers and
// otherwise go to the native browser download manager (zero JS buffering).
const maxBufferedOriginalBytes=32*1024*1024;
const maxZIPBytes=512*1024*1024+4*1024*1024;
type FileWriter={write(data:Uint8Array):Promise<void>;close():Promise<void>;abort():Promise<void>};
type FileHandle={createWritable():Promise<FileWriter>};
type SavePicker=(options:{suggestedName:string;types:{description:string;accept:Record<string,string[]>}[]})=>Promise<FileHandle>;
export type ZipProgress={phase:"preparing"|"receiving"|"saving"|"handoff"|"failed";bytes:number;error?:string};
export type ZipResult="saved"|"handoff";

function validateEndRecord(tail:Uint8Array,expected:number){
 if(tail.length!==22||tail[0]!==0x50||tail[1]!==0x4b||tail[2]!==0x05||tail[3]!==0x06)
  throw new Error("ZIP 数据未完整接收，已阻止保存损坏的压缩包");
 if(tail[10]!+tail[11]!*256!==expected)
  throw new Error("ZIP 条目数量不匹配，已阻止保存");
}
function lastBytes(previous:Uint8Array,chunk:Uint8Array):Uint8Array{
 if(chunk.length>=22)return chunk.slice(-22);
 const joined=new Uint8Array(previous.length+chunk.length);
 joined.set(previous);joined.set(chunk,previous.length);
 return joined.slice(-22);
}
async function zipResponseError(res:Response,url:string):Promise<Error>{
 await reportSessionResponse(res,url);
 let detail="所选文件不可下载，请检查权限或文件状态";
 try{const body=await res.clone().json();detail=body?.error?.message||detail;}catch{}
 return new Error(detail+" (HTTP "+res.status+")");
}
function browserDownload(url:string){
 const a=document.createElement("a");
 a.href=url;a.download="文件打包.zip";document.body.append(a);a.click();a.remove();
}

export async function downloadZip(
 ids:string[],originalBytes:number,signal:AbortSignal,onProgress:(state:ZipProgress)=>void
):Promise<ZipResult>{
 const url="/api/files/download-zip?"+new URLSearchParams({ids:ids.join(",")});
 onProgress({phase:"preparing",bytes:0});
 const large=originalBytes>maxBufferedOriginalBytes;
 const picker=(window as Window & {showSaveFilePicker?:SavePicker}).showSaveFilePicker;
 let writer:FileWriter|undefined;
 if(large&&window.isSecureContext&&typeof picker==="function"){
  // Picker must be initiated before the first await to retain user activation.
  const file=await picker({suggestedName:"文件打包.zip",types:[{description:"ZIP 压缩包",accept:{"application/zip":[".zip"]}}]});
  writer=await file.createWritable();
 }
 if(large&&!writer){
  // The HTTP LAN origin is not a secure context for File System Access.
  // A HEAD preflight returns errors visibly. GET independently rechecks ACLs.
  const head=await fetch(url,{method:"HEAD",credentials:"same-origin",signal});
  if(!head.ok)throw await zipResponseError(head,url);
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  browserDownload(url);
  onProgress({phase:"handoff",bytes:0});
  return "handoff";
 }
 try{
  const res=await fetch(url,{credentials:"same-origin",signal});
  if(!res.ok)throw await zipResponseError(res,url);
  if(!res.body)throw new Error("浏览器不支持可监控的流式下载");
  const reader=res.body.getReader();
  const chunks:Uint8Array<ArrayBuffer>[]=[];
  let received=0;
  let tail:Uint8Array<ArrayBufferLike>=new Uint8Array(0);
  try{
   for(;;){
    const {done,value}=await reader.read();
    if(done)break;
    if(!value)continue;
    received+=value.byteLength;
    if(received>maxZIPBytes)throw new Error("压缩包超出安全大小");
    tail=lastBytes(tail,value);
    if(writer)await writer.write(value);
    else chunks.push(new Uint8Array(value));
    onProgress({phase:"receiving",bytes:received});
   }
  }finally{reader.releaseLock();}
  if(signal.aborted)throw new DOMException("已取消","AbortError");
  validateEndRecord(tail,ids.length);
  onProgress({phase:"saving",bytes:received});
  if(writer){await writer.close();writer=undefined;}
  else {
   const blob=new Blob(chunks,{type:"application/zip"});
   const objectUrl=URL.createObjectURL(blob);
   try{browserDownload(objectUrl);}finally{window.setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);}
  }
  return "saved";
 }catch(error){
  if(writer){try{await writer.abort();}catch{}}
  throw error;
 }
}
