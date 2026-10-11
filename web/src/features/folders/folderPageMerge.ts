// Deduplicate overlapping cursor pages without changing server ordering or row identity.
// Retain the first visible copy: previously rendered treeitems keep keyboard focus.
export function mergeDistinctById<T extends {id:string}>(existing:readonly T[],incoming:readonly T[]):T[]{
 const seen=new Set<string>();
 const result:T[]=[];
 for(const entry of [...existing,...incoming]){
  if(seen.has(entry.id))continue;
  seen.add(entry.id);
  result.push(entry);
 }
 return result;
}
