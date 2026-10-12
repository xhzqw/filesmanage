import {useMemo,useState} from "react";
import type {Folder} from "../../entities/folder/model";
import {RareButton} from "../../shared/ui/rare";
import {formatBytes,type Stats} from "./api";

type Node={id:string;name:string;parentId:string|null;directBytes:number;directCount:number;bytes:number;count:number;children:Node[];virtual?:boolean};
type Rect={node:Node;x:number;y:number;width:number;height:number};
const ROOT="__stats_root__";
const OTHER="__stats_other__";
const MAX_TILES=48;

function makeTree(stats:Stats,folders:Folder[]):Node {
 const known=new Map(folders.map(f=>[f.id,f]));
 const nodes=new Map<string,Node>();
 const ensure=(id:string,name:string,parentId:string|null)=>{
  const existing=nodes.get(id);
  if(existing)return existing;
  const node:Node={id,name,parentId,directBytes:0,directCount:0,bytes:0,count:0,children:[]};
  nodes.set(id,node);return node;
 };
 for(const item of stats.folderTree||[]){
  const node=ensure(item.folderId,item.folderName||"未命名目录",item.parentId||null);
  node.directBytes=Math.max(0,item.bytes);
  node.directCount=Math.max(0,item.count);
 }
 // Add only ancestors already visible through the normal authorized folder
 // tree, or included in the authorized per-folder aggregation. Never look up
 // arbitrary parent names from IDs supplied in a statistic.
 for(const item of stats.folderTree||[]){
  let node=nodes.get(item.folderId);
  const seen=new Set<string>();
  while(node?.parentId&&!seen.has(node.id)){
   seen.add(node.id);
   const id:string=node.parentId;
   const folder=known.get(id);
   if(!folder&&!nodes.has(id))break;
   node=ensure(id,folder?.name||nodes.get(id)?.name||"目录",folder?.parentId||nodes.get(id)?.parentId||null);
  }
 }
 const root:Node={id:ROOT,name:"全部可见目录",parentId:null,directBytes:0,directCount:0,bytes:0,count:0,children:[]};
 for(const node of nodes.values()){
  // Cycle/malformed folder links must never cause recursive aggregation loops.
  const parent=node.parentId?nodes.get(node.parentId):undefined;
  const seen=new Set<string>([node.id]);let walk=parent;let cyclic=false;
  while(walk){if(seen.has(walk.id)){cyclic=true;break;}seen.add(walk.id);walk=walk.parentId?nodes.get(walk.parentId):undefined;}
  if(parent&&!cyclic)parent.children.push(node);else root.children.push(node);
 }
 const aggregate=(node:Node):void=>{
  node.bytes=node.directBytes;node.count=node.directCount;
  for(const child of node.children){aggregate(child);node.bytes+=child.bytes;node.count+=child.count;}
 };
 aggregate(root);
 // The API caps folders to keep stats fast on exceptionally large volumes.
 // Represent undisplayed weight explicitly instead of distorting proportions.
 const missingBytes=Math.max(0,stats.totalBytes-root.bytes);
 const missingCount=Math.max(0,stats.totalFiles-root.count);
 if(stats.treeTruncated&&(missingBytes>0||missingCount>0)){
  root.children.push({id:OTHER,name:"其他目录",parentId:ROOT,directBytes:missingBytes,directCount:missingCount,bytes:missingBytes,count:missingCount,children:[],virtual:true});
  root.bytes+=missingBytes;root.count+=missingCount;
 }
 return root;
}

function tileChildren(node:Node):Node[]{
 const children=node.children.slice();
 if(node.directCount>0&&children.length>0){
  children.push({id:node.id+"::__direct",name:"直属文件",parentId:node.id,directBytes:node.directBytes,directCount:node.directCount,bytes:node.directBytes,count:node.directCount,children:[],virtual:true});
 }
 if(children.length===0&&node.directCount>0){
  children.push({id:node.id+"::__direct",name:"直属文件",parentId:node.id,directBytes:node.directBytes,directCount:node.directCount,bytes:node.directBytes,count:node.directCount,children:[],virtual:true});
 }
 children.sort((a,b)=>b.bytes-a.bytes||b.count-a.count||a.name.localeCompare(b.name,"zh-CN"));
 if(children.length>MAX_TILES){
  const hidden=children.slice(MAX_TILES-1);
  const bytes=hidden.reduce((v,n)=>v+n.bytes,0), count=hidden.reduce((v,n)=>v+n.count,0);
  return [...children.slice(0,MAX_TILES-1),{id:OTHER+":overflow",name:"其余 "+hidden.length+" 项",parentId:node.id,directBytes:bytes,directCount:count,bytes,count,children:[],virtual:true}];
 }
 return children;
}

