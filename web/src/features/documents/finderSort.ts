import type {Folder} from "../../entities/folder/model";
import type {FileItem} from "../../entities/file/model";

/** One sort state for list, icons, column ancestors and gallery. A directory
 * has no file size, so size mode retains stable name order for folders. */
export type FinderSortKey="updated_desc"|"name_asc"|"name_desc"|"size_desc";
export const FINDER_SORT_KEYS:FinderSortKey[]=["updated_desc","name_asc","name_desc","size_desc"];
export const FINDER_SORT_LABELS:Record<FinderSortKey,string>={
 updated_desc:"最近修改",name_asc:"名称 A→Z",
 name_desc:"名称 Z→A",size_desc:"大小降序",
};
const chineseName=new Intl.Collator("zh-CN",{numeric:true,sensitivity:"base"});
export function compareFinderFolders(a:Folder,b:Folder,sort:FinderSortKey):number{
 const fallback=chineseName.compare(a.name,b.name)||a.id.localeCompare(b.id);
 if(sort==="name_desc")return -fallback;
 if(sort==="updated_desc"){
  const left=Date.parse(a.updatedAt??""),right=Date.parse(b.updatedAt??"");
  // Missing timestamps must not overtake known update times.
  if(Number.isFinite(left)&&Number.isFinite(right)&&left!==right)return right-left;
  if(Number.isFinite(left)!==Number.isFinite(right))return Number.isFinite(left)?-1:1;
 }
 return fallback;
}
export function compareFinderFiles(a:FileItem,b:FileItem,sort:FinderSortKey):number{
 let diff=0;
 if(sort==="name_asc")diff=chineseName.compare(a.name,b.name);
 else if(sort==="name_desc")diff=-chineseName.compare(a.name,b.name);
 else if(sort==="size_desc")diff=b.sizeBytes-a.sizeBytes;
 else diff=Date.parse(b.updatedAt)-Date.parse(a.updatedAt);
 return Number.isFinite(diff)&&diff!==0?diff:chineseName.compare(a.name,b.name)||a.id.localeCompare(b.id);
}
