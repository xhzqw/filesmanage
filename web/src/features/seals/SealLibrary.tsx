import {useEffect,useState} from "react";
import {RareBadge,RareButton,RareInput,RareSelect,RareTabs} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {sealsApi} from "./api";
import {SealPermissionMatrix} from "./SealPermissionMatrix";
import type {SealAsset} from "../../entities/seal/model";
import "./seals.css";

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
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 const[status,setStatus]=useState("");
 const[revision,setRevision]=useState(0);
 useEffect(()=>{
  let live=true;sealsApi.list().then(v=>{if(live){setItems(v);setSelected(current=>v.some(item=>item.id===current)?current:(v[0]?.id??""));}}).catch(err=>{if(live)setError(errorCopy(err,"签章列表加载失败"));});
  if(isAdmin){sealsApi.permissions().then(list=>{if(live)setPeople(list.map(u=>({id:u.userId,displayName:u.displayName})));}).catch(err=>{if(live)setError(errorCopy(err,"人员名单读取失败"));});}
  return()=>{live=false;};
 },[isAdmin,revision]);
 const active=items.find(x=>x.id===selected);
 async function perform(action:"bind"|"grant"|"revoke"|"retire"|"rename"){
  if(!active)return;
  if(action==="retire"&&!window.confirm("停用后不能再用于新签署，历史签章记录仍然保留。是否继续？"))return;
  setBusy(true);setError("");setStatus("");
  try{await sealsApi.configure(active.id,action,action==="retire"?"":action==="rename"?renameValue:userId);setRevision(i=>i+1);setStatus("已保存");}
  catch(err){setError(errorCopy(err,"操作失败"))}finally{setBusy(false);}
 }
 async function create(){
  if(!file||!name.trim())return;
  setBusy(true);setError("");setStatus("");
  try{
   const pngBase64=await pngToBase64(file);
   const a=await sealsApi.create({kind:isAdmin?kind:"personal",name:name.trim(),ownerId:isAdmin&&kind==="personal"?owner:"",pngBase64});
   setRevision(i=>i+1);setSelected(a.id);setName("");setFile(null);setStatus("已导入，签名使用权限按账号限制");
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
   {(error||status)&&<p role={error?"alert":"status"} className={error?"notice error":"notice"}>{error||status}</p>}
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
     <RareButton disabled={busy} onClick={()=>void perform("retire")}>停用{active.kind==="personal"?"签名":"印章"}</RareButton>
    </div>}
   </div>:<div className="empty">选择签章查看</div>}
   <div className="seal-library-create">
    <h3>{isAdmin?"导入签章素材":"上传我的个人签名"}</h3>
    <div className="seal-library-form">
     {isAdmin&&<label>类型<RareSelect value={kind} onChange={e=>{setKind(e.target.value as "personal"|"company");setOwner("");}}>
      <option value="personal">个人签名</option><option value="company">公司印章</option>
     </RareSelect></label>}
     <label>名称<RareInput value={name} maxLength={100} onChange={e=>setName(e.target.value)} placeholder="如：刘志文签名 / 合同专用章"/></label>
     {isAdmin&&kind==="personal"&&<label>归属（可稍后绑定）<RareSelect value={owner} onChange={e=>setOwner(e.target.value)}>
      <option value="">待确认归属</option>{people.map(u=><option value={u.id} key={u.id}>{u.displayName}</option>)}
     </RareSelect></label>}
     <label>PNG 图片<RareInput type="file" accept="image/png" onChange={e=>setFile(e.target.files?.[0]??null)}/></label>
     <RareButton className="primary" disabled={busy||!name.trim()||!file} onClick={()=>void create()}>{busy?"处理中…":"导入素材"}</RareButton>
    </div>
   </div>
  </section>
 </div>}
 </div>;
}
