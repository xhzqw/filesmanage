import type {Department} from "./api";

export function ancestorPathOf(byId:Map<string,Department>,id:string):string{
 const names:string[]=[];
 const seen=new Set<string>();
 let current=byId.get(id)?.parentId??null;
 while(current!==null&&!seen.has(current)){
  seen.add(current);
  const parent=byId.get(current);
  if(!parent)break;
  names.unshift(parent.name);
  current=parent.parentId;
 }
 return names.join(" / ");
}

export function fullPathOf(byId:Map<string,Department>,id:string):string{
 const name=byId.get(id)?.name??id;
 const ancestors=ancestorPathOf(byId,id);
 return ancestors===""?name:ancestors+" / "+name;
}
