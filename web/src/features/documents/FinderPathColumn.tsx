import {useEffect,useRef,useState,type DragEvent,type KeyboardEvent,type MouseEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import type {FileItem} from "../../entities/file/model";
import {FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {RareButton} from "../../shared/ui/rare";
import {request} from "../../shared/http";
import {fileApi} from "./api";
import {ExplorerCompactName} from "./ExplorerCompactName";
import {compareFinderFolders,type FinderSortKey} from "./finderSort";

// Ancestor columns share FileTable's existing action handlers instead of
// introducing an independent operation or permission model.
type Props={
 folder:Folder; activeChildId:string|null; activeFileId:string|null; reloadKey:number;sort:FinderSortKey;
 onOpenFolder:(folder:Folder)=>void; onSelectFile:(file:FileItem)=>void;
 onOpenFile:(file:FileItem)=>void;
 onFileMenu:(event:MouseEvent<HTMLElement>,file:FileItem)=>void;
 onFolderMenu:(event:MouseEvent<HTMLElement>,folder:Folder)=>void;
 onFileDragStart:(event:DragEvent<HTMLElement>,file:FileItem)=>void;
 onFileDragEnd:(event:DragEvent<HTMLElement>)=>void;
 onFolderDragStart:(event:DragEvent<HTMLElement>,folder:Folder)=>void;
 onFolderDragEnd:()=>void;
 canDropInFolder:(folder:Folder)=>boolean;
 onFolderDragOver:(event:DragEvent<HTMLElement>,folder:Folder)=>void;
 onDropFolder:(event:DragEvent<HTMLElement>,folder:Folder)=>void;
};
type Page={folders:Folder[];files:FileItem[];folderCursor:string;fileCursor:string};
const EMPTY:Page={folders:[],files:[],folderCursor:"",fileCursor:""};
type FolderPage={items:(Folder&{hasChildren?:boolean})[];nextCursor:string};
function readFolderChildren(parentId:string,cursor=""){
 return request<FolderPage>("/folders/children?"+new URLSearchParams({
  parentId,cursor,limit:"50"
 }).toString());
}

export function FinderPathColumn(props:Props){
 const {folder,reloadKey,sort}=props;
 const[data,setData]=useState<Page>(EMPTY);
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[moreBusy,setMoreBusy]=useState(false);
 const[moreFailed,setMoreFailed]=useState(false);
 const[dropTargetId,setDropTargetId]=useState<string|null>(null);
 const listRef=useRef<HTMLDivElement>(null);
 // Sorting and directory navigation invalidate outstanding pagination
 // responses. A slow old-order page must never append into a new order.
 const generation=useRef(0);
 const previousFolder=useRef(folder.id);
 function internalMove(event:DragEvent<HTMLElement>){
  const types=Array.from(event.dataTransfer.types);
  return !types.includes("Files")&&(types.includes("application/x-filesmanage-files")||types.includes("application/x-filesmanage-folder"));
 }
 function overTarget(event:DragEvent<HTMLElement>,target:Folder){
  if(!internalMove(event))return;
  props.onFolderDragOver(event,target);
  setDropTargetId(props.canDropInFolder(target)?target.id:null);
 }
 function leaveTarget(event:DragEvent<HTMLElement>,targetId:string){
  if(!event.currentTarget.contains(event.relatedTarget as Node|null))
   setDropTargetId(id=>id===targetId?null:id);
 }
 useEffect(()=>{
  let live=true;
  const controller=new AbortController();
  const version=++generation.current;
  const folderChanged=previousFolder.current!==folder.id;
  previousFolder.current=folder.id;
  if(folderChanged){setStatus("loading");setData(EMPTY);}
  setMoreBusy(false);setMoreFailed(false);
  Promise.all([readFolderChildren(folder.id),fileApi.list(folder.id,sort,"",50,controller.signal)])
   .then(([folders,files])=>{if(live&&version===generation.current){setData({
    folders:folders.items.map(item=>({id:item.id,name:item.name,parentId:item.parentId,updatedAt:item.updatedAt})),
    files:files.items,folderCursor:folders.nextCursor,fileCursor:files.nextCursor
   });setStatus("ready");}})
   .catch(()=>{if(live&&version===generation.current)setStatus("failed");});
  return()=>{live=false;controller.abort();};
 },[folder.id,reloadKey,sort]);
 async function more(){
  if(moreBusy||(!data.folderCursor&&!data.fileCursor))return;
  const version=generation.current;
  setMoreBusy(true);setMoreFailed(false);
  try{
   const [folders,files]=await Promise.all([
    data.folderCursor?readFolderChildren(folder.id,data.folderCursor):Promise.resolve(null),
    data.fileCursor?fileApi.list(folder.id,sort,data.fileCursor,50):Promise.resolve(null),
   ]);
   if(version!==generation.current)return;
   setData(current=>({
    folders:folders?[...current.folders,...folders.items.map(item=>({id:item.id,name:item.name,parentId:item.parentId,updatedAt:item.updatedAt}))]:current.folders,
    files:files?[...current.files,...files.items]:current.files,
    folderCursor:folders?.nextCursor??"",fileCursor:files?.nextCursor??"",
   }));
  }catch{if(version===generation.current)setMoreFailed(true);}
  finally{if(version===generation.current)setMoreBusy(false);}
 }
 function keyMove(event:KeyboardEvent<HTMLElement>,kind:"file"|"folder",id:string){
  if(event.target!==event.currentTarget)return;
  if(event.key==="ArrowDown"||event.key==="ArrowUp"){
   event.preventDefault();
   const rows=Array.from(listRef.current?.querySelectorAll<HTMLElement>(".finder-column-row")??[]);
   const index=rows.findIndex(row=>row.dataset.rowKey===kind+":"+id);
   rows[Math.max(0,Math.min(rows.length-1,index+(event.key==="ArrowDown"?1:-1)))]?.focus();
  }else if(event.key==="ArrowRight"||event.key==="Enter"){
   event.preventDefault();
   if(kind==="folder"){
    const next=data.folders.find(item=>item.id===id);
    if(next)props.onOpenFolder(next);
   }else{
    const file=data.files.find(item=>item.id===id);
    if(file)props.onSelectFile(file);
   }
  }else if(event.key==="ArrowLeft"){
   event.preventDefault();props.onOpenFolder(folder);
  }
 }
 return <div className={"explorer-column-list finder-path-list"+(dropTargetId===folder.id?" drop-target":"")} role="grid" aria-label={folder.name+" 的内容"} ref={listRef} data-column-folder-id={folder.id} data-sort={sort}
  onDragOver={event=>{if(!(event.target as HTMLElement).closest(".finder-column-row"))overTarget(event,folder);}}
  onDragLeave={event=>leaveTarget(event,folder.id)}
  onDrop={event=>{if(!internalMove(event))return;setDropTargetId(null);props.onDropFolder(event,folder);}}>
  {status==="loading"&&<div className="finder-column-status" role="status"><BrandLoadingLabel size="sm" decorative>加载中…</BrandLoadingLabel></div>}
  {status==="failed"&&<div className="finder-column-status" role="alert">目录读取失败</div>}
  {status==="ready"&&<>
   {[...data.folders].sort((a,b)=>compareFinderFolders(a,b,sort)).map(item=><div key={"folder-"+item.id} role="row" tabIndex={0} data-row-key={"folder:"+item.id} data-folder-id={item.id} data-upload-folder-id={item.id}
    className={"finder-column-row finder-folder-row"+(props.activeChildId===item.id?" selected":"")+(dropTargetId===item.id?" drop-target":"")}
    aria-selected={props.activeChildId===item.id}
    draggable onDragStart={event=>props.onFolderDragStart(event,item)} onDragEnd={props.onFolderDragEnd}
    onDragOver={event=>overTarget(event,item)}
    onDragLeave={event=>leaveTarget(event,item.id)}
    onDrop={event=>{if(internalMove(event))event.stopPropagation();setDropTargetId(null);props.onDropFolder(event,item);}}
    onClick={()=>props.onOpenFolder(item)} onDoubleClick={()=>props.onOpenFolder(item)}
    onContextMenu={event=>props.onFolderMenu(event,item)}
    onKeyDown={event=>keyMove(event,"folder",item.id)}>
    <FolderResourceIcon open={props.activeChildId===item.id} size={21}/>
    <span className="finder-column-name" title={item.name}><ExplorerCompactName name={item.name} context="column"/></span>
    <span className="finder-column-chevron" aria-hidden="true">›</span>
   </div>)}
   {data.files.map(file=><div key={"file-"+file.id} role="row" tabIndex={0} data-row-key={"file:"+file.id} data-id={file.id}
    className={"finder-column-row finder-file-row"+(props.activeFileId===file.id?" selected":"")}
    aria-selected={props.activeFileId===file.id} draggable
    onDragStart={event=>props.onFileDragStart(event,file)} onDragEnd={props.onFileDragEnd}
    onClick={()=>props.onSelectFile(file)}
    onDoubleClick={()=>props.onOpenFile(file)}
    onContextMenu={event=>props.onFileMenu(event,file)}
    onKeyDown={event=>keyMove(event,"file",file.id)}>
    <FileTypeIcon name={file.name} size={19}/>
    <span className="finder-column-name" title={file.name}><ExplorerCompactName name={file.name} context="column"/></span>
   </div>)}
   {!data.folders.length&&!data.files.length&&<div className="finder-column-status">空文件夹</div>}
   {(data.folderCursor||data.fileCursor)&&<RareButton tone="ghost" className="finder-column-more" type="button" disabled={moreBusy} onClick={()=>void more()}>{moreBusy?"加载中…":moreFailed?"重试加载":"加载更多"}</RareButton>}
  </>}
 </div>;
}
