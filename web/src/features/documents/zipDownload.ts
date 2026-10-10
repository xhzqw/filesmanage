import {reportSessionResponse} from "../../shared/http";

export type ZipProgress={phase:"preparing"|"receiving"|"saving"|"failed";bytes:number;error?:string};
export async function downloadZip(
 ids:string[],signal:AbortSignal,onProgress:(state:ZipProgress)=>void
):Promise<void>{
 const url="/api/files/download-zip?"+new URLSearchParams({ids:ids.join(",")});
 onProgress({phase:"preparing",bytes:0});
 const res=await fetch(url,{credentials:"same-origin",signal});
 if(!res.ok){
  await reportSessionResponse(res,url);
  let detail="服务器拒绝打包，请确认所选文件均可下载";
  try{const body=await res.json();detail=body?.error?.message||detail;}catch{}
  throw new Error(detail+" (HTTP "+res.status+")");
 }
 if(!res.body)throw new Error("浏览器不支持可监控的流式下载");
 const reader=res.body.getReader();
 const chunks:Uint8Array<ArrayBuffer>[]=[];
 let received=0;
 try{
  for(;;){
   const {done,value}=await reader.read();
   if(done)break;
   if(!value)continue;
   received+=value.byteLength;
   if(received>512*1024*1024+4*1024*1024)throw new Error("收到的压缩数据超出安全大小");
   chunks.push(new Uint8Array(value));
   onProgress({phase:"receiving",bytes:received});
  }
 }finally{reader.releaseLock();}
 if(signal.aborted)throw new DOMException("已取消","AbortError");
 onProgress({phase:"saving",bytes:received});
 const blob=new Blob(chunks,{type:"application/zip"});
 // A ZIP is complete only after the stream ends (central directory received).
 if(blob.size<22)throw new Error("压缩包不完整");
 // A truncated HTTP stream can end without an error after ZIP headers have
 // already been sent. Require the central-directory end record before saving.
 // The server writes archives without comments, so EOCD occupies the last 22B.
 const tail=new Uint8Array(await blob.slice(-22).arrayBuffer());
 if(tail[0]!==0x50||tail[1]!==0x4b||tail[2]!==0x05||tail[3]!==0x06){
  throw new Error("ZIP 数据未完整接收，已阻止保存损坏的压缩包");
 }
 const count=tail[10]!+tail[11]!*256;
 if(count!==ids.length)throw new Error("ZIP 条目数量不匹配，已阻止保存");
 const objectUrl=URL.createObjectURL(blob);
 try{
  const a=document.createElement("a");a.href=objectUrl;a.download="文件打包.zip";
  document.body.appendChild(a);a.click();a.remove();
 }finally{window.setTimeout(()=>URL.revokeObjectURL(objectUrl),60000);}
}
