import {useEffect,useState,type MouseEvent} from "react";
import {RareBadge,RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {sealsApi} from "./api";
import type {SealAsset,FileSealMark,SealUserPermission} from "../../entities/seal/model";
import "./seals.css";

const clamp=(value:number,max:number)=>Math.max(0,Math.min(max,value));
export function FileSealsPanel({fileId,seq,sha,name}:{fileId:string;seq:number;sha:string;name:string}){
 const[assets,setAssets]=useState<SealAsset[]>([]);
 const[access,setAccess]=useState<SealUserPermission|null>(null);
 const[marks,setMarks]=useState<FileSealMark[]>([]);
 const[usedAssetIds,setUsedAssetIds]=useState<string[]>([]);
 const[assetId,setAssetId]=useState("");
 const[page,setPage]=useState(1);
 const[position,setPosition]=useState({x:.70,y:.78,width:.22,height:.12});
 const[password,setPassword]=useState("");
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[notice,setNotice]=useState("");
 const[imageAvailable,setImageAvailable]=useState(true);
 const[revision,setRevision]=useState(0);
 const isPDF=name.toLowerCase().endsWith(".pdf");
 const selected=assets.find(a=>a.id===assetId);
 const maySign=selected?.kind==="personal"?!!access?.canSign:!!access?.canStamp;
 const duplicate=!!selected&&usedAssetIds.includes(selected.id);
 const imageUrl="/api/files/"+encodeURIComponent(fileId)+"/seals/page?"+new URLSearchParams({version:String(seq),page:String(page),sha256:sha}).toString();
 useEffect(()=>{
  let live=true;
  Promise.all([sealsApi.list(),sealsApi.marks(fileId,seq),sealsApi.myPermission(),sealsApi.used(fileId)])
   .then(([available,entries,permission,used])=>{if(!live)return;setAccess(permission);setAssets(available.filter(a=>a.active&&(a.kind==="company"||!!a.ownerId)));setMarks(entries);setUsedAssetIds(used);setAssetId(id=>available.some(a=>a.id===id&&a.active)?id:"");})
   .catch(err=>{if(live)setError(errorCopy(err,"签章资料读取失败"))});
  return()=>{live=false;};
 },[fileId,seq,revision]);
 useEffect(()=>setImageAvailable(true),[imageUrl]);
 function positionFromClick(event:MouseEvent<HTMLDivElement>){
  const rect=event.currentTarget.getBoundingClientRect();
  if(!rect.width||!rect.height)return;
  const x=(event.clientX-rect.left)/rect.width;
  const y=(event.clientY-rect.top)/rect.height;
  setPosition(p=>({...p,x:clamp(x-p.width/2,1-p.width),y:clamp(y-p.height/2,1-p.height)}));
 }
 async function sign(){
  if(!assetId||!password||!isPDF||!maySign||duplicate)return;
  setBusy(true);setError("");setNotice("");
  try{
   await sealsApi.apply(fileId,{assetId,versionSeq:seq,fileSha256:sha,password,pageNumber:page,...position});
   setRevision(n=>n+1);setNotice("签署记录已保存，已固定绑定文件版本和哈希。");
  }catch(err){setError(errorCopy(err,"签署失败，请核实密码及文件权限"))}
  finally{setPassword("");setBusy(false)}
 }
 return <div className="seal-file-workspace">
  <div className="seal-file-controls">
   <div className="seal-library-heading">签署设置</div>
   {(error||notice)&&<p role={error?"alert":"status"} className={error?"notice error":"notice"}>{error||notice}</p>}
   <label>印章 / 签名<RareSelect value={assetId} onChange={e=>setAssetId(e.target.value)}>
    <option value="">选择有权使用的签章</option>
    {assets.map(a=><option key={a.id} disabled={(a.kind==="personal"?!access?.canSign:!access?.canStamp)||usedAssetIds.includes(a.id)} value={a.id}>{a.name}{a.kind==="personal"?"（个人）":"（公章）"}</option>)}
   </RareSelect></label>
   {selected&&!maySign&&<p role="status" className="hint">当前账号没有{selected.kind==="personal"?"个人签名":"公章使用"}权限，请联系管理员授权。</p>}
   {duplicate&&<p role="status" className="hint">此文件已使用这枚签章，不能重复使用同一枚签章。</p>}
   {selected&&<div className="seal-selected-asset"><img src={sealsApi.imageUrl(selected.id)} alt={selected.name}/><span>{selected.kind==="personal"?"个人签名":"公章授权"} · {selected.name}</span></div>}
   <label>页码<RareInput type="number" min={1} max={1000} value={page} onChange={e=>setPage(clamp(Number(e.target.value)||1,1000))}/></label>
   <div className="seal-size-controls">
    <label>宽度 %<RareInput type="number" min={5} max={100} step={1} value={Math.round(position.width*100)}
     onChange={e=>setPosition(p=>({...p,width:clamp((Number(e.target.value)||5)/100,1-p.x)}))}/></label>
    <label>高度 %<RareInput type="number" min={5} max={100} step={1} value={Math.round(position.height*100)}
     onChange={e=>setPosition(p=>({...p,height:clamp((Number(e.target.value)||5)/100,1-p.y)}))}/></label>
   </div>
   <label>确认本人登录密码<RareInput type="password" autoComplete="new-password" value={password}
    placeholder="每次签署都必须重新输入" onChange={e=>setPassword(e.target.value)}/></label>
   <RareButton className="primary" disabled={busy||!isPDF||!assetId||!password||!imageAvailable||!maySign||duplicate} onClick={()=>void sign()}>
    {busy?"正在签署…":"确认签署"}
   </RareButton>
   {!isPDF&&<p className="hint">此阶段仅允许在 PDF 页面进行可定位签章；Office 文件请先生成并审核 PDF 副本。</p>}
   <p className="hint">签署留痕固定到当前版本，原 PDF 不变；盖章版可单独下载。此为可见印章，非数字证书签名。</p>
   {marks.length>0&&<a className="rare-button" href={sealsApi.exportUrl(fileId,seq)} download={"签章版-v"+seq+".pdf"}>下载带章 PDF</a>}
  </div>
  <div className="seal-file-preview">
   <div className="seal-library-heading">页面定位 <span>点击页面放置签章</span></div>
   {isPDF?<>
    {imageAvailable?<div className="seal-page-surface" onClick={positionFromClick} role="button" tabIndex={0} aria-label="签章位置预览，可点击定位" onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setPosition(v=>({...v,x:.7,y:.78}));}}}>
      <img src={imageUrl} alt={"PDF 第 "+page+" 页定位图"} onError={()=>setImageAvailable(false)}/>
      {selected&&<span className="seal-position-mark" style={{left:position.x*100+"%",top:position.y*100+"%",width:position.width*100+"%",height:position.height*100+"%"}}>
       <img alt="" src={sealsApi.imageUrl(selected.id)}/>
      </span>}
      {marks.filter(m=>m.pageNumber===page).map(m=><span key={m.id} className="seal-existing-mark" style={{left:m.x*100+"%",top:m.y*100+"%",width:m.width*100+"%",height:m.height*100+"%"}}>
       <img alt={m.assetName} src={sealsApi.markImageUrl(fileId,m.id)}/></span>)}
     </div>:<div className="empty">页面图无法加载。请检查 PDF 预览和打印权限。</div>}
   </>:<div className="empty">仅 PDF 支持页面定位</div>}
  </div>
  <aside className="seal-file-history">
   <div className="seal-library-heading">签署记录 <span>{marks.length}</span></div>
   {marks.length===0&&<p className="empty">此版本尚无签章</p>}
   {marks.map(m=><div key={m.id} className="seal-history-row"><div><strong>{m.assetName}</strong><RareBadge tone="neutral">第 {m.pageNumber} 页</RareBadge></div>
    <small>{m.signerName} · {new Date(m.createdAt).toLocaleString("zh-CN")}</small>
    <small>v{m.versionSeq} · SHA {m.fileSha256.slice(0,12)}…</small>
   </div>)}
  </aside>
 </div>;
}
