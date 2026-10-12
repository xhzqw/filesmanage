import {RareButton,RareInput} from "../../shared/ui/rare";
import {Dialog} from "../../shared/ui/Dialog";
import {FileResourceIcon,FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {useCallback,useEffect,useMemo,useRef,useState,type KeyboardEvent} from "react";
import {useNavigate} from "react-router-dom";
import {collaborationApi} from "./api";
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

// Search hits carry only the information actually shown in the overlay.
type FolderRow={kind:"folder";key:string;id:string;name:string};
type FileRow={kind:"file";key:string;id:string;name:string};
type Row=FolderRow|FileRow;

// The DOM key event, aliased because the React type of the same name is in
// scope for the panel's JSX handler.
type WindowKeyEvent=WindowEventMap["keydown"];

// Line icons drawn from currentColor: no asset, no hex literal, always hidden
// from the accessibility tree (VIS-11).
function CommandSearchIcon(){
  return <svg className="command-icon" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="10.8" cy="10.8" r="7.2"/><path d="m16.3 16.3 4.4 4.4"/></svg>;
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
  const hasQuery=query.trim()!=="";
  // Request sequence: every revision bumps it, so a response that lands after a
  // newer query started is discarded instead of overwriting the newer rows.
  const epochRef=useRef(0);

  const openPalette=useCallback(()=>{
    // A native <dialog> lives in the top layer: it paints above every z-index
    // and makes the document inert, so a palette opened on top of one would
    // have no caret, no keys and no way out.
    if(document.querySelector("dialog[open]")!==null)return;
    // An empty palette contains only the search field, never recent files.
    setQuery("");
    setTerm("");
    setItems([]);
    setStatus("idle");
    setOpen(true);
  },[]);

  const closePalette=useCallback(()=>{
    setOpen(false);
    // Native Dialog restores focus after the top layer closes.
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

  // Do not make background requests while the blank palette is visible.
  useEffect(()=>{
    if(!open||!hasQuery||treeRef.current!==null)return;
    let alive=true;
    collaborationApi.folderTree()
     .then(list=>{
      if(!alive)return;
      treeRef.current=list;
      setFolders(list);
     })
     .catch(()=>{/* folder hits are an enhancement, never a palette failure */});
    return()=>{alive=false};
  },[open,hasQuery]);

  // Debounced query: the input updates per keystroke, the request follows 120ms
  // later, and the cleanup drops the pending timer on every change.
  useEffect(()=>{
    if(!open)return;
    const timer=window.setTimeout(()=>setTerm(query),DEBOUNCE_MS);
    return()=>{window.clearTimeout(timer);};
  },[query,open]);

  // Empty input is intentionally a one-line Spotlight, not a recent-files view.
  useEffect(()=>{
    if(!open)return;
    const needle=term.trim();
    if(!needle){
      epochRef.current++;
      setItems([]);
      setStatus("idle");
      return;
    }
    const epoch=++epochRef.current;
    setItems([]);
    setStatus("loading");
    collaborationApi.search({q:needle,limit:FILE_LIMIT,sort:"updated_desc"})
     .then(page=>{
      if(epochRef.current!==epoch)return;
      setItems(page.items);
      setStatus("ready");
     })
     .catch(()=>{if(epochRef.current===epoch)setStatus("failed");});
    return()=>{epochRef.current++;};
  },[term,open]);

  const keyword=term.trim().toLowerCase();

  const rows=useMemo<Row[]>(()=>{
    const list:Row[]=[];
    // Folders first, filtered client-side over the cached tree: /search is a
    // file endpoint, and a directory jump is worth three slots at the top.
    if(keyword!==""){
      for(const folder of folders){
        if(list.length>=FOLDER_LIMIT)break;
        if(!folder.name.toLowerCase().includes(keyword))continue;
        list.push({kind:"folder",key:"folder:"+folder.id,id:folder.id,name:folder.name});
      }
    }
    for(const file of items){
      list.push({kind:"file",key:"file:"+file.id,id:file.id,name:file.name});
    }
    return list;
  },[folders,items,keyword]);

  // Debouncing must not briefly show matches from a previous search.
  const showResults=hasQuery&&query.trim()===term.trim();
  const visibleRows=showResults?rows:[];

  // A new result set always restarts the keyboard cursor on its first row.
  useEffect(()=>{setActive(0);},[rows]);

  useEffect(()=>{
    if(!open)return;
    listRef.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({block:"nearest"});
  },[active,open,visibleRows.length]);

  const activate=useCallback((row:Row|undefined)=>{
    if(!row)return;
    navigate(row.kind==="folder"?("/doc?folder="+encodeURIComponent(row.id)):("/preview/"+row.id));
    closePalette();
  },[closePalette,navigate]);

  function step(delta:number){
    if(visibleRows.length===0)return;
    // Wrap: with at most eleven rows a dead end is only friction.
    setActive(current=>(current+delta+visibleRows.length)%visibleRows.length);
  }

  // Every key is handled on the panel, so the caret never leaves the input and
  // no result row needs its own tab stop (a palette is one text field plus a
  // virtual cursor).
  function onPanelKeyDown(event:KeyboardEvent<HTMLDivElement>){
    if(event.nativeEvent.isComposing)return;
    // Leave Enter/Space on the close button to native button activation.
    if(event.target!==inputRef.current&&event.key!=="Escape")return;
    switch(event.key){
     case "ArrowDown":event.preventDefault();step(1);break;
     case "ArrowUp":event.preventDefault();step(-1);break;
     case "Home":event.preventDefault();setActive(0);break;
     case "End":event.preventDefault();setActive(Math.max(0,visibleRows.length-1));break;
     case "Enter":event.preventDefault();activate(visibleRows[active]);break;
     case "Escape":event.preventDefault();closePalette();break;
    }
  }

  if(!open)return null;
  return <Dialog open title="聚焦搜索" className="command-panel command-native-dialog"
    initialFocus=".command-input" onClose={closePalette}>
   <div className={"command-content"+(showResults?" has-results":"")} onKeyDown={onPanelKeyDown}>
    <div className="command-input-row">
     <CommandSearchIcon/>
     <RareInput ref={inputRef} className="command-input" type="text" value={query}
      onChange={event=>setQuery(event.target.value)}
      placeholder="聚焦搜索" aria-label="聚焦搜索文件与文件夹" autoComplete="off"
      role="combobox" aria-autocomplete="list" aria-expanded={visibleRows.length>0}
      aria-controls="command-results" aria-activedescendant={visibleRows[active]?("command-result-"+active):undefined}/>
     <RareButton type="button" tone="ghost" className="command-close" aria-label="关闭搜索"
      title="关闭搜索（Esc）" onClick={closePalette}>
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor"
       strokeWidth="1.9" strokeLinecap="round" aria-hidden="true" focusable="false">
       <path d="M18 6 6 18M6 6l12 12"/>
      </svg>
     </RareButton>
    </div>
    {showResults&&status==="loading"&&visibleRows.length===0?<p className="command-status hint" role="status"><BrandLoadingLabel>搜索中</BrandLoadingLabel></p>:null}
    {showResults&&status==="failed"?<p className="command-status error" role="alert">搜索失败</p>:null}
    {showResults&&status==="ready"&&visibleRows.length===0?<p className="command-status hint" role="status">无匹配结果</p>:null}
    {visibleRows.length>0?<ul ref={listRef} id="command-results" className="command-list" role="listbox" aria-label="搜索结果">
     {visibleRows.map((row,index)=>{
      const on=index===active;
      return <li key={row.key} id={"command-result-"+index} className={"command-row"+(on?" active":"")} data-kind={row.kind} data-active={on?"true":"false"}
       role="option" aria-selected={on}
       onClick={()=>activate(row)} onMouseEnter={()=>setActive(index)}>
       {row.kind==="folder"
        ?<>
          <FolderResourceIcon size={16}/>
          <span className="command-row-name">{row.name}</span>
         </>
        :<>
          <FileResourceIcon name={row.name} size={18}/>
          <span className="command-row-name">{row.name}</span>
         </>}
      </li>;
     })}
    </ul>:null}
   </div>
  </Dialog>;
}
