import {useEffect,useLayoutEffect,useState} from "react";
import {fileApi} from "../documents/api";
import {createPortal} from "react-dom";
import {Link} from "react-router-dom";
import {RareBadge,RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {toast} from "../../shared/ui/feedback";
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
 const[page,setPage]=useState(1);
 const[pageCount,setPageCount]=useState(0);
 const[imageRetry,setImageRetry]=useState(0);
 const[position,setPosition]=useState<Position>({x:.70,y:.78,width:.22,height:.12});
 const[angle,setAngle]=useState(0);
 const[pageRatio,setPageRatio]=useState(1.414);
 const[staged,setStaged]=useState<DraftSeal[]>([]);
 const[password,setPassword]=useState("");
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[imageAvailable,setImageAvailable]=useState(true);
 const[revision,setRevision]=useState(0);
 const isPDF=name.toLowerCase().endsWith(".pdf");
 const selected=assets.find(a=>a.id===assetId);
 const maySign=!!selected&&(selected.kind!=="personal"||!!selected.ownerId)&&
  (isAdmin||(selected.kind==="personal"?!!access?.canSign:!!access?.canStamp));
 const duplicate=!!selected&&(usedAssetIds.includes(selected.id)||staged.some(s=>s.assetId!==selected.id&&assets.some(a=>a.id===s.assetId&&a.sha256===selected.sha256)));
 const rotationFits=stampFitsPage(position,angle,pageRatio);
 const imageUrl="/api/files/"+encodeURIComponent(fileId)+"/seals/page?"+
  new URLSearchParams({version:String(seq),page:String(page),sha256:sha,retry:String(imageRetry)}).toString();

 useEffect(()=>{
  let live=true;
  setStaged([]);setAssetId("");setPassword("");
  Promise.all([sealsApi.list(),sealsApi.marks(fileId,seq),sealsApi.myPermission(),sealsApi.used(fileId)])
   .then(([available,entries,permission,used])=>{
    if(!live)return;
    setAccess(permission);
    setAssets(available.filter(a=>a.active&&(isAdmin||a.kind==="company"||!!a.ownerId)));
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
  void fileApi.pdfPages(fileId,sha).then(result=>{
   if(live)setPageCount(Math.max(0,result.pageCount));
  }).catch(err=>{if(live)setError(errorCopy(err,"无法获取 PDF 页数"))});
  return()=>{live=false};
 },[fileId,sha,isPDF]);

 function updatePosition(updater:(value:Position)=>Position){
  const next=updater(position);
  setPosition(next);
  if(assetId)setStaged(list=>list.map(item=>item.assetId===assetId?{...item,...next,pageNumber:page}:item));
 }
 function changeAngle(value:number){
  const next=Math.max(-180,Math.min(180,Math.round(Number.isFinite(value)?value:0)));
  const moved=fitStampToPage(position,next,pageRatio);
  setAngle(next);setPosition(moved);
  setStaged(list=>list.map(item=>item.assetId===assetId?{...item,...moved,angleDegrees:next}:item));
 }
 function changeSize(update:Partial<Position>){
  const next=fitStampToPage({...position,...update},angle,pageRatio);
  setPosition(next);
  if(assetId)setStaged(list=>list.map(item=>item.assetId===assetId?{...item,...next}:item));
 }
 function changePage(next:number){
  setPage(Math.max(1,Math.min(pageCount||1,next)));
 }
 function pickAsset(id:string){
  setAssetId(id);
  const existing=staged.find(item=>item.assetId===id);
  if(existing){
   setPage(existing.pageNumber);
   setPosition({x:existing.x,y:existing.y,width:existing.width,height:existing.height});
   setAngle(existing.angleDegrees);
  }else if(id){
   // New signatures get distinct initial positions; each one is independently editable.
   const offset=(staged.length%4)*.13;
   setPosition({x:.20+offset,y:.18+(staged.length%3)*.10,width:.22,height:.12});setAngle(0);
  }
 }
 function addDraft(){
  if(!selected||!maySign||duplicate||!isPDF||!pageCount||!rotationFits||!imageAvailable||busy||(!staged.some(item=>item.assetId===selected.id)&&staged.length>=20))return;
  const item:DraftSeal={assetId:selected.id,pageNumber:page,...position,angleDegrees:angle};
  setStaged(list=>list.some(s=>s.assetId===item.assetId)?list.map(s=>s.assetId===item.assetId?item:s):[...list,item]);
  toast.info("已加入待签清单");setError("");
 }
 function removeDraft(id:string){
  setStaged(list=>list.filter(item=>item.assetId!==id));
  if(assetId===id)setAssetId("");
 }
 async function sign(){
  if(!password||!isPDF||busy||!pageCount||!staged.length||!imageAvailable)return;
  setBusy(true);setError("");
  try{
   const marks=await sealsApi.applyBatch(fileId,{versionSeq:seq,fileSha256:sha,password,placements:staged});
   setStaged([]);setAssetId("");setRevision(n=>n+1);onChanged();
   toast.success("已保存 "+marks.length+" 枚签章");
  }catch(err){setError(errorCopy(err,"批量签署失败；本批次不会部分保存，请核实权限、密码及位置"))}
  finally{setPassword("");setBusy(false)}
 }
 const controls = <div className="seal-file-controls">
   {error&&<p role="alert" className="notice error">{error}</p>}
   <label>选择签名 / 印章
    <RareSelect value={assetId} onChange={e=>pickAsset(e.target.value)}>
     <option value="">选择人员或公章</option>
     {assets.map(a=><option key={a.id} value={a.id}
      disabled={(a.kind==="personal"&&!a.ownerId)||(!isAdmin&&(a.kind==="personal"?!access?.canSign:!access?.canStamp))||usedAssetIds.includes(a.id)||
       staged.some(s=>s.assetId!==a.id&&assets.some(b=>b.id===s.assetId&&b.sha256===a.sha256))}>
      {a.kind==="personal"?(a.ownerName||"待绑定")+" · "+a.name:"公章 · "+a.name}
     </option>)}
    </RareSelect>
   </label>
   {assets.length===0&&<p className="seal-asset-empty" role="status">尚无可用签章。<Link to="/approvals?tab=seals">去签章管理导入</Link></p>}
   {selected&&!maySign&&<p role="status" className="hint">当前账号没有此签名／印章使用权限，或尚未绑定归属人。</p>}
   {duplicate&&<p role="status" className="hint">当前文件或待签清单已使用同一枚签章。</p>}
   {selected&&<div className="seal-selected-asset">
    <img src={sealsApi.imageUrl(selected.id)} alt={selected.name}/>
    <span>{selected.kind==="personal"?(selected.ownerName||"未绑定")+"的签名":"公司印章"} · {selected.name}</span>
   </div>}
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
   <RareButton type="button" disabled={busy||!selected||!maySign||duplicate||!rotationFits||!imageAvailable||!isPDF||!pageCount||(!staged.some(s=>s.assetId===assetId)&&staged.length>=20)} onClick={addDraft}>
    {staged.some(s=>s.assetId===assetId)?"更新当前签章位置":"＋ 加入待签清单"}
   </RareButton>
   <div className="seal-draft-heading">待签清单 <RareBadge tone="neutral">{staged.length}/20</RareBadge></div>
   <div className="seal-draft-list" aria-label="本次待签人员和印章">
    {staged.length===0&&<span className="seal-draft-empty">选择一枚签章并定位，可依次加入多位人员。</span>}
    {staged.map((item,i)=>{
     const a=assets.find(x=>x.id===item.assetId);
     return <div className={"seal-draft-row"+(assetId===item.assetId?" is-active":"")} key={item.assetId}>
      <RareButton type="button" aria-pressed={assetId===item.assetId} onClick={()=>pickAsset(item.assetId)}>
       <span className="seal-draft-index">{i+1}</span>
       <span className="seal-draft-label">{a?.ownerName||a?.name||"签章"}<small>第 {item.pageNumber} 页 · {item.angleDegrees}°</small></span>
      </RareButton>
      <RareButton type="button" aria-label={"移除"+(a?.name||"签章")} disabled={busy} onClick={()=>removeDraft(item.assetId)}>×</RareButton>
     </div>;
    })}
   </div>
   <label>本人登录密码<RareInput type="password" autoComplete="new-password" value={password}
    placeholder="整批提交前输入" onChange={e=>setPassword(e.target.value)}/></label>
   <RareButton className="primary" disabled={busy||!isPDF||!pageCount||!staged.length||!password||!imageAvailable} onClick={()=>void sign()}>
    {busy?"正在签署…":"确认全部签署（"+staged.length+"）"}
   </RareButton>
   {!isPDF&&<p className="hint">Office 文件需先生成 PDF 副本再签署。</p>}
  </div>;
 const history = <aside className="seal-file-history">
   <SealRevisionControls fileId={fileId} seq={seq} sha={sha} isAdmin={isAdmin}
    refreshKey={revision} onSelect={onSelectRevision} onRestored={()=>{
     setStaged([]);setAssetId("");setRevision(n=>n+1);onChanged();
    }}/>

   <div className="seal-library-heading">签署记录 <span>{marks.length}</span></div>
   {marks.length===0&&<p className="empty">此版本尚无签章</p>}
   {marks.map(m=><div key={m.id} className="seal-history-row">
    <div><strong>{m.assetName}</strong><RareBadge tone="neutral">第 {m.pageNumber} 页</RareBadge></div>
    <small>{m.signerName} · {new Date(m.createdAt).toLocaleString("zh-CN")}</small>
    <small>v{m.versionSeq} · {m.angleDegrees?m.angleDegrees+"° · ":""}SHA {m.fileSha256.slice(0,12)}…</small>
   </div>)}
  </aside>;
 return <div className={"seal-file-workspace"+(controlsTargetId?" is-workbench":"")}>
  {controlsTargetId&&host?createPortal(<div className="file-seal-sidebar-controls">{controls}{history}</div>,host):<>{controls}{history}</>}
  {isPDF?<SealPageCanvas fileId={fileId} page={page} imageUrl={imageUrl} selected={selected} marks={marks}
   position={position} setPosition={updatePosition} angle={angle} pageRatio={pageRatio} setPageRatio={setPageRatio}
   pageCount={pageCount} onPageChange={changePage} onRetry={()=>setImageRetry(n=>n+1)}
   imageAvailable={imageAvailable} setImageAvailable={setImageAvailable}
   drafts={staged.map(item=>({...item,asset:assets.find(a=>a.id===item.assetId)}))}/>:
   <div className="seal-file-preview"><p className="empty">仅 PDF 支持页面定位</p></div>}
 </div>;
}
