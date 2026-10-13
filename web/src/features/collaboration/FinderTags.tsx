import {useEffect,useState,type FormEvent} from "react";
import {Link,useLocation,useNavigate} from "react-router-dom";
import {RareButton,RareInput} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {errorCopy} from "../../shared/errors";
import {FINDER_COLORS,labelApi,finderColor,type FinderColor,type FinderLabel} from "../../shared/finderLabels";

type Draft={id:string;name:string;color:FinderColor;isDefault:boolean};
export function FinderTags(){
 const [labels,setLabels]=useState<FinderLabel[]>([]);
 const [state,setState]=useState<"loading"|"ready"|"error">("loading");
 const [draft,setDraft]=useState<Draft|null>(null);
 const [busy,setBusy]=useState(false);
 const location=useLocation(),navigate=useNavigate();
 const params=new URLSearchParams(location.search);
 const active=params.get("view")==="labels"?params.get("label"):null;
 useEffect(()=>{
  let live=true;
  function refresh(){labelApi.list().then(items=>{if(live){setLabels(items);setState("ready");}})
   .catch(()=>{if(live)setState("error");});}
  refresh();
  window.addEventListener("filesmanage:labels-change",refresh);
  return()=>{live=false;window.removeEventListener("filesmanage:labels-change",refresh);};
 },[]);
 function edit(label:FinderLabel){setDraft({id:label.id,name:label.name,color:label.color,isDefault:label.isDefault});}
 async function submit(event:FormEvent){
  event.preventDefault();
  if(!draft||busy)return;
  const name=draft.name.trim();
  if(!name){toast.warning("请输入标签名称");return;}
  setBusy(true);
  try{
   const label=draft.id?await labelApi.update(draft.id,name,draft.color):await labelApi.create(name,draft.color);
   setDraft(null);
   if(!draft.id)navigate("/doc?view=labels&label="+encodeURIComponent(label.id));
   toast.success(draft.id?"标签已更新":"标签已创建");
  }catch(error){toast.error(errorCopy(error,"无法保存标签"));}
  finally{setBusy(false);}
 }
 async function remove(){
  if(!draft||!draft.id||draft.isDefault||busy)return;
  setBusy(true);
  try{
   await labelApi.remove(draft.id);
   if(active===draft.id)navigate("/doc?view=labels");
   setDraft(null);toast.success("标签已删除，文件未受影响");
  }catch(error){toast.error(errorCopy(error,"删除标签失败"));}
  finally{setBusy(false);}
 }
 return <div className="finder-nav-section finder-tags-section">
  <div className="finder-nav-heading"><span className="finder-nav-label">标签</span>
   <RareButton type="button" tone="ghost" className="finder-tag-add" title="新建标签" aria-label="新建标签"
    onClick={()=>setDraft({id:"",name:"",color:"blue",isDefault:false})}>＋</RareButton>
  </div>
  {labels.map(label=><div key={label.id} className={"finder-tag-line"+(active===label.id?" is-current":"")}>
   <Link to={"/doc?view=labels&label="+encodeURIComponent(label.id)} title={label.name}
    className="finder-tag-link" onContextMenu={event=>{event.preventDefault();edit(label);}}>
    <span className="finder-tag-dot" style={{backgroundColor:finderColor(label.color)}} aria-hidden="true"/>
    <span className="finder-tag-name">{label.name}</span>
   </Link>
   <RareButton type="button" tone="ghost" className="finder-tag-more" title={"编辑标签 "+label.name}
    aria-label={"编辑标签 "+label.name} onClick={()=>edit(label)}>···</RareButton>
  </div>)}
  {state==="error"&&<RareButton type="button" className="finder-tag-retry" onClick={()=>{setState("loading");labelApi.list().then(items=>{setLabels(items);setState("ready");}).catch(()=>setState("error"));}}>重新加载标签</RareButton>}
  {state==="loading"&&<span className="finder-nav-empty">正在加载标签…</span>}
  <Link className={"finder-tag-all"+(params.get("view")==="labels"&&!active?" is-current":"")} to="/doc?view=labels">所有标签…</Link>
  {draft&&<form className="finder-tag-editor" onSubmit={submit} onKeyDown={event=>{if(event.key==="Escape")setDraft(null);}}>
   <RareInput autoFocus aria-label="标签名称" maxLength={40} value={draft.name}
    placeholder="标签名称" disabled={busy} onChange={event=>setDraft({...draft,name:event.target.value})}/>
   {!draft.isDefault&&<div className="finder-tag-palette" role="group" aria-label="标签颜色">{FINDER_COLORS.map(color=><RareButton
    type="button" tone="ghost" key={color.id} title={color.name} aria-label={color.name}
    aria-pressed={draft.color===color.id} className="finder-tag-palette-item" disabled={busy}
    onClick={()=>setDraft({...draft,color:color.id})}>
    <span style={{backgroundColor:color.hex}}/></RareButton>)}</div>}
   <div className="finder-tag-editor-actions">
    {!draft.isDefault&&draft.id&&<RareButton type="button" className="finder-tag-remove" disabled={busy} onClick={()=>void remove()}>删除</RareButton>}
    <RareButton type="button" tone="ghost" disabled={busy} onClick={()=>setDraft(null)}>取消</RareButton>
    <RareButton type="submit" className="primary" disabled={busy}>{busy?"保存中":"保存"}</RareButton>
   </div>
  </form>}
 </div>;
}
