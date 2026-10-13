import {useEffect,useRef,useState,type DragEvent,type KeyboardEvent,type MouseEvent} from "react";
import type {Folder} from "../../entities/folder/model";
import type {FileItem} from "../../entities/file/model";
import {folderApi} from "../folders/api";
import {FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {fileApi} from "./api";

// Ancestor columns share FileTable's existing action handlers instead of
// introducing an independent operation or permission model.
type Props={
 folder:Folder; activeChildId:string|null; activeFileId:string|null; reloadKey:number;
 onOpenFolder:(folder:Folder)=>void; onSelectFile:(file:FileItem)=>void;
 onOpenFile:(file:FileItem)=>void;
 onFileMenu:(event:MouseEvent<HTMLElement>,file:FileItem)=>void;
 onFolderMenu:(event:MouseEvent<HTMLElement>,folder:Folder)=>void;
 onFileDragStart:(event:DragEvent<HTMLElement>,file:FileItem)=>void;
 onFileDragEnd:(event:DragEvent<HTMLElement>)=>void;
 onFolderDragStart:(event:DragEvent<HTMLElement>,folder:Folder)=>void;
 onFolderDragEnd:()=>void;
 onDropFolder:(event:DragEvent<HTMLElement>,folder:Folder)=>void;
};
type Page={folders:Folder[];files:FileItem[];folderCursor:string;fileCursor:string};
const EMPTY:Page={folders:[],files:[],folderCursor:"",fileCursor:""};

export function FinderPathColumn(props:Props){
 const {folder,reloadKey}=props;
 const[data,setData]=useState<Page>(EMPTY);
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[moreBusy,setMoreBusy]=useState(false);
 const[moreFailed,setMoreFailed]=useState(false);
 const listRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  let live=true;
  const controller=new AbortController();
  setStatus("loading");setData(EMPTY);setMoreFailed(false);
  Promise.all([folderApi.children(folder.id),fileApi.list(folder.id,"name_asc","",50,controller.signal)])
   .then(([folders,files])=>{if(live){setData({
    folders:folders.items.map(item=>({id:item.id,name:item.name,parentId:item.parentId})),
    files:files.items,folderCursor:folders.nextCursor,fileCursor:files.nextCursor
   });setStatus("ready");}})
   .catch(()=>{if(live)setStatus("failed");});
  return()=>{live=false;controller.abort();};
 },[folder.id,reloadKey]);
 async function more(){
  if(moreBusy||(!data.folderCursor&&!data.fileCursor))return;
  setMoreBusy(true);setMoreFailed(false);
  try{
   const [folders,files]=await Promise.all([
    data.folderCursor?folderApi.children(folder.id,data.folderCursor):Promise.resolve(null),
    data.fileCursor?fileApi.list(folder.id,"name_asc",data.fileCursor,50):Promise.resolve(null),
   ]);
   setData(current=>({
    folders:folders?[...current.folders,...folders.items.map(item=>({id:item.id,name:item.name,parentId:item.parentId}))]:current.folders,
    files:files?[...current.files,...files.items]:current.files,
    folderCursor:folders?.nextCursor??"",fileCursor:files?.nextCursor??"",
   }));
  }catch{setMoreFailed(true);}finally{setMoreBusy(false);}
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
 return <div className="explorer-column-list finder-path-list" role="grid" aria-label={folder.name+" 的内容"} ref={listRef} data-column-folder-id={folder.id}>
  {status==="loading"&&<div className="finder-column-status" role="status"><BrandLoadingLabel size="sm" decorative>加载中…</BrandLoadingLabel></div>}
  {status==="failed"&&<div className="finder-column-status" role="alert">目录读取失败</div>}
  {status==="ready"&&<>
   {data.folders.map(item=><div key={"folder-"+item.id} role="row" tabIndex={0} data-row-key={"folder:"+item.id} data-folder-id={item.id} data-upload-folder-id={item.id}
    className={"finder-column-row finder-folder-row"+(props.activeChildId===item.id?" selected":"")}
    aria-selected={props.activeChildId===item.id}
    draggable onDragStart={event=>props.onFolderDragStart(event,item)} onDragEnd={props.onFolderDragEnd}
    onDragOver={event=>{if(event.dataTransfer.types.includes("application/x-filesmanage-files")||event.dataTransfer.types.includes("application/x-filesmanage-folder")){event.preventDefault();event.dataTransfer.dropEffect="move";}}}
    onDrop={event=>props.onDropFolder(event,item)}
    onClick={()=>props.onOpenFolder(item)} onDoubleClick={()=>props.onOpenFolder(item)}
    onContextMenu={event=>props.onFolderMenu(event,item)}
    onKeyDown={event=>keyMove(event,"folder",item.id)}>
    <FolderResourceIcon open={props.activeChildId===item.id} size={21}/>
    <span className="finder-column-name" title={item.name}>{item.name}</span>
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
    <span className="finder-column-name" title={file.name}>{file.name}</span>
   </div>)}
   {!data.folders.length&&!data.files.length&&<div className="finder-column-status">空文件夹</div>}
   {(data.folderCursor||data.fileCursor)&&<button className="finder-column-more" type="button" disabled={moreBusy} onClick={()=>void more()}>{moreBusy?"加载中…":moreFailed?"重试加载":"加载更多"}</button>}
  </>}
 </div>;
}