function layout(nodes:Node[],width=1000,height=560):Rect[]{
 const result:Rect[]=[];
 const weight=(n:Node)=>Math.max(0,n.bytes);
 const useCount=nodes.every(n=>n.bytes===0);
 const getWeight=(n:Node)=>useCount?Math.max(0,n.count):weight(n);
 const recurse=(list:Node[],x:number,y:number,w:number,h:number)=>{
  if(!list.length||w<=0||h<=0)return;
  if(list.length===1){const only=list[0];if(only)result.push({node:only,x,y,width:w,height:h});return;}
  const total=list.reduce((sum,n)=>sum+getWeight(n),0);
  if(total<=0)return;
  let running=0,index=0;
  while(index<list.length-1){const next=list[index];if(!next)break;running+=getWeight(next);index++;if(running>=total/2)break;}
  const ratio=Math.min(.985,Math.max(.015,running/total));
  if(w>=h){
   recurse(list.slice(0,index),x,y,w*ratio,h);
   recurse(list.slice(index),x+w*ratio,y,w*(1-ratio),h);
  }else{
   recurse(list.slice(0,index),x,y,w,h*ratio);
   recurse(list.slice(index),x,y+h*ratio,w,h*(1-ratio));
  }
 };
 recurse(nodes,0,0,width,height);
 return result;
}

export function FolderTreemap({stats,folders,onChoose}:{stats:Stats;folders:Folder[];onChoose:(id:string)=>void}){
 const root=useMemo(()=>makeTree(stats,folders),[stats,folders]);
 const [selected,setSelected]=useState(ROOT);
 const byId=useMemo(()=>{
  const map=new Map<string,Node>();
  const visit=(node:Node)=>{map.set(node.id,node);for(const child of node.children)visit(child);};
  visit(root);return map;
 },[root]);
 const current=byId.get(selected)||root;
 const crumbs:Node[]=[];
 let cursor:Node|undefined=current;
 const seen=new Set<string>();
 while(cursor&&!seen.has(cursor.id)){seen.add(cursor.id);crumbs.unshift(cursor);cursor=cursor.parentId?byId.get(cursor.parentId):undefined;}
 if(crumbs[0]?.id!==ROOT)crumbs.unshift(root);
 const children=tileChildren(current);
 const total=children.reduce((sum,node)=>sum+node.bytes,0);
 const count=children.reduce((sum,node)=>sum+node.count,0);
 // A zero-byte folder must not receive an invented area when other folders
 // hold real bytes. Only use counts when the entire selection is zero-byte.
 const drawable=total>0?children.filter(node=>node.bytes>0):children.filter(node=>node.count>0);
 const rects=layout(drawable);

 return <div className="stats-map-wrap">
  <nav className="stats-map-path" aria-label="目录层级">
   {crumbs.map((node,index)=><span key={node.id} className="stats-map-crumb">
    {index>0&&<span className="stats-map-separator" aria-hidden="true">/</span>}
    <RareButton type="button" tone="ghost" aria-current={index===crumbs.length-1?"page":undefined} onClick={()=>setSelected(node.id)}>{node.id===ROOT?"全部目录":node.name}</RareButton>
   </span>)}
  </nav>
  {rects.length===0?<div className="stats-map-empty">当前范围没有可显示的文件容量</div>:
   <div className="stats-map-canvas" role="group" aria-label="目录空间分布，点击矩形可逐级查看">
    {rects.map(({node,x,y,width,height},index)=>{
     const share=total>0?node.bytes/total:count>0?node.count/count:0;
     const compact=width<155||height<78;
     const tiny=width<85||height<45;
     const canOpen=!node.virtual;
     return <RareButton
      key={node.id} type="button" className={"stats-map-tile stats-map-tone-"+index%7+(tiny?" is-tiny":"")}
      style={{left:x/10+"%",top:y/5.6+"%",width:width/10+"%",height:height/5.6+"%"}}
      title={node.name+" · "+formatBytes(node.bytes)+" · "+node.count+" 个文件 · "+(share*100).toFixed(1)+"%"}
      aria-label={node.name+"，"+formatBytes(node.bytes)+"，"+node.count+" 个文件，占 "+(share*100).toFixed(1)+"%"+(canOpen?"，点击进入":"")}
      onClick={()=>{if(canOpen)setSelected(node.id);else if(node.id.endsWith("::__direct")&&current.id!==ROOT)onChoose(current.id);}}
      disabled={node.id.startsWith(OTHER)}
     >
      {!tiny&&<span className="stats-map-tile-name">{node.name}</span>}
      {!compact&&<span className="stats-map-tile-number">{formatBytes(node.bytes)}</span>}
      {!compact&&<span className="stats-map-tile-meta">{(share*100).toFixed(1)}% · {node.count} 个</span>}
     </RareButton>;
    })}
   </div>}
  <div className="stats-map-caption"><span>{drawable.length} 个项目 · {formatBytes(total)}</span>
   {stats.treeTruncated&&<span>目录较多，仅展示前 1500 个含文件目录</span>}
   {current.id!==ROOT&&<RareButton type="button" tone="ghost" onClick={()=>onChoose(current.id)}>筛选此目录 ↗</RareButton>}
  </div>
 </div>;
}
