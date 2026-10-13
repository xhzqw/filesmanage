import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import {collaborationApi,type Favorite} from "./api";
import {observeWorkspaceChange} from "../../shared/resourceSync";
import {FileResourceIcon,FolderResourceIcon} from "../../shared/ui/ResourceIcons";
import {RareButton} from "../../shared/ui/rare";
import "./finderSidebar.css";
import {FinderTags} from "./FinderTags";

export type DocumentSection="files"|"favorites"|"received"|"sent"|"labels";

function NavigationGlyph({kind}:{kind:"files"|"favorite"|"received"|"sent"}){
 const base={viewBox:"0 0 24 24",width:19,height:19,fill:"none",stroke:"currentColor",strokeWidth:1.8,strokeLinecap:"round" as const,strokeLinejoin:"round" as const,"aria-hidden":true as const};
 if(kind==="files")return <svg {...base}><path d="M3 8a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v9H3z"/><path d="M3 10h18"/></svg>;
 if(kind==="favorite")return <svg {...base}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-2.9-5.6 2.9 1.1-6.2L3 9.6l6.2-.9z"/></svg>;
 if(kind==="received")return <svg {...base}><rect x="3" y="4" width="18" height="15" rx="3"/><path d="m8 10 4 4 4-4M12 7v7"/></svg>;
 return <svg {...base}><rect x="3" y="4" width="18" height="15" rx="3"/><path d="m8 13 4-4 4 4M12 9v7"/></svg>;
}

export function FinderSidebar({section,revision}:{section:DocumentSection;revision:number}){
 const[favorites,setFavorites]=useState<Favorite[]>([]);
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[token,setToken]=useState(0);
 useEffect(()=>observeWorkspaceChange(()=>setToken(n=>n+1),["collaboration","permissions","file","folder"]),[]);
 useEffect(()=>{
  let active=true;
  collaborationApi.favoritesSidebar().then(page=>{
   if(active){setFavorites(page.items);setStatus("ready");}
  }).catch(()=>{if(active)setStatus("failed");});
  return()=>{active=false;};
 },[revision,token]);
 const link=(key:DocumentSection,label:string,kind:"files"|"favorite"|"received"|"sent")=>
  <Link className={"finder-nav-item"+(section===key?" is-current":"")} aria-current={section===key?"page":undefined}
   to={key==="files"?"/doc":"/doc?view="+key}>
   <NavigationGlyph kind={kind}/><span>{label}</span>
  </Link>;
 return <nav className="finder-navigation" aria-label="文档位置与共享">
  <div className="finder-nav-section">
   <div className="finder-nav-label">位置</div>
   {link("files","全部文档","files")}
  </div>
  <div className="finder-nav-section">
   <div className="finder-nav-label">个人收藏</div>
   {link("favorites","我的关注","favorite")}
   {favorites.slice(0,8).map(item=>{
    const id=item.kind==="file"?item.fileId:item.folderId;
    if(!id)return null;
    const href=item.kind==="file"?"/preview/"+encodeURIComponent(id):"/doc?folder="+encodeURIComponent(id);
    return <Link key={item.id} className="finder-favorite-item" to={href} title={item.resourceName}>
     {item.kind==="file"?<FileResourceIcon name={item.resourceName} size={17}/>:<FolderResourceIcon size={17}/>}
     <span>{item.resourceName}</span>
    </Link>;
   })}
   {status==="ready"&&favorites.length>=8&&<Link to="/doc?view=favorites" className="finder-nav-more">查看全部关注</Link>}
   {status==="ready"&&favorites.length===0&&<span className="finder-nav-empty">暂无关注</span>}
   {status==="failed"&&<RareButton type="button" className="finder-nav-retry" onClick={()=>setToken(n=>n+1)}>重试加载关注</RareButton>}
  </div>
  <div className="finder-nav-section">
   <div className="finder-nav-label">共享</div>
   {link("received","与我共享","received")}
   {link("sent","我共享的","sent")}
  </div>
  <FinderTags/>
 </nav>;
}
