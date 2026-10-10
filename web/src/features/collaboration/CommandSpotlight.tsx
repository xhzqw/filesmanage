import {RareInput} from "../../shared/ui/rare";
import {useCallback,useEffect,useMemo,useRef,useState,type KeyboardEvent,type MouseEvent} from "react";
import {useNavigate} from "react-router-dom";
import {collaborationApi,formatBytes} from "./api";
// Size formatting: features/documents owns formatSize, but a feature may not
// import another feature (scripts/check_architecture.py) and shared has no
// formatter, so this feature's own formatBytes is reused rather than forked.
import type {FileItem} from "../../entities/file/model";
import type {Folder} from "../../entities/folder/model";
import "./commandSpotlight.css";

// CommandSpotlight (spec §6.4): the ⌘K/Ctrl+K global command palette. The header
// trigger dispatches this event and the same chord opens the palette from any
// authenticated route; the component renders nothing while closed, so no route
// carries stray overlay DOM.
const OPEN_EVENT="filesmanage:command-spotlight";
const DEBOUNCE_MS=120;
// The palette is a jump, not a browser: eight files and three folder hits are
// the whole visible budget, and the input keeps narrowing them.
const FILE_LIMIT=8;
const FOLDER_LIMIT=3;

// One flat row model for the listbox. The discriminated union keeps every
// per-kind payload required, so rendering never needs a size/date guard.
type FolderRow={kind:"folder";key:string;id:string;name:string;path:string};
type FileRow={kind:"file";key:string;id:string;name:string;size:number;updatedAt:string;folderName:string};
type Row=FolderRow|FileRow;

// The DOM key event, aliased because the React type of the same name is in
// scope for the panel's JSX handler.
type WindowKeyEvent=WindowEventMap["keydown"];

// Line icons drawn from currentColor: no asset, no hex literal, always hidden
// from the accessibility tree (VIS-11).
function CommandSearchIcon(){
  return <svg className="command-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>;
}
function CommandFolderIcon(){
  return <svg className="command-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M3 7.5A2 2 0 0 1 5 5.5h3.7l2 2.4H19a2 2 0 0 1 2 2v7.6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>;
}
function CommandFileIcon(){
  return <svg className="command-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6.5 3.5h6.7L18.5 8.8v11.7H6.5z"/><path d="M13 3.5v5.5h5.5"/></svg>;
}

