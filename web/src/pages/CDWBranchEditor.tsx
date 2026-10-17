import {useCallback,useEffect,useRef,useState} from "react";
import {useNavigate,useParams} from "react-router-dom";
import {RareButton,RareBadge,RareNotice} from "../shared/ui/rare";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {toast} from "../shared/ui/feedback";
import {errorCopy} from "../shared/errors";
import {newIdempotencyKey} from "../shared/ids";
import {ApiError} from "../shared/http";
import {warmOfficeEditor} from "../features/documents/officeBootstrap";
import {cdwApi,type CDWBranch,type CDWOfficeSession,type CDWSave} from "../features/cdw/api";
import "./officeEditor.css";
import "./cdwWorkbench.css";

type EditorState="loading"|"ready"|"failed";
type DocEditorInstance={destroyEditor?:()=>void};
export function CDWBranchEditor(){
 const{id=""}=useParams();
 const navigate=useNavigate();
 const holder=useRef<HTMLDivElement>(null);
 const editor=useRef<DocEditorInstance|null>(null);
 const dirty=useRef(false);
 const submissionInFlight=useRef(false);
 const requestKey=useRef("");
 const freezeKey=useRef("");
 const[office,setOffice]=useState<CDWOfficeSession|null>(null);
 const[branch,setBranch]=useState<CDWBranch|null>(null);
 const[loadState,setLoadState]=useState<EditorState>("loading");
 const[error,setError]=useState("");
 const[changed,setChanged]=useState(false);
 const[save,setSave]=useState<CDWSave|null>(null);
 const[finalizing,setFinalizing]=useState(false);
 const[leaseExpired,setLeaseExpired]=useState(false);
 const[polling,setPolling]=useState(false);
 const[fileName,setFileName]=useState("工作分支文档");
 const returnPath="/workbench";
 useEffect(()=>{
  let live=true;let timer:number|undefined;
  setLoadState("loading");setError("");
  const script=warmOfficeEditor();
  void script?.catch(()=>undefined);
  void cdwApi.openOffice(id).then(async config=>{
   if(!live)return;
   setOffice(config);setBranch(config.branch);
   setFileName(String((config.config.document as {title?:string}|undefined)?.title??"工作分支文档"));
   await (script??warmOfficeEditor(config.editorUrl));
   if(!live||!holder.current||!window.DocsAPI?.DocEditor)throw Error("ONLYOFFICE 未能加载编辑器");
   const events={
    onDocumentReady:()=>{if(live){window.clearTimeout(timer);setLoadState("ready");}},
    onDocumentStateChange:(event:{data?:boolean})=>{
     if(!live||event.data!==true)return;
     dirty.current=true;setChanged(true);
     setSave(null);requestKey.current="";
    },
    onError:(event:{data?:{errorDescription?:string}})=>{
     if(!live)return;
     setError(event.data?.errorDescription??"编辑服务发生错误");
     setLoadState("failed");
    }
   };
   editor.current=new window.DocsAPI.DocEditor("cdw-doc-editor",{...config.config,events});
   timer=window.setTimeout(()=>{if(live)setLoadState(v=>v==="ready"?v:"failed");},45000);
  }).catch(reason=>{if(live){setError(errorCopy(reason,"无法打开任务工作分支"));setLoadState("failed");}});
  return()=>{live=false;window.clearTimeout(timer);editor.current?.destroyEditor?.();editor.current=null;};
 },[id]);
 // Extend the exclusive edit lease while this view is in use. A static
 // 30-minute lease would lose all saves from a long-running editing session.
 useEffect(()=>{
  if(!office?.session.sessionId)return;
  let live=true,working=false;
  const renew=async()=>{
   if(working||!live)return;
   working=true;
   try{await cdwApi.touchOffice(id,office.session.sessionId);}
   catch(reason){
    if(live){setError(errorCopy(reason,"编辑会话续约失败，请检查连接"));
      if(reason instanceof ApiError && [401,403,409].includes(reason.httpStatus))setLeaseExpired(true);
    }
   }finally{working=false;}
  };
  const onVisibility=()=>{if(document.visibilityState==="visible")void renew();};
  const timer=window.setInterval(()=>void renew(),60_000);
  document.addEventListener("visibilitychange",onVisibility);
  return()=>{live=false;window.clearInterval(timer);document.removeEventListener("visibilitychange",onVisibility);};
 },[id,office?.session.sessionId]);
 useEffect(()=>{
  const unload=(event:BeforeUnloadEvent)=>{if(dirty.current||save&&save.state!=="persisted"){event.preventDefault();event.returnValue="";}};
  window.addEventListener("beforeunload",unload);return()=>window.removeEventListener("beforeunload",unload);
 },[save]);
 useEffect(()=>{
  if(!save||save.state==="persisted"||save.state==="failed"||!office)return;
  let live=true;let active=false;
  const check=async()=>{
   if(active||!live)return;active=true;
   try{
    const next=await cdwApi.saveStatus(id,save.requestId);
    if(!live)return;
    setSave(next);
    if(next.state==="persisted"){
     const latest=await cdwApi.branch(id);
     if(!live)return;
     setBranch(latest);
     dirty.current=false;setChanged(false);
     toast.success("交付修订已保存到工作分支");
    }
   }catch(err){if(live)setError(errorCopy(err,"保存回执读取失败，请刷新核实"));}
   finally{active=false;}
  };
  void check();
  const timer=window.setInterval(()=>void check(),1600);
  return()=>{live=false;window.clearInterval(timer);};
 },[id,save?.requestId,save?.state,office]);
 const canFinalize=loadState==="ready"&&!leaseExpired&&!finalizing&&!polling&&office?.session?.sessionId;
 const requestFinalSave=useCallback(async()=>{
  if(!canFinalize||!office?.session.sessionId||submissionInFlight.current)return;
  submissionInFlight.current=true;setPolling(true);setError("");
  if(!requestKey.current)requestKey.current=newIdempotencyKey();
  try{
   const receipt=await toast.track(()=>cdwApi.requestSave(id,office.session.sessionId,requestKey.current),{
    loading:"正在请求交付校验…",success:"已请求保存，等待文档库回执",error:e=>errorCopy(e,"发起交付校验失败")
   });
   setSave(receipt);
  }catch{/* toast handles the uncertainty; same key retained for safe retry */}
  finally{submissionInFlight.current=false;setPolling(false);}
 },[canFinalize,id,office]);
 async function freeze(){
  if(!save||save.state!=="persisted"||!save.persistedRevisionId||!branch||changed||finalizing||leaseExpired)return;
  setFinalizing(true);setError("");
  if(!freezeKey.current)freezeKey.current=newIdempotencyKey();
  try{
   await toast.track(()=>cdwApi.freeze(id,branch.revision,save.requestId,save.persistedRevisionId!,freezeKey.current),{
    loading:"正在冻结交付修订…",success:"交付已冻结并送交上级验收",error:e=>errorCopy(e,"交付冻结失败")
   });
   navigate(returnPath+"?task="+encodeURIComponent(branch.taskId));
  }catch{/* retain exact freeze request key for uncertain results */}
  finally{setFinalizing(false);}
 }
 function back(){
  if((changed||save&&save.state!=="persisted")&&!window.confirm("当前修改尚未确认提交，确定离开任务编辑器吗？"))return;
  navigate(returnPath+"?task="+encodeURIComponent(branch?.taskId??""));
 }
 const readyReceipt=save?.state==="persisted"&&!changed;
 const subtitle=readyReceipt?"已收到文档库持久化回执":save?.state==="unknown"?"保存结果待确认，不可冻结":
  save&&!readyReceipt?"正在核验保存结果…":changed?"有未提交的修订":"可在 ONLYOFFICE 中编辑";
 return <div className="office-workbench cdw-editor">
  <header className="office-workbench-toolbar">
   <div className="office-workbench-identity">
    <RareButton type="button" tone="ghost" onClick={back}>← 工作台</RareButton>
    <span className="office-workbench-divider" aria-hidden="true"/>
    <strong title={fileName}>{fileName}</strong>
    <span className="office-workbench-version">独立工作分支</span>
   </div>
   <div className="cdw-editor-toolbar-right">
    <span role="status" className="cdw-editor-save-state">{subtitle}</span>
    {readyReceipt?<RareButton type="button" tone="primary" loading={finalizing} disabled={!branch||finalizing||leaseExpired}
      onClick={()=>void freeze()}>冻结并提交验收</RareButton>:
      <RareButton type="button" tone="primary" loading={polling}
       disabled={!canFinalize} onClick={()=>void requestFinalSave()}>{save?"重新核验交付":"提交交付校验"}</RareButton>}
   </div>
  </header>
  <main className="office-workbench-content">
   <div className="office-holder" ref={holder}>
    <div id="cdw-doc-editor" className="cdw-doc-canvas"/>
    {loadState==="loading"&&<div className="office-loading-cover"><BrandLoadingLabel size="sm">正在连接 ONLYOFFICE…</BrandLoadingLabel></div>}
    {loadState==="failed"&&<div className="office-loading-cover office-loading-failed" role="alert">
     <strong>无法打开工作分支</strong><span>{error||"ONLYOFFICE 加载超时"}</span>
     <RareButton type="button" onClick={()=>window.location.reload()}>重新连接</RareButton></div>}
   </div>
  </main>
  {error&&loadState==="ready"&&<div className="cdw-editor-error"><RareNotice tone="warning">{error}</RareNotice></div>}
  {readyReceipt&&<div className="cdw-editor-confirm">
   <RareBadge tone="success">持久化已确认</RareBadge>
   <span>冻结只绑定本次修订，原文件当前版本保持不变。</span>
  </div>}
 </div>;
}
