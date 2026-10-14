/** Finder's assignment API accepts resource IDs in bounded batches. Fetch
 * all loaded rows without dropping tags after the first 100; throttle bursts
 * so a large directory does not flood the LAN with requests. */
export async function readFinderAssignmentBatches(
 ids:readonly string[],read:(batch:string[])=>Promise<Record<string,string[]>>,
 shouldContinue:()=>boolean=()=>true,
):Promise<Record<string,string[]>>{
 const result:Record<string,string[]>={};
 for(let offset=0;offset<ids.length&&shouldContinue();offset+=300){
  const group:Promise<Record<string,string[]>>[]=[];
  for(let index=offset;index<Math.min(ids.length,offset+300);index+=100){
   group.push(read(ids.slice(index,index+100)));
  }
  const pages=await Promise.all(group);
  if(!shouldContinue())break;
  for(const page of pages)Object.assign(result,page);
 }
 return result;
}
