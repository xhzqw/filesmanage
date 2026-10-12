import type {Folder} from "../../entities/folder/model";
import type {FileCategory,FileCategoryCount,Stats} from "./api";

export type AssetNode={
 id:string;name:string;parentId:string|null;children:AssetNode[];
 directCount:number;directBytes:number;directTypes:FileCategoryCount[];
 count:number;bytes:number;types:FileCategoryCount[];virtual?:boolean;
};

export const ROOT_ID="__asset_root__";
export const CATEGORIES: {id:FileCategory;label:string;color:string}[]=[
 {id:"pdf",label:"PDF",color:"var(--file-icon-pdf)"},
 {id:"document",label:"文档",color:"var(--file-icon-word)"},
 {id:"sheet",label:"表格",color:"var(--file-icon-sheet)"},
 {id:"slide",label:"演示",color:"var(--file-icon-slide)"},
 {id:"image",label:"图片",color:"var(--file-icon-image)"},
 {id:"video",label:"视频",color:"var(--file-icon-media)"},
 {id:"audio",label:"音频",color:"var(--status-warning)"},
 {id:"cad",label:"CAD / 3D",color:"var(--file-icon-cad)"},
 {id:"archive",label:"压缩包",color:"var(--file-icon-archive)"},
 {id:"other",label:"其他",color:"var(--file-icon-text)"}
];
export const categoryInfo=(id:FileCategory)=>CATEGORIES.find(item=>item.id===id)??CATEGORIES[9]!;
export function categoryTotals(parts:FileCategoryCount[]):FileCategoryCount[]{
 const map=new Map<FileCategory,FileCategoryCount>();
 for(const item of parts){
  const kind=CATEGORIES.some(c=>c.id===item.category)?item.category:"other";
  const old=map.get(kind);
  if(old){old.count+=item.count;old.bytes+=item.bytes;}
  else map.set(kind,{category:kind,count:item.count,bytes:item.bytes});
 }
 return [...map.values()].sort((a,b)=>b.bytes-a.bytes||b.count-a.count);
}

export function assetTree(stats:Stats,folders:Folder[]):AssetNode{
 const allowed=new Map(folders.map(f=>[f.id,f]));
 const nodes=new Map<string,AssetNode>();
 const create=(id:string,name:string,parentId:string|null):AssetNode=>{
  const found=nodes.get(id);
  if(found)return found;
  const node:AssetNode={id,name,parentId,children:[],directCount:0,directBytes:0,directTypes:[],count:0,bytes:0,types:[]};
  nodes.set(id,node);return node;
 };
 for(const item of stats.folderTree??[]){
  const node=create(item.folderId,item.folderName||"未命名目录",item.parentId??null);
  node.directBytes=Math.max(0,item.bytes);
  node.directCount=Math.max(0,item.count);
  const kinds=categoryTotals(item.types??[]);
  const classifiedCount=kinds.reduce((n,c)=>n+c.count,0);
  const classifiedBytes=kinds.reduce((n,c)=>n+c.bytes,0);
  if(classifiedCount<node.directCount||classifiedBytes<node.directBytes){
   kinds.push({category:"other",count:Math.max(0,node.directCount-classifiedCount),bytes:Math.max(0,node.directBytes-classifiedBytes)});
  }
  node.directTypes=categoryTotals(kinds);
 }
 // Do not synthesize ancestors outside the permission-filtered folder index.
 for(const node of [...nodes.values()]){
  const visited=new Set([node.id]);let id=node.parentId;
  while(id&&!visited.has(id)){
   visited.add(id);
   const parent=allowed.get(id);
   if(!parent&&!nodes.has(id))break;
   const existing=nodes.get(id);
   if(existing)id=existing.parentId;
   else {create(id,parent!.name,parent!.parentId??null);id=parent!.parentId;}
  }
 }
 const root:AssetNode={id:ROOT_ID,name:"全部可见目录",parentId:null,children:[],directCount:0,directBytes:0,directTypes:[],count:0,bytes:0,types:[]};
 for(const node of nodes.values()){
  const parent=node.parentId?nodes.get(node.parentId):undefined;
  let cycle=false;const seen=new Set([node.id]);let cursor=parent;
  while(cursor){if(seen.has(cursor.id)){cycle=true;break;}seen.add(cursor.id);cursor=cursor.parentId?nodes.get(cursor.parentId):undefined;}
  if(parent&&!cycle)parent.children.push(node);else root.children.push(node);
 }
 const sum=(node:AssetNode)=>{
  node.bytes=node.directBytes;node.count=node.directCount;
  const all=[...node.directTypes];
  for(const child of node.children){sum(child);node.bytes+=child.bytes;node.count+=child.count;all.push(...child.types);}
  node.types=categoryTotals(all);
  node.children.sort((a,b)=>b.bytes-a.bytes||b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));
 };
 sum(root);
 const missingBytes=Math.max(0,stats.totalBytes-root.bytes);
 const missingCount=Math.max(0,stats.totalFiles-root.count);
 if(stats.treeTruncated&&(missingBytes>0||missingCount>0)){
  const types:FileCategoryCount[]=[{category:"other",bytes:missingBytes,count:missingCount}];
  root.children.push({id:"__other_folders__",name:"其余目录",parentId:ROOT_ID,children:[],directBytes:missingBytes,directCount:missingCount,bytes:missingBytes,count:missingCount,directTypes:types,types,virtual:true});
  root.bytes+=missingBytes;root.count+=missingCount;root.types=categoryTotals([...root.types,...types]);
 }
 return root;
}

/** A directory can contain different file categories: show measured segments, not arbitrary folder-index colors. */
export function distributionBackground(parts:FileCategoryCount[],bytes:number,count:number):string{
 const present=categoryTotals(parts).filter(item=>(bytes>0?item.bytes:item.count)>0);
 const denominator=bytes>0?bytes:count;
 if(!present.length||!denominator)return "var(--surface-header)";
 let cursor=0;
 const stops:string[]=[];
 for(const item of present){
  const start=cursor;
  cursor+=100*(bytes>0?item.bytes:item.count)/denominator;
  const paint="color-mix(in srgb,"+categoryInfo(item.category).color+" 42%,var(--surface-panel))";
  stops.push(paint+" "+start.toFixed(3)+"% "+Math.min(100,cursor).toFixed(3)+"%");
 }
 return "linear-gradient(105deg,"+stops.join(",")+")";
}
