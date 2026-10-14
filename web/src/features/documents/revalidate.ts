import type {FileItem,PreviewData} from "../../entities/file/model";
import type {FilePage} from "./api";

// Reload exactly the previously visible keyset window, not just page one.
// The REST API caps a page at 200 rows. Never splice stale rows from an old
// keyset into new rows: concurrent insertions, deletes and permission changes
// must be reconciled by an authoritative ordered read.
export async function revalidateFileWindow(
 fetchPage:(cursor:string,limit:number,signal?:AbortSignal)=>Promise<FilePage>,
 targetSize:number,signal?:AbortSignal
):Promise<FilePage>{
 const target=Math.max(50,Math.min(5000,targetSize));
 const items:FileItem[]=[];
 const seen=new Set<string>();
 let cursor="";
 let nextCursor="";
 for(let page=0;page<25 && items.length<target;page++){
  if(signal?.aborted)throw new DOMException("Aborted","AbortError");
  const result=await fetchPage(cursor,Math.min(200,target-items.length),signal);
  for(const item of result.items){
   if(!seen.has(item.id)){seen.add(item.id);items.push(item);}
  }
  nextCursor=result.nextCursor;
  if(!nextCursor||nextCursor===cursor)break;
  cursor=nextCursor;
 }
 return {items,nextCursor};
}

// Only content-affecting changes replace the expensive media/Office/text
// preview component. Rename and version-history-only updates keep it mounted.
// Metadata comes from a fresh authorized REST request, never a WS payload.
export function reuseVerifiedPreview(previous:PreviewData|null,file:FileItem):PreviewData|null{
 if(!previous||previous.fileId!==file.id||
  previous.sha256!==file.sha256||previous.size!==file.sizeBytes||
  previous.contentType!==file.contentType)return null;
 return previous.name===file.name?previous:{...previous,name:file.name};
}
