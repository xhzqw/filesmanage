// Search presets are scoped to a signed-in account and stored without results,
// tokens or file contents. The server remains authoritative when a preset runs.
export type SearchPresetFields={
 q:string;category:string;tag:string;uploader:string;type:string;
 sort:string;limit:number;scope:"all"|"current"|"descendants";folder:string;
 from:string;to:string;
};
export type SearchPreset={id:string;name:string;fields:SearchPresetFields;createdAt:number};
const prefix="fm-search-presets-v1:";
const maxPresets=12;
function valid(x:unknown):x is SearchPreset{
 if(!x||typeof x!=="object")return false;
 const r=x as Partial<SearchPreset>;
 const f=r.fields as Partial<SearchPresetFields>|undefined;
 return typeof r.id==="string"&&r.id.length<=90&&
  typeof r.name==="string"&&r.name.length>0&&r.name.length<=48&&
  typeof r.createdAt==="number"&&r.createdAt>0&&
  !!f&&["q","category","tag","uploader","type","sort","folder","from","to"].every(key=>{
   const value=f[key as keyof SearchPresetFields];return typeof value==="string"&&value.length<=240;
  })&&["all","current","descendants"].includes(String(f.scope))&&
  [50,100,200].includes(Number(f.limit));
}
export function readSearchPresets(userId:string):SearchPreset[]{
 if(!userId)return [];
 try{
  const raw=localStorage.getItem(prefix+userId);
  if(!raw||raw.length>60000)return [];
  const parsed:unknown=JSON.parse(raw);
  return Array.isArray(parsed)?parsed.filter(valid).slice(0,maxPresets):[];
 }catch{return [];}
}
export function writeSearchPresets(userId:string,items:SearchPreset[]){
 if(!userId)return;
 try{localStorage.setItem(prefix+userId,JSON.stringify(items.slice(0,maxPresets)));}
 catch{}
}
export function saveSearchPreset(items:SearchPreset[],name:string,fields:SearchPresetFields):SearchPreset[]{
 const title=name.trim().slice(0,48);
 if(!title)return items;
 const others=items.filter(item=>item.name!==title);
 const preset:SearchPreset={id:typeof crypto!=="undefined"&&"randomUUID" in crypto?crypto.randomUUID():String(Date.now()),name:title,fields,createdAt:Date.now()};
 return [preset,...others].slice(0,maxPresets);
}
