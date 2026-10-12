import {useEffect,useState} from "react";
import {RareBadge,RareButton,RareInput,RareSelect,RareTabs} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {Dialog} from "../../shared/ui/Dialog";
import {toast} from "../../shared/ui/feedback";
import {sealsApi} from "./api";
import {SealPermissionMatrix} from "./SealPermissionMatrix";
import type {SealAsset} from "../../entities/seal/model";
import "./seals.css";
import "./sealLibraryWorkbench.css";

async function pngToBase64(file:File){
 if(file.type!=="image/png"||file.size>1048576||file.size<30)throw Error("请选择 1 MB 以内的 PNG 图片");
 return new Promise<string>((resolve,reject)=>{
  const reader=new FileReader();
  reader.onerror=()=>reject(new Error("图片读取失败"));
  reader.onload=()=>resolve(String(reader.result).split(",")[1]??"");
  reader.readAsDataURL(file);
 });
}

export function SealLibrary({isAdmin}:{isAdmin:boolean}){
 const[screen,setScreen]=useState<"library"|"permissions">("library");
 const[renameValue,setRenameValue]=useState("");
 const[items,setItems]=useState<SealAsset[]>([]);
 const[people,setPeople]=useState<{id:string;displayName:string}[]>([]);
 const[selected,setSelected]=useState("");
 const[kind,setKind]=useState<"personal"|"company">("personal");
 const[name,setName]=useState("");
 const[owner,setOwner]=useState("");
 const[userId,setUserId]=useState("");
 const[file,setFile]=useState<File|null>(null);
 const[bundle,setBundle]=useState<File|null>(null);
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[importOpen,setImportOpen]=useState(false);
 const[bundleOpen,setBundleOpen]=useState(false);
 const[confirmRetire,setConfirmRetire]=useState(false);
 const[revision,setRevision]=useState(0);
 useEffect(()=>{
  let live=true;sealsApi.list().then(v=>{if(live){setItems(v);setSelected(current=>v.some(item=>item.id===current)?current:(v[0]?.id??""));}}).catch(err=>{if(live)setError(errorCopy(err,"签章列表加载失败"));});
  if(isAdmin){sealsApi.permissions().then(list=>{if(live)setPeople(list.map(u=>({id:u.userId,displayName:u.displayName})));}).catch(err=>{if(live)setError(errorCopy(err,"人员名单读取失败"));});}
  return()=>{live=false;};
 },[isAdmin,revision]);
 const active=items.find(x=>x.id===selected);
 async function perform(action:"bind"|"grant"|"revoke"|"retire"|"rename"){
  if(!active||busy)return;
  setBusy(true);setError("");
  try{
   await sealsApi.configure(active.id,action,action==="retire"?"":action==="rename"?renameValue:userId);
   setRevision(i=>i+1);setConfirmRetire(false);setRenameValue("");setUserId("");
   toast.success(action==="retire"?"签章已停用":"签章设置已保存");
  }catch(err){setError(errorCopy(err,"操作失败"))}finally{setBusy(false);}
 }

 async function importBundle(){
  if(!bundle||busy)return;
  setBusy(true);setError("");
  try{
   const result=await sealsApi.importBundle(bundle);
   setBundle(null);setBundleOpen(false);setRevision(x=>x+1);
   toast.success("导入完成："+result.created+" 份新增，"+result.existing+" 份已存在");
  }catch(err){setError(errorCopy(err,"批量导入失败，未确认导入结果"));}finally{setBusy(false);}
 }
 async function create(){
  if(!file||!name.trim())return;
  setBusy(true);setError("");
  try{
   const pngBase64=await pngToBase64(file);
   const a=await sealsApi.create({kind:isAdmin?kind:"personal",name:name.trim(),ownerId:isAdmin&&kind==="personal"?owner:"",pngBase64});
   setRevision(i=>i+1);setSelected(a.id);setName("");setFile(null);setImportOpen(false);toast.success("签章已导入");
  }catch(err){setError(errorCopy(err,"图片导入失败"))}finally{setBusy(false)}
 }
 return <div className="seal-library-container">
  {isAdmin&&<RareTabs className="seal-management-tabs" label="签章管理视图"><RareButton type="button" role="tab" aria-selected={screen==="library"} onClick={()=>setScreen("library")}>签章素材</RareButton><RareButton type="button" role="tab" aria-selected={screen==="permissions"} onClick={()=>setScreen("permissions")}>人员权限</RareButton></RareTabs>}
  {screen==="permissions"&&isAdmin?<SealPermissionMatrix/>:<div className="seal-library">
  <aside className="seal-library-list">
   <div className="seal-library-heading">签章库 <span>{items.length}</span></div>
   {items.length===0&&<p className="empty">暂无可用签章</p>}
   {items.map(a=><RareButton key={a.id} type="button" className={"seal-library-item"+(a.id===selected?" is-selected":"")} onClick={()=>setSelected(a.id)}>
    <span>{a.name}</span><small>{a.kind==="personal"?(a.ownerName||"待绑定"): "公司印章"}</small>
    {!a.active&&<RareBadge tone="neutral">停用</RareBadge>}
   </RareButton>)}
  </aside>
  <section className="seal-library-main">
   <div className="seal-library-toolbar"><strong>签章详情</strong><div className="seal-library-toolbar-actions">
    {isAdmin&&<RareButton type="button" onClick={()=>{setError("");setBundleOpen(true);}}>批量导入</RareButton>}
    <RareButton type="button" tone="primary" onClick={()=>{setError("");setImportOpen(true);}}>{isAdmin?"导入签章":"上传签名"}</RareButton>
   </div></div>
   {error&&<p role="alert" className="seal-library-error">{error}<RareButton type="button" onClick={()=>setError("")}>关闭</RareButton></p>}
   {active?<div className="seal-library-detail">
    <div className="seal-library-title"><h3>{active.name}</h3><RareBadge tone={active.active?"success":"neutral"}>{active.active?"可用":"已停用"}</RareBadge></div>
    <div className="seal-library-image"><img src={sealsApi.imageUrl(active.id)} alt={active.name}/></div>
    <div className="seal-library-meta"><span>类别：{active.kind==="personal"?"个人签名":"公司印章"}</span><span>归属：{active.kind==="personal"?(active.ownerName||"未认领"):"公司"}</span></div>
    {isAdmin&&active.kind==="company"&&<div className="seal-library-meta">已授权：{(active.grantedUserIds??[]).map(id=>people.find(u=>u.id===id)?.displayName??id).join("、")||"暂无（仅管理员可使用）"}</div>}
    {active.active&&(isAdmin||active.kind==="personal")&&<div className="seal-library-manage">
     {(active.kind==="company"||!active.ownerId)&&<label>人员
      <RareSelect value={userId} onChange={e=>setUserId(e.target.value)}>
       <option value="">选择用户</option>
       {people.map(u=><option value={u.id} key={u.id}>{u.displayName}</option>)}
      </RareSelect>
     </label>}
     {active.kind==="personal"&&!active.ownerId&&<RareButton disabled={busy||!userId} onClick={()=>void perform("bind")}>确认绑定本人</RareButton>}
     {active.kind==="company"&&<><RareButton disabled={busy||!userId} onClick={()=>void perform("grant")}>授权使用</RareButton>
      <RareButton disabled={busy||!userId} onClick={()=>void perform("revoke")}>撤销授权</RareButton></>}
     {active.kind==="personal"&&<label>名称<RareInput value={renameValue} maxLength={100} placeholder={active.name} onChange={e=>setRenameValue(e.target.value)}/></label>}
     {active.kind==="personal"&&<RareButton disabled={busy||!renameValue.trim()} onClick={()=>void perform("rename")}>重命名</RareButton>}
     <RareButton tone="danger" disabled={busy} onClick={()=>{setError("");setConfirmRetire(true);}}>停用{active.kind==="personal"?"签名":"印章"}</RareButton>
    </div>}
   </div>:<div className="empty">选择签章查看</div>}
  </section>
 </div>}
  <Dialog open={importOpen} title={isAdmin?"导入签章素材":"上传个人签名"}
   className="seal-library-dialog" closeGuard={()=>!busy} onClose={()=>{if(!busy){setImportOpen(false);setFile(null);setName("");setError("");}}}>
   <div className="seal-library-dialog-fields">
    {isAdmin&&<label>类型<RareSelect value={kind} onChange={e=>{setKind(e.target.value as "personal"|"company");setOwner("");}}>
     <option value="personal">个人签名</option><option value="company">公司印章</option>
    </RareSelect></label>}
    <label>名称<RareInput value={name} maxLength={100} placeholder="签章名称" onChange={e=>setName(e.target.value)}/></label>
    {isAdmin&&kind==="personal"&&<label>归属<RareSelect value={owner} onChange={e=>setOwner(e.target.value)}>
     <option value="">暂不绑定</option>{people.map(u=><option value={u.id} key={u.id}>{u.displayName}</option>)}
    </RareSelect></label>}
    <label>PNG 图片<RareInput type="file" accept="image/png" onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
   </div>
   {error&&<p role="alert" className="seal-library-dialog-error">{error}</p>}
   <div className="dialog-actions"><RareButton type="button" disabled={busy} onClick={()=>{setImportOpen(false);setError("");}}>取消</RareButton>
    <RareButton type="button" tone="primary" loading={busy} disabled={!file||!name.trim()} onClick={()=>void create()}>确认导入</RareButton></div>
  </Dialog>
  {isAdmin&&<Dialog open={bundleOpen} title="批量导入签章"
   className="seal-library-dialog" closeGuard={()=>!busy} onClose={()=>{if(!busy){setBundleOpen(false);setBundle(null);setError("");}}}>
   <div className="seal-library-dialog-fields"><label>签章 ZIP 包<RareInput type="file" accept=".zip,application/zip"
    onChange={e=>setBundle(e.target.files?.[0]??null)}/></label></div>
   {error&&<p role="alert" className="seal-library-dialog-error">{error}</p>}
   <div className="dialog-actions"><RareButton type="button" disabled={busy} onClick={()=>{setBundleOpen(false);setError("");}}>取消</RareButton>
    <RareButton type="button" tone="primary" loading={busy} disabled={!bundle} onClick={()=>void importBundle()}>导入并绑定</RareButton></div>
  </Dialog>}
  {active&&<Dialog open={confirmRetire} title="停用签章"
   className="seal-library-dialog" closeGuard={()=>!busy} onClose={()=>{if(!busy){setConfirmRetire(false);setError("");}}}>
   <p className="seal-library-retire-note">{active.name} 停用后将不可用于新签署，历史记录保留。</p>
   {error&&<p role="alert" className="seal-library-dialog-error">{error}</p>}
   <div className="dialog-actions"><RareButton type="button" disabled={busy} onClick={()=>setConfirmRetire(false)}>取消</RareButton>
    <RareButton type="button" tone="danger" loading={busy} onClick={()=>void perform("retire")}>确认停用</RareButton></div>
  </Dialog>}
 </div>;
}
