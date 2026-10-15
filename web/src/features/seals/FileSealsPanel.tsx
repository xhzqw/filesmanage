import {useEffect,useLayoutEffect,useRef,useState,type SyntheticEvent} from "react";
import {createPortal} from "react-dom";
import {Link} from "react-router-dom";
import {RareBadge,RareButton,RareInput} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {toast} from "../../shared/ui/feedback";
import {Dialog} from "../../shared/ui/Dialog";
import {sealsApi} from "./api";
import {SealPageCanvas} from "./SealPageCanvas";
import {SealRevisionControls} from "./SealRevisionControls";
import {fitStampToPage,stampFitsPage} from "./sealGeometry";
import type {SealAsset,SealPlacement,FileSealMark,SealUserPermission} from "../../entities/seal/model";
import "./seals.css";

type DraftSeal=Omit<SealPlacement,"password"|"versionSeq"|"fileSha256">;
type Position=Pick<DraftSeal,"x"|"y"|"width"|"height">;
const clamp=(value:number,max:number)=>Math.max(0,Math.min(max,value));

export function FileSealsPanel({fileId,seq,sha,name,isAdmin,onSelectRevision,onChanged,controlsTargetId}:{fileId:string;seq:number;sha:string;name:string;isAdmin:boolean;onSelectRevision:(revision:number)=>void;onChanged:()=>void;controlsTargetId?:string}){
 const[host,setHost]=useState<HTMLElement|null>(null);
 useLayoutEffect(()=>{setHost(controlsTargetId?document.getElementById(controlsTargetId):null)},[controlsTargetId]);
 const[assets,setAssets]=useState<SealAsset[]>([]);
 const[access,setAccess]=useState<SealUserPermission|null>(null);
 const[marks,setMarks]=useState<FileSealMark[]>([]);
 const[usedAssetIds,setUsedAssetIds]=useState<string[]>([]);
 const[assetId,setAssetId]=useState("");
 const[assetQuery,setAssetQuery]=useState("");
 const aspectRef=useRef<Record<string,number>>({});
 const initialRef=useRef<Record<string,Position>>({});
 const[page,setPage]=useState(1);
 const[pageCount,setPageCount]=useState(0);
 const[imageRetry,setImageRetry]=useState(0);
 const[position,setPosition]=useState<Position>({x:.70,y:.78,width:.22,height:.12});
 const[angle,setAngle]=useState(0);
 const[pageRatio,setPageRatio]=useState(1.414);
 const[staged,setStaged]=useState<DraftSeal[]>([]);
 const[password,setPassword]=useState("");
 const[confirmOpen,setConfirmOpen]=useState(false);
 const[deleteMode,setDeleteMode]=useState(false);
 const[deleteIds,setDeleteIds]=useState<string[]>([]);
 const[deleteOpen,setDeleteOpen]=useState(false);
 const[deletePassword,setDeletePassword]=useState("");
 const[deleteBusy,setDeleteBusy]=useState(false);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[imageAvailable,setImageAvailable]=useState(true);
 const[revision,setRevision]=useState(0);
 const isPDF=name.toLowerCase().endsWith(".pdf");
 const requiresPassword=staged.some(item=>assets.find(asset=>asset.id===item.assetId)?.kind==="personal");
 const removable=marks.filter(mark=>
  isAdmin||(mark.signerId===access?.userId&&(mark.assetKind==="personal"||!!access?.canStamp)));
 const deleteNeedsPassword=deleteIds.some(id=>marks.some(mark=>mark.id===id&&mark.assetKind==="personal"));
 const deleteKinds=deleteIds.map(id=>marks.find(mark=>mark.id===id)?.assetKind);
 const deleteLabel=deleteKinds.every(kind=>kind==="company")?"公章":deleteKinds.every(kind=>kind==="personal")?"签名":"签章";
 const selected=assets.find(a=>a.id===assetId);
 const maySign=!!selected&&selected.active&&(selected.kind!=="personal"||!!selected.ownerId)&&
  (isAdmin||(selected.kind==="personal"?!!access?.canSign:!!access?.canStamp));
 const duplicate=!!selected&&(usedAssetIds.includes(selected.id)||staged.some(s=>s.assetId!==selected.id&&assets.some(a=>a.id===s.assetId&&a.sha256===selected.sha256)));
 const rotationFits=stampFitsPage(position,angle,pageRatio);
 const imageUrl="/api/files/"+encodeURIComponent(fileId)+"/seals/page?"+
  new URLSearchParams({version:String(seq),page:String(page),sha256:sha,retry:String(imageRetry)}).toString();
 const availableAssets=assets.filter(a=>(a.name+" "+(a.ownerName||"")+" "+(a.kind==="personal"?"个人签名":"公章")).toLocaleLowerCase().includes(assetQuery.trim().toLocaleLowerCase()));
 function assetDisabled(a:SealAsset){
  return !a.active||(a.kind==="personal"&&!a.ownerId)||
   (!isAdmin&&(a.kind==="personal"?!access?.canSign:!access?.canStamp))||
   usedAssetIds.includes(a.id)||staged.some(s=>s.assetId!==a.id&&assets.some(b=>b.id===s.assetId&&b.sha256===a.sha256));
 }
 function stampHeight(asset:string,width:number,ratio=pageRatio){
  const aspect=aspectRef.current[asset];
  return aspect?Math.max(.025,Math.min(.65,width/(aspect*ratio))):.12;
 }
 // Thumbnails also load the real image ratio. Never overwrite a manually edited draft.
 function artworkLoaded(asset:string,event:SyntheticEvent<HTMLImageElement>){
  const img=event.currentTarget;
  const aspect=img.naturalWidth/img.naturalHeight;
  if(!Number.isFinite(aspect)||aspect<=0||aspectRef.current[asset]===aspect)return;
  aspectRef.current[asset]=aspect;
  const initial=initialRef.current[asset];
  if(!initial)return;
  const height=stampHeight(asset,initial.width);
  const updated=fitStampToPage({...initial,y:initial.y+(initial.height-height)/2,height},0,pageRatio);
  setStaged(items=>items.map(item=>item.assetId===asset&&
   item.x===initial.x&&item.y===initial.y&&item.width===initial.width&&item.height===initial.height&&item.angleDegrees===0
   ?{...item,...updated}:item));
  if(assetId===asset)setPosition(current=>current.x===initial.x&&current.y===initial.y&&current.width===initial.width&&current.height===initial.height?updated:current);
  delete initialRef.current[asset];
 }

 useEffect(()=>{
  let live=true;
  setStaged([]);setAssetId("");setAssetQuery("");aspectRef.current={};initialRef.current={};setPassword("");setConfirmOpen(false);setDeleteMode(false);setDeleteIds([]);setDeleteOpen(false);setDeletePassword("");
  Promise.all([sealsApi.list(),sealsApi.marks(fileId,seq),sealsApi.myPermission(),sealsApi.used(fileId)])
   .then(([available,entries,permission,used])=>{
    if(!live)return;
    setAccess(permission);
    setAssets(available.filter(a=>isAdmin||a.kind==="company"||!!a.ownerId));
    setMarks(entries);setUsedAssetIds(used);
   }).catch(err=>{if(live)setError(errorCopy(err,"签章资料读取失败"))});
  return()=>{live=false};
 },[fileId,seq,isAdmin]);
 // A completed batch refreshes immutable evidence without discarding another in-progress draft.
 useEffect(()=>{
  if(revision===0)return;
  let live=true;
  Promise.all([sealsApi.marks(fileId,seq),sealsApi.used(fileId)]).then(([entries,used])=>{
   if(live){setMarks(entries);setUsedAssetIds(used)}
  }).catch(err=>{if(live)setError(errorCopy(err,"签章记录刷新失败"))});
  return()=>{live=false};
 },[fileId,seq,revision]);
 useEffect(()=>setImageAvailable(true),[imageUrl]);
 useEffect(()=>{
  if(!isPDF)return;
  let live=true;
  setPage(1);setPageCount(0);setImageRetry(0);
  void sealsApi.pageCount(fileId,sha).then(result=>{
   if(live)setPageCount(Math.max(0,result.pageCount));
  }).catch(err=>{if(live)setError(errorCopy(err,"无法获取 PDF 页数"))});
  return()=>{live=false};
 },[fileId,sha,isPDF]);

 function updatePosition(updater:(value:Position)=>Position){
  const next=updater(position);
  if(assetId)delete initialRef.current[assetId];
  setPosition(next);
  if(assetId)setStaged(list=>list.map(item=>item.assetId===assetId?{...item,...next,pageNumber:page}:item));
 }
 function changeAngle(value:number){
  if(assetId)delete initialRef.current[assetId];
  const next=Math.max(-180,Math.min(180,Math.round(Number.isFinite(value)?value:0)));
  const moved=fitStampToPage(position,next,pageRatio);
  setAngle(next);setPosition(moved);
  setStaged(list=>list.map(item=>item.assetId===assetId?{...item,...moved,angleDegrees:next}:item));
 }
 function changeSize(update:Partial<Position>){
  if(assetId)delete initialRef.current[assetId];
  const next=fitStampToPage({...position,...update},angle,pageRatio);
  setPosition(next);
  if(assetId)setStaged(list=>list.map(item=>item.assetId===assetId?{...item,...next}:item));
 }
 function changePage(next:number){
  setPage(Math.max(1,Math.min(pageCount||1,next)));
 }
 function pickAsset(id:string){
  if(deleteMode)return;
  if(!id){setAssetId("");return;}
  const asset=assets.find(a=>a.id===id);
  if(!asset||!isPDF||busy||!pageCount||!imageAvailable)return;
  const existing=staged.find(item=>item.assetId===id);
  if(!existing&&assetDisabled(asset))return;
  const permitted=isAdmin||(asset.kind==="personal"?!!access?.canSign:!!access?.canStamp);
  if(!permitted||(asset.kind==="personal"&&!asset.ownerId))return;
  if(existing){
   setPage(existing.pageNumber);
   setPosition({x:existing.x,y:existing.y,width:existing.width,height:existing.height});
   setAngle(existing.angleDegrees);
   setAssetId(id);return;
  }
  if(staged.length>=20){setError("每次最多放置 20 枚签章");return;}
  if(staged.some(item=>assets.find(a=>a.id===item.assetId)?.sha256===asset.sha256)){
   setError("同一文件不能重复使用相同签章");return;
  }
  const width=.22,height=stampHeight(id,width);
  const initial=fitStampToPage({x:.5-width/2,y:.5-height/2,width,height},0,pageRatio);
  if(!aspectRef.current[id])initialRef.current[id]=initial;
  setAssetId(id);setPosition(initial);setAngle(0);
  setStaged(list=>[...list,{assetId:id,pageNumber:page,...initial,angleDegrees:0}]);
  setError("");
 }
 function removeDraft(id:string){
  delete initialRef.current[id];
  setStaged(list=>list.filter(item=>item.assetId!==id));
  if(assetId===id)setAssetId("");
 }
 function clearDrafts(){initialRef.current={};setStaged([]);setAssetId("");setError("");}
 async function sign(pass=password){
  if((requiresPassword&&!pass)||!isPDF||busy||!pageCount||!staged.length||!imageAvailable)return;
  setBusy(true);setError("");
  try{
   const marks=await sealsApi.applyBatch(fileId,{versionSeq:seq,fileSha256:sha,password:pass,placements:staged});
   setStaged([]);setAssetId("");setConfirmOpen(false);setRevision(n=>n+1);onChanged();
   toast.success("已保存 "+marks.length+" 枚签章");
  }catch(err){setError(errorCopy(err,"签署失败，未保存本次签章，请检查密码、权限和位置"))}
  finally{setPassword("");setBusy(false)}
 }
 function requestSign(){
  if(!staged.length||busy)return;
  setError("");
  if(requiresPassword){setPassword("");setConfirmOpen(true);}
  else void sign("");
 }
 function toggleDeleteMode(){
  if(deleteMode){setDeleteMode(false);setDeleteIds([]);setDeleteOpen(false);}
  else{setAssetId("");setDeleteIds([]);setDeleteMode(true);}
 }
 function toggleDeleteMark(id:string){
  setDeleteIds(items=>items.includes(id)?items.filter(value=>value!==id):[...items,id]);
 }
 async function revoke(){
  if(deleteBusy||(deleteNeedsPassword&&!deletePassword)||!deleteIds.length)return;
  setDeleteBusy(true);setError("");
  try{
   const history=await sealsApi.history(fileId,seq);
   await sealsApi.revokeMarks(fileId,{
    versionSeq:seq,fileSha256:sha,expectedRevision:history.current,
    markIds:deleteIds,password:deletePassword
   });
   toast.success("已删除 "+deleteIds.length+" 处"+deleteLabel);
   setDeleteOpen(false);setDeleteMode(false);setDeleteIds([]);setDeletePassword("");
   setRevision(value=>value+1);onChanged();
  }catch(err){setError(errorCopy(err,"删除签章失败，请核实权限或密码"))}
  finally{setDeletePassword("");setDeleteBusy(false)}
 }
 const controls = <div className="seal-file-controls">
   {error&&!confirmOpen&&!deleteOpen&&<p role="alert" className="notice error">{error}</p>}
   <div className="seal-stamp-library-heading"><strong>签名 / 公章</strong><span>{assets.length} 枚</span></div>
   {assets.length>4&&<RareInput type="search" className="seal-stamp-search" aria-label="筛选签名或公章"
    placeholder="搜索签名或公章" value={assetQuery} onChange={e=>setAssetQuery(e.target.value)}/>}
   <div className="seal-stamp-grid" role="group" aria-label="选择要放置的签章">
    {availableAssets.map(a=>{
     const placed=staged.some(item=>item.assetId===a.id);
     const disabled=(!placed&&assetDisabled(a))||deleteMode||busy||!isPDF||!pageCount||!imageAvailable;
     return <RareButton key={a.id} type="button" tone="ghost" className={"seal-stamp-card"+(assetId===a.id?" is-selected":"")}
      aria-pressed={assetId===a.id} disabled={disabled} title={disabled&&!a.active?"已停用":a.name}
      onClick={()=>pickAsset(a.id)}>
      <img src={sealsApi.imageUrl(a.id)} alt="" loading="lazy" onLoad={e=>artworkLoaded(a.id,e)}/>
      <span className="seal-stamp-info"><strong>{a.kind==="personal"?(a.ownerName||a.name):a.name}</strong>
       <small>{a.kind==="personal"?"个人签名":"公章"}{!a.active?" · 已停用":usedAssetIds.includes(a.id)?" · 已使用":placed?" · 已放置":""}</small></span>
     </RareButton>;
    })}
    {assets.length>0&&availableAssets.length===0&&<p className="seal-stamp-no-match">没有匹配的签章</p>}
   </div>
   {assets.length===0&&<p className="seal-asset-empty" role="status">尚无可用签章。<Link to="/approvals?tab=seals">去签章管理导入</Link></p>}
   {selected&&!maySign&&<p role="status" className="hint">当前账号没有此签名／印章使用权限，或尚未绑定归属人。</p>}
   {duplicate&&<p role="status" className="hint">当前文件或待签清单已使用同一枚签章。</p>}
   {selected&&<details className="seal-advanced-settings">
    <summary>精确调整 <span>{Math.round(position.width*100)}% · {angle}°</span></summary>
   <div className="seal-size-controls">
    <label>宽度 %<RareInput type="number" min={5} max={100} step={1} value={Math.round(position.width*100)}
     onChange={e=>changeSize({width:clamp((Number(e.target.value)||5)/100,1)})}/></label>
    <label>高度 %<RareInput type="number" min={5} max={100} step={1} value={Math.round(position.height*100)}
     onChange={e=>changeSize({height:clamp((Number(e.target.value)||5)/100,1)})}/></label>
   </div>
   <div className="seal-angle-control">
    <div className="seal-angle-heading"><strong>旋转角度</strong><span>{angle}°</span></div>
    <div className="seal-angle-inputs">
     <RareInput type="range" className="seal-angle-range" min={-180} max={180} step={1} value={angle} aria-label="签名或印章旋转角度" onChange={e=>changeAngle(Number(e.target.value))}/>
     <RareInput type="number" className="seal-angle-number" min={-180} max={180} step={1} value={angle} aria-label="旋转度数" onChange={e=>changeAngle(Number(e.target.value))}/>
    </div>
    <div className="seal-angle-presets">
     <RareButton type="button" onClick={()=>changeAngle(-90)}>−90°</RareButton>
     <RareButton type="button" onClick={()=>changeAngle(0)}>归零</RareButton>
     <RareButton type="button" onClick={()=>changeAngle(90)}>+90°</RareButton>
    </div>
    {!rotationFits&&<p role="status" className="seal-angle-warning">旋转后超出页面，请调整大小或位置。</p>}
   </div>
   </details>}
   {staged.length>0&&<div className="seal-draft-heading">已放置 <RareBadge tone="neutral">{staged.length}</RareBadge></div>}
   {staged.length>0&&<div className="seal-draft-list" aria-label="已放置的人员签名与公章">
    {staged.map((item,i)=>{
     const a=assets.find(x=>x.id===item.assetId);
     return <div className={"seal-draft-row"+(assetId===item.assetId?" is-active":"")} key={item.assetId}>
      <RareButton type="button" aria-pressed={assetId===item.assetId} onClick={()=>pickAsset(item.assetId)}>
       <span className="seal-draft-index">{i+1}</span>
       <span className="seal-draft-label">{a?.ownerName||a?.name||"签章"}<small>第 {item.pageNumber} 页 · {item.angleDegrees}°</small></span>
      </RareButton>
      <RareButton type="button" className="seal-draft-remove" aria-label={"移除"+(a?.name||"签章")} disabled={busy}
       onClick={()=>removeDraft(item.assetId)}><svg viewBox="0 0 20 20" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 5l10 10M15 5 5 15"/></svg></RareButton>
     </div>;
    })}
   </div>}
   {!isPDF&&<p className="hint">Office 文件需先生成 PDF 副本再签署。</p>}
  </div>;
 const history = <details className="seal-sidebar-history">
  <summary>签署记录 <span>{marks.length}</span></summary>
  <aside className="seal-file-history">
   <SealRevisionControls fileId={fileId} seq={seq} sha={sha} isAdmin={isAdmin}
    refreshKey={revision} onSelect={onSelectRevision} onRestored={()=>{
     setStaged([]);setAssetId("");setDeleteMode(false);setDeleteIds([]);setRevision(n=>n+1);onChanged();
    }}/>

   {removable.length>0&&<div className="seal-history-actions">
    <RareButton type="button" tone="ghost" onClick={toggleDeleteMode}>{deleteMode?"取消选择":"选择删除签章"}</RareButton>
    {deleteMode&&<RareButton type="button" tone="danger" disabled={!deleteIds.length||deleteBusy}
     onClick={()=>{setError("");setDeletePassword("");setDeleteOpen(true)}}>删除选中 ({deleteIds.length})</RareButton>}
   </div>}
   {deleteMode&&<p className="seal-history-guidance">选择下方签章或点击纸张上的记录，再确认删除。</p>}
   {marks.length===0&&<p className="empty">此版本尚无签章</p>}
   {marks.map(m=><div key={m.id} className={"seal-history-row"+(deleteIds.includes(m.id)?" is-selected":"")}>
    <div><strong>{m.assetName}</strong><RareBadge tone="neutral">第 {m.pageNumber} 页</RareBadge></div>
    <small>{m.signerName} · {new Date(m.createdAt).toLocaleString("zh-CN")}</small>
    <small>v{m.versionSeq} · {m.angleDegrees?m.angleDegrees+"° · ":""}SHA {m.fileSha256.slice(0,12)}…</small>
    {deleteMode&&<RareButton type="button" tone="ghost" className="seal-history-pick"
     disabled={!removable.some(mark=>mark.id===m.id)}
     aria-pressed={deleteIds.includes(m.id)} onClick={()=>toggleDeleteMark(m.id)}>
     {deleteIds.includes(m.id)?"✓ 已选中":"选择此签章"}</RareButton>}
   </div>)}
  </aside>
 </details>;
 return <div className={"seal-file-workspace"+(controlsTargetId?" is-workbench":"")}>
  {controlsTargetId&&host?createPortal(<div className="file-seal-sidebar-controls">{controls}{history}</div>,host):<>{controls}{history}</>}
  {isPDF?<SealPageCanvas fileId={fileId} page={page} imageUrl={imageUrl} selected={selected} marks={marks}
   position={position} setPosition={updatePosition} angle={angle} pageRatio={pageRatio} setPageRatio={setPageRatio}
   pageCount={pageCount} onPageChange={changePage} onRetry={()=>setImageRetry(n=>n+1)}
   onSelectDraft={pickAsset} onRemoveDraft={removeDraft} pendingCount={staged.length}
   onConfirm={requestSign} onClearDrafts={clearDrafts} onRotate={delta=>changeAngle(((angle+delta+540)%360)-180)} canConfirm={!busy&&!!pageCount&&imageAvailable&&staged.length>0&&staged.every(item=>stampFitsPage(item,item.angleDegrees,pageRatio))}
   deleteMode={deleteMode} deletableMarkIds={removable.map(mark=>mark.id)}
   deleteIds={deleteIds} onToggleDeleteMark={toggleDeleteMark}
   imageAvailable={imageAvailable} setImageAvailable={setImageAvailable}
   drafts={staged.map(item=>({...item,asset:assets.find(a=>a.id===item.assetId)}))}/>:
   <div className="seal-file-preview"><p className="empty">仅 PDF 支持页面定位</p></div>}
  <Dialog open={confirmOpen} title={"确认签名 · "+staged.length+" 枚"} onClose={()=>{setConfirmOpen(false);setPassword("");setError("")}}
   closeGuard={()=>!busy} initialFocus='input[aria-label="本人登录密码"]' className="seal-confirm-dialog">
   <form onSubmit={event=>{event.preventDefault();void sign()}}>
    <label>登录密码
     <RareInput type="password" aria-label="本人登录密码" autoComplete="current-password" value={password}
      placeholder="输入密码以确认本次签署" onChange={e=>setPassword(e.target.value)}/>
    </label>
    {error&&<p className="notice error" role="alert">{error}</p>}
    <div className="dialog-actions">
     <RareButton type="button" disabled={busy} onClick={()=>{setConfirmOpen(false);setPassword("");setError("")}}>取消</RareButton>
     <RareButton type="submit" className="primary" loading={busy} disabled={(requiresPassword&&!password)||!staged.length}>
      {"确认签署（"+staged.length+"）"}
     </RareButton>
    </div>
   </form>
  </Dialog>
  <Dialog open={deleteOpen} title={"删除"+deleteLabel+" · "+deleteIds.length+" 处"}
   onClose={()=>{if(!deleteBusy){setDeleteOpen(false);setDeletePassword("");setError("")}}}
   closeGuard={()=>!deleteBusy} initialFocus={deleteNeedsPassword?'input[aria-label="删除签名密码"]':undefined} className="seal-confirm-dialog">
   <form onSubmit={event=>{event.preventDefault();void revoke()}}>
    {deleteNeedsPassword&&<label>登录密码
     <RareInput type="password" aria-label="删除签名密码" autoComplete="current-password"
      value={deletePassword} placeholder="输入密码确认删除" disabled={deleteBusy}
      onChange={event=>setDeletePassword(event.target.value)}/>
    </label>}
    {error&&<p className="notice error" role="alert">{error}</p>}
    <div className="dialog-actions">
     <RareButton type="button" disabled={deleteBusy} onClick={()=>{setDeleteOpen(false);setDeletePassword("");setError("")}}>取消</RareButton>
     <RareButton type="submit" tone="danger" emphasis="solid" loading={deleteBusy} disabled={(deleteNeedsPassword&&!deletePassword)||!deleteIds.length}>
      确认删除
     </RareButton>
    </div>
   </form>
  </Dialog>
 </div>;
}