export function CommandSpotlight(){
  const navigate=useNavigate();
  const inputRef=useRef<HTMLInputElement>(null);
  const listRef=useRef<HTMLUListElement>(null);
  // The tree is fetched once per session and cached in this ref; the mirrored
  // state exists only so the first resolved tree re-renders the folder hits.
  const treeRef=useRef<Folder[]|null>(null);
  const[folders,setFolders]=useState<Folder[]>([]);
  const[open,setOpen]=useState(false);
  const[query,setQuery]=useState("");
  const[term,setTerm]=useState("");
  const[items,setItems]=useState<FileItem[]>([]);
  const[status,setStatus]=useState<"idle"|"loading"|"ready"|"failed">("idle");
  const[active,setActive]=useState(0);
  // Request sequence: every revision bumps it, so a response that lands after a
  // newer query started is discarded instead of overwriting the newer rows.
  const epochRef=useRef(0);
  const restoreRef=useRef<HTMLElement|null>(null);

  const openPalette=useCallback(()=>{
    // A native <dialog> lives in the top layer: it paints above every z-index
    // and makes the document inert, so a palette opened on top of one would
    // have no caret, no keys and no way out.
    if(document.querySelector("dialog[open]")!==null)return;
    const owner=document.activeElement;
    restoreRef.current=owner instanceof HTMLElement?owner:null;
    // Opening starts from the empty query, which IS the recently-modified list,
    // so no keyword from a previous visit survives into a fresh one.
    setQuery("");
    setTerm("");
    setItems([]);
    setStatus("idle");
    setOpen(true);
  },[]);

  const closePalette=useCallback(()=>{
    setOpen(false);
    // The palette owns focus while open, so the saved element is still the one
    // that opened it; returning focus there is part of closing, not an extra
    // navigation side effect.
    const owner=restoreRef.current;
    restoreRef.current=null;
    owner?.focus();
  },[]);

  // The header trigger is a window event because the shell lives in shared/ui
  // and may not import this feature (scripts/check_architecture.py).
  useEffect(()=>{
    function onTrigger(){openPalette();}
    function onKey(event:WindowKeyEvent){
      if(!(event.metaKey||event.ctrlKey)||event.key.toLowerCase()!=="k")return;
      if(document.querySelector("dialog[open]")!==null)return;
      event.preventDefault();
      // Already open: the caret stays in the input instead of being re-stored.
      if(open)return;
      openPalette();
    }
    window.addEventListener(OPEN_EVENT,onTrigger);
    window.addEventListener("keydown",onKey);
    return()=>{
      window.removeEventListener(OPEN_EVENT,onTrigger);
      window.removeEventListener("keydown",onKey);
    };
  },[open,openPalette]);

  useEffect(()=>{
    if(!open)return;
    inputRef.current?.focus();
    inputRef.current?.select();
  },[open]);

  // One tree request per session. A failed tree only costs the folder hits: the
  // file rows still resolve their folder by id, so the palette stays usable.
  useEffect(()=>{
    if(!open||treeRef.current!==null)return;
    let alive=true;
    collaborationApi.folderTree()
     .then(list=>{
      if(!alive)return;
      treeRef.current=list;
      setFolders(list);
     })
     .catch(()=>{/* folder hits are an enhancement, never a palette failure */});
    return()=>{alive=false};
  },[open]);

  // Debounced query: the input updates per keystroke, the request follows 120ms
  // later, and the cleanup drops the pending timer on every change.
  useEffect(()=>{
    if(!open)return;
    const timer=window.setTimeout(()=>setTerm(query),DEBOUNCE_MS);
    return()=>{window.clearTimeout(timer);};
  },[query,open]);

  // The file list for the committed query. An empty term is the
  // recently-modified list, which is exactly what an open palette should show.
  useEffect(()=>{
    if(!open)return;
    const epoch=++epochRef.current;
    setStatus("loading");
    // A whitespace-only term is no term: it keeps showing the recent list
    // instead of asking the server for a match on a blank.
    const needle=term.trim();
    collaborationApi.search({q:needle===""?undefined:needle,limit:FILE_LIMIT,sort:"updated_desc"})
     .then(page=>{
      if(epochRef.current!==epoch)return;
      setItems(page.items);
      setStatus("ready");
     })
     .catch(()=>{if(epochRef.current===epoch)setStatus("failed");});
    return()=>{epochRef.current++;};
  },[term,open]);

  // Visible paths and leaf names from the cached tree: folder rows show the full
  // path, file rows the folder they live in. The seen set stops a cyclic parent
  // chain (bad data) from looping forever.
  const tree=useMemo(()=>{
    const byId=new Map<string,Folder>();
    for(const folder of folders)byId.set(folder.id,folder);
    const paths=new Map<string,string>();
    const names=new Map<string,string>();
    for(const folder of folders){
      const chain:string[]=[];
      const seen=new Set<string>();
      let current:Folder|undefined=folder;
      while(current&&!seen.has(current.id)){
        seen.add(current.id);
        chain.unshift(current.name);
        current=current.parentId!==null?byId.get(current.parentId):undefined;
      }
      paths.set(folder.id,chain.join(" / "));
      names.set(folder.id,folder.name);
    }
    return {paths,names};
  },[folders]);

  const keyword=term.trim().toLowerCase();

  const rows=useMemo<Row[]>(()=>{
    const list:Row[]=[];
    // Folders first, filtered client-side over the cached tree: /search is a
    // file endpoint, and a directory jump is worth three slots at the top.
    if(keyword!==""){
      for(const folder of folders){
        if(list.length>=FOLDER_LIMIT)break;
        if(!folder.name.toLowerCase().includes(keyword))continue;
        list.push({kind:"folder",key:"folder:"+folder.id,id:folder.id,name:folder.name,path:tree.paths.get(folder.id)??folder.name});
      }
    }
    for(const file of items){
      list.push({
        kind:"file",key:"file:"+file.id,id:file.id,name:file.name,
        size:file.sizeBytes,updatedAt:file.updatedAt.slice(0,16),
        folderName:tree.names.get(file.folderId)??"—",
      });
    }
    return list;
  },[folders,items,keyword,tree]);

  // A new result set always restarts the keyboard cursor on its first row.
  useEffect(()=>{setActive(0);},[rows]);

  useEffect(()=>{
    if(!open)return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({block:"nearest"});
  },[active,open,rows]);

  const activate=useCallback((row:Row|undefined)=>{
    if(!row)return;
    navigate(row.kind==="folder"?("/doc?folder="+encodeURIComponent(row.id)):("/preview/"+row.id));
    closePalette();
  },[closePalette,navigate]);

  function step(delta:number){
    if(rows.length===0)return;
    // Wrap: with at most eleven rows a dead end is only friction.
    setActive(current=>(current+delta+rows.length)%rows.length);
  }

  // Every key is handled on the panel, so the caret never leaves the input and
  // no result row needs its own tab stop (a palette is one text field plus a
  // virtual cursor).
  function onPanelKeyDown(event:KeyboardEvent<HTMLDivElement>){
    switch(event.key){
     case "ArrowDown":event.preventDefault();step(1);break;
     case "ArrowUp":event.preventDefault();step(-1);break;
     case "Home":event.preventDefault();setActive(0);break;
     case "End":event.preventDefault();setActive(Math.max(0,rows.length-1));break;
     case "Enter":event.preventDefault();activate(rows[active]);break;
     case "Escape":event.preventDefault();closePalette();break;
    }
  }

  function onOverlayMouseDown(event:MouseEvent<HTMLDivElement>){
    // Only the scrim itself closes: a selection drag that ends on the panel
    // must not dismiss the palette mid-choose.
    if(event.target===event.currentTarget)closePalette();
  }

  if(!open)return null;
  return <div className="command-overlay" onMouseDown={onOverlayMouseDown}>
   <div className="command-panel" role="dialog" aria-label="快速指令台" onKeyDown={onPanelKeyDown}>
    <div className="command-input-row">
     <CommandSearchIcon/>
     <RareInput ref={inputRef} className="command-input" type="text" value={query}
      onChange={event=>setQuery(event.target.value)}
      placeholder="快速搜索" aria-label="快速指令台检索" autoComplete="off"/>
    </div>
    {status==="loading"?<p className="command-status hint" role="status">检索中…</p>:null}
    {status==="failed"?<p className="command-status error" role="alert">检索失败，请重试</p>:null}
    {status==="ready"&&rows.length===0?<p className="command-status hint">没有匹配的结果</p>:null}
    {rows.length>0?<ul ref={listRef} className="command-list" role="listbox" aria-label="快速指令台结果">
     {rows.map((row,index)=>{
      const on=index===active;
      return <li key={row.key} className={"command-row"+(on?" active":"")} data-kind={row.kind} data-active={on?"true":"false"}
       role="option" aria-selected={on}
       onClick={()=>activate(row)} onMouseEnter={()=>setActive(index)}>
       {row.kind==="folder"
        ?<>
          <CommandFolderIcon/>
          <span className="command-row-name">{row.name}</span>
          <span className="command-row-path">{row.path}</span>
         </>
        :<>
          <CommandFileIcon/>
          <span className="command-row-name">{row.name}</span>
          <span className="command-row-meta">{formatBytes(row.size)}</span>
          <span className="command-row-meta">{row.updatedAt}</span>
          <span className="command-row-path">{row.folderName}</span>
         </>}
      </li>;
     })}
    </ul>:null}
   </div>
  </div>;
}
