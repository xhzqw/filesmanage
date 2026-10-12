import {RareBadge,RareButton,MicroHoldToDelete} from "../shared/ui/rare";
import {toast} from "../shared/ui/feedback";
import {BrandLoadingLabel} from "../shared/ui/BrandLoader";
import {useEffect,useRef,useState} from "react";
import {Link,useNavigate,useParams} from "react-router-dom";
import {fileApi,formatSize,type FileLifecycle} from "../features/documents/api";
import {reuseVerifiedPreview} from "../features/documents/revalidate";
import {MediaPreview} from "../features/documents/MediaPreview";
import {StructuredFilePreview} from "../features/documents/StructuredFilePreview";
import {OfficeLayoutPreview} from "../features/documents/OfficeLayoutPreview";
import {PDFPageViewer} from "../features/documents/PDFPageViewer";
import {DocxSealConversion} from "../features/documents/DocxSealConversion";
import {CadPreviewStatus} from "../features/documents/CadPreviewStatus";
import {resolvePreviewAdapter} from "../features/documents/previewAdapters";
import {FileEditor} from "../features/documents/FileEditor";
import {FileMetadataEditor} from "../features/documents/FileMetadataEditor";
import {VersionComparePanel} from "../features/documents/VersionComparePanel";
import {FileHistoryPanel} from "../features/documents/FileHistoryPanel";
import {FileSealsPanel} from "../features/seals/FileSealsPanel";
import {FileReviewPanel} from "../features/documents/FileReviewPanel";
import {PrintDialog} from "../features/documents/PrintDialog";
import {MoveDialog} from "../features/documents/FileTable";
import {FileRenameDialog} from "../features/documents/FileRenameDialog";
import {RollbackDialog} from "../features/documents/RollbackDialog";
import {ShareDialog} from "../features/collaboration/ShareDialog";
import {workflowApi} from "../features/workflow/api";
import {request} from "../shared/http";
import {errorCopy} from "../shared/errors";
import {observeResourceChange,observeWindowReturn,observeWorkspaceChange} from "../shared/resourceSync";
import {Dialog} from "../shared/ui/Dialog";
import {Menu,type MenuItem} from "../shared/ui/Menu";
import type {PreviewData,FileVersion,FileItem} from "../entities/file/model";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import "./previewWorkbench.css";
import "./previewWorkbenchV2.css";

type Tab="preview"|"details"|"versions"|"compare"|"review"|"seals";
const ACTION_LABELS:Record<string,string>={upload:"上传",edit:"编辑",rollback:"回滚",restore:"恢复"};
const CAD_EXTENSIONS=[".stl",".obj",".glb",".gltf",".step",".stp",".iges",".igs",".dxf",".dwg",".3mf",".ply"];
function isCadName(name:string){return CAD_EXTENSIONS.some(ext=>name.toLowerCase().endsWith(ext));}
function isOfficeName(name:string){return name.toLowerCase().endsWith(".docx");}
function fileExtension(name:string){const pos=name.lastIndexOf(".");return pos>=0?name.slice(pos+1).toUpperCase():"文件";}
function versionTime(value:string){return value.replace("T"," ").slice(0,16);}
function bytesUrl(id:string){return "/api/files/"+encodeURIComponent(id)+"/bytes";}

// Workbench operations reuse the list editor, preflight move and append-only
// rollback flows rather than creating divergent business rules.
export function Preview({user,onLogout}:{user:User;onLogout:()=>void}){
 const{id=""}=useParams();
 const navigate=useNavigate();
 const[preview,setPreview]=useState<PreviewData|null>(null);
 const[file,setFile]=useState<FileItem|null>(null);
 const[versions,setVersions]=useState<FileVersion[]>([]);
 const[status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const[focusMode,setFocusMode]=useState(false);
 const[historyView,setHistoryView]=useState<"activity"|"versions">("activity");
 const[tab,setTab]=useState<Tab>(()=>new URLSearchParams(window.location.search).get("tab")==="seals"?"seals":"preview");
 const[sealRevision,setSealRevision]=useState<number|null>(null);
 useEffect(()=>{setSealRevision(null)},[id,preview?.sha256,file?.currentVersionSeq]);

 const[notice,setNotice]=useState("");
 const[error,setError]=useState("");
 const[rollback,setRollback]=useState<FileVersion|null>(null);
 const[editing,setEditing]=useState(false);
 const[sharing,setSharing]=useState(false);
 const[printing,setPrinting]=useState(()=>new URLSearchParams(window.location.search).get("print")==="1");
 const[moving,setMoving]=useState(false);
 const[renaming,setRenaming]=useState(false);
 const[deleting,setDeleting]=useState(false);
 const[busy,setBusy]=useState(false);
 const[moreOpen,setMoreOpen]=useState(false);
 const moreRef=useRef<HTMLButtonElement>(null);
 const[requiresApproval,setRequiresApproval]=useState<boolean|null>(null);
 const[favorite,setFavorite]=useState<boolean|null>(null);
 const[favoriteBusy,setFavoriteBusy]=useState(false);
 const[wrapText,setWrapText]=useState(true);
 const[reloadToken,setReloadToken]=useState(0);
 const loadedPreviewId=useRef("");
 const[lifecycle,setLifecycle]=useState<FileLifecycle|null>(null);
 const archived=lifecycle?.state==="archived";
 const currentSeq=Math.max(file?.currentVersionSeq??1,...versions.map(v=>v.versionSeq));
 const adapter=preview?resolvePreviewAdapter(preview):"unsupported";
 const canManage=file!==null;

 // Other tabs, the file list and the trash can modify or remove this file.
 // Notifications only invalidate local state; all details are refetched from
 // the server with the current session permissions.
 useEffect(()=>{
  const invalidate=()=>setReloadToken(value=>value+1);
  const changed=observeResourceChange("file",change=>{
   if(!change.id||change.id===id)invalidate();
  });
  const returned=observeWindowReturn(invalidate);
  const reviewed=observeWorkspaceChange(invalidate,["review","lifecycle","permissions"]);
  return()=>{changed();returned();reviewed();};
 },[id]);

 useEffect(()=>{
  let valid=true;
  const controller=new AbortController();
  const switchingFile=loadedPreviewId.current!==id;
  loadedPreviewId.current=id;
  // Retain the prior authorized preview while background invalidation
  // fetches the new revision. Clearing the media component on every event
  // makes PDF, video, Office and CAD previews visibly flash.
  if(switchingFile||!preview){
   setStatus("loading");
   setPreview(null);setFile(null);setVersions([]);
  }
  setError("");
  // The metadata endpoint checks access and returns the complete version
  // history in one read. Anonymous WS "file" events cannot identify their
  // target, but most unrelated changes only need this cheap verification,
  // not another download and remount of the current PDF/video/Office viewer.
  const inspect=async()=>{
   const meta=await fileApi.meta(id,controller.signal);
   const reused=!switchingFile?reuseVerifiedPreview(preview,meta.file):null;
   const data=reused??await fileApi.preview(id,controller.signal);
   return {data,meta};
  };
  void inspect()
   .then(({data,meta})=>{
    if(!valid)return;
    setPreview(current=>{
     if(current===data)return current;
     return data;
    });
    setVersions(current=>JSON.stringify(current)===JSON.stringify(meta.versions)?current:meta.versions);
    setFile(current=>current&&JSON.stringify(current)===JSON.stringify(meta.file)?current:meta.file);
    setStatus("ready");
   }).catch(err=>{if(valid){
    // Revoked access must never leave the last successful preview visible.
    setPreview(null);setFile(null);setVersions([]);
    setStatus("failed");setError(errorCopy(err,"无法读取文件，请检查访问权限。"));
   }});
  return()=>{valid=false;controller.abort();};
 },[id,reloadToken]);

 useEffect(()=>{
  let live=true;
  void fileApi.lifecycle(id).then(value=>{if(live)setLifecycle(value);})
   .catch(()=>{if(live)setLifecycle(null);});
  return()=>{live=false;};
 },[id,reloadToken]);

 useEffect(()=>{
  if(!file){setRequiresApproval(null);return;}
  let valid=true;
  setRequiresApproval(null);
  workflowApi.policy(file.folderId)
   .then(policy=>{if(valid)setRequiresApproval(policy.configured&&policy.enabled===true);})
   .catch(()=>{if(valid)setRequiresApproval(null);});
  return()=>{valid=false;};
 },[file?.folderId]);

 useEffect(()=>{
  let valid=true;
  setFavorite(null);
  request<{kind:string;fileId?:string}[]>("/favorites")
   .then(rows=>{if(valid)setFavorite(rows.some(row=>row.kind==="file"&&row.fileId===id));})
   .catch(()=>{if(valid)setFavorite(null);});
  return()=>{valid=false;};
 },[id]);

 function refresh(){setReloadToken(value=>value+1);}
 function announce(message:string,isError=false){
  setError(isError?message:"");setNotice(isError?"":message);
  if(message)(isError?toast.error:toast.success)(message);
 }
 function download(){
  if(!preview)return;
  const link=document.createElement("a");
  link.href=preview.renderer==="pdf"?fileApi.signedDownloadUrl(preview.fileId,currentSeq,sealRevision):bytesUrl(preview.fileId);link.download=preview.name;
  document.body.append(link);link.click();link.remove();
  toast.info("已交由浏览器处理下载，请在下载列表确认结果");
 }
 async function toggleFavorite(){
  if(favorite===null||favoriteBusy)return;
  setFavoriteBusy(true);
  try{
   await request("/favorites/file/"+id,{method:favorite?"DELETE":"PUT"});
   setFavorite(!favorite);
   announce(favorite?"已取消收藏":"已加入收藏");
  }catch(err){announce(errorCopy(err,"收藏操作失败"),true);}
  finally{setFavoriteBusy(false);}
 }
 async function remove(){
  if(!file||busy)return;
  setBusy(true);
  try{
   await fileApi.remove(file.id);
   toast.success("文件已移入回收站");
   navigate("/doc?folder="+encodeURIComponent(file.folderId),{replace:true});
  }catch(err){announce(errorCopy(err,"删除失败"),true);}
  finally{setBusy(false);}
 }
 const moreActions:MenuItem[]=[
  {id:"favorite",label:favorite===null?"收藏状态不可用":favorite?"取消收藏":"收藏文件",
   disabled:!canManage||favorite===null||favoriteBusy,onSelect:()=>void toggleFavorite()},
  ...(preview?.textual&&canManage&&!archived?[{id:"edit-text",label:"编辑文本内容",
    disabled:requiresApproval===null,onSelect:()=>setEditing(true)}]:[]),
  ...(canManage&&!archived?[{id:"rename",label:"重命名",onSelect:()=>setRenaming(true)},
    {id:"move",label:"移动文件",onSelect:()=>setMoving(true)}]:[]),
  ...(canManage&&user.isAdmin?[{id:"share",label:"分享文件",onSelect:()=>setSharing(true)}]:[]),
  ...(canManage&&!archived?[{id:"delete",label:"移入回收站",danger:true,onSelect:()=>setDeleting(true)}]:[]),
 ];

 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work file-preview-page">
    {status==="loading"&&<p className="empty" role="status"><BrandLoadingLabel size="sm">正在加载文件…</BrandLoadingLabel></p>}
    {status==="failed"&&<div className="file-workbench-error"><p role="alert" className="notice error">{error}</p>
     <div className="file-workbench-recovery-actions">
      <RareButton onClick={refresh}>重新加载</RareButton>
      <Link to="/doc" className="rare-button">返回文件列表</Link>
      <Link to="/trash" className="rare-button">查看回收站</Link>
     </div>
    </div>}
    {status==="ready"&&preview&&<div className="file-workbench">
     <header className="file-workbench-header">
      <div className="file-workbench-heading">
       <Link to={file?"/doc?folder="+encodeURIComponent(file.folderId):"/doc"} className="file-back" aria-label="返回文件列表">‹</Link>
       <div className="file-workbench-type" aria-hidden="true">{fileExtension(preview.name).slice(0,5)}</div>
       <div className="file-workbench-title">
        <h1 title={preview.name}>{preview.name}</h1>
        <div className="file-workbench-subtitle"><span>{fileExtension(preview.name)}</span><span>{formatSize(preview.size)}</span><span>当前版本 v{currentSeq}</span>
         {lifecycle&&<RareBadge tone={archived?"warning":lifecycle.state==="released"?(lifecycle.publishedSeq===currentSeq?"success":"warning"):"neutral"} dot>{archived?"已归档":lifecycle.state==="released"?(lifecycle.publishedSeq===currentSeq?"已发布":"待发布更新"):"草稿"}</RareBadge>}
         {lifecycle?.dueStatus==="soon"&&<RareBadge tone="warning">即将到期</RareBadge>}
         {lifecycle?.dueStatus==="overdue"&&<RareBadge tone="danger">已到期</RareBadge>}</div>
       </div>
      </div>
      <RareButton type="button" tone="ghost" className="file-focus-toggle" aria-pressed={focusMode} onClick={()=>setFocusMode(v=>!v)}>{focusMode?"退出沉浸":"沉浸预览"}</RareButton>
     </header>
     <div className={"file-workbench-layout"+(focusMode?" is-focused":"")+(["details","versions","review","seals"].includes(tab)?" has-context":"")}>
      <aside className="file-workbench-sidebar" aria-label="文件工作台">
       <nav className="file-workbench-nav" aria-label="文件功能导航">
        {([["preview","预览"],["details","文件信息"],["versions","历史记录"],["compare","版本对比"],["review","审查批注"],["seals","签名与盖章"]] as const)
         .filter(([key])=>key!=="seals"||preview.renderer==="pdf"||isOfficeName(preview.name))
         .map(([key,label])=><RareButton key={key} type="button" className={"file-workbench-nav-item"+(tab===key?" is-active":"")}
          aria-current={tab===key?"page":undefined} aria-pressed={tab===key} onClick={()=>setTab(key)}>
          <span className="file-nav-indicator" aria-hidden="true"/><span>{label}</span>{key==="versions"&&<small>{versions.length}</small>}
         </RareButton>)}
       </nav>
       <div className="file-workbench-side-actions">      <div className="file-workbench-actions" role="group" aria-label="文件操作">
       <RareButton type="button" className="primary" tone="primary" onClick={download}>下载</RareButton>
       {(preview.renderer==="pdf"||isOfficeName(preview.name))&&<RareButton type="button" tone="ghost" className="file-sign-action" onClick={()=>setTab("seals")}>签名 / 盖章</RareButton>}
       <RareButton type="button" tone="ghost" onClick={()=>setPrinting(true)}>打印</RareButton>
       {isOfficeName(preview.name)&&!archived&&<Link className="rare-button file-action-link" to={"/office/"+id}>在线编辑</Link>}
       {isCadName(preview.name)&&<Link className="rare-button file-action-link" to={"/model/"+id}>3D 查看</Link>}
       {moreActions.length>0&&<RareButton ref={moreRef} type="button" tone="ghost" className="file-more-trigger"
        aria-label="更多文件操作" aria-haspopup="menu" aria-expanded={moreOpen}
        onClick={()=>setMoreOpen(value=>!value)}>
        更多操作 <svg viewBox="0 0 20 20" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><path d="m5 8 5 5 5-5"/></svg>
       </RareButton>}
       <Menu open={moreOpen} onClose={()=>setMoreOpen(false)} anchor={moreRef.current}
        label="文件更多操作" items={moreActions}/>
      </div>
</div>
            {tab==="details"&&<section id="file-panel-details" role="tabpanel" aria-labelledby="file-tab-details" className="file-sidebar-context file-details-panel">
      <FileMetadataEditor fileId={id}/>
      <dl className="file-properties">
       <div><dt>文件名</dt><dd>{preview.name}</dd></div>
       <div><dt>文件类型</dt><dd>{fileExtension(preview.name)} · {preview.contentType||"未知"}</dd></div>
       <div><dt>文件大小</dt><dd>{formatSize(preview.size)}（{preview.size.toLocaleString()} 字节）</dd></div>
       <div><dt>当前版本</dt><dd>v{currentSeq}</dd></div>
       {file&&<div><dt>修改时间</dt><dd>{versionTime(file.updatedAt)}</dd></div>}
       {file&&<div><dt>创建人</dt><dd>{file.uploadedBy}</dd></div>}
       <div><dt>SHA-256</dt><dd className="file-full-hash">{preview.sha256}</dd></div>
       {preview.textual&&<>
        <div><dt>文本编码</dt><dd>{preview.byteMeta.encoding}</dd></div>
        <div><dt>行尾格式</dt><dd>{preview.byteMeta.eol}</dd></div>
        <div><dt>字节标记 / 末尾换行</dt><dd>{preview.byteMeta.hasBom?"包含 BOM":"无 BOM"} / {preview.byteMeta.endsWithNewline?"有":"无"}</dd></div>
       </>}
      </dl>
     </section>}

            {tab==="review"&&<section id="file-panel-review" role="tabpanel" aria-labelledby="file-tab-review" className="file-sidebar-context">
      <FileReviewPanel fileId={id} versions={versions}/>
     </section>}

       {tab==="versions"&&<section className="file-sidebar-context" aria-label="文件历史">
         <div className="file-history-switch" role="group" aria-label="历史分类">
          <RareButton type="button" aria-pressed={historyView==="activity"} onClick={()=>setHistoryView("activity")}>操作记录</RareButton>
          <RareButton type="button" aria-pressed={historyView==="versions"} onClick={()=>setHistoryView("versions")}>内容版本</RareButton>
         </div>
         {historyView==="activity"?<FileHistoryPanel fileId={id} revision={reloadToken}/>:<div className="file-version-timeline">
        {versions.length===0?<p className="empty">暂无版本记录</p>:versions.slice().reverse().map(v=><article key={v.versionSeq} className="file-version-entry">
         <div className="file-version-entry-heading"><strong>v{v.versionSeq}</strong>{v.versionSeq===currentSeq&&<RareBadge tone="info">当前</RareBadge>}</div>
         <span>{ACTION_LABELS[v.action]??v.action}{v.rollbackTargetSeq?" · 来自 v"+v.rollbackTargetSeq:""}</span>
         <small>{v.createdBy} · {versionTime(v.createdAt)}</small>
         {v.versionSeq!==currentSeq&&<RareButton type="button" disabled={!canManage||archived} onClick={()=>{announce("");setRollback(v)}}>恢复此版本</RareButton>}
        </article>)}
       </section>}
      </aside>
      <div className="file-workbench-main">
       {(notice||error)&&<p role={error?"alert":"status"} className={"notice file-workbench-inline-notice"+(error?" error":"")}>{error||notice}</p>}
            <section className="file-workbench-panel file-workbench-preview-surface" aria-label="文件预览" hidden={tab==="compare"||tab==="seals"}>
      {(preview.renderer==="image"||preview.renderer==="video"||preview.renderer==="audio")?
       <MediaPreview key={preview.fileId+preview.sha256} fileId={preview.fileId} sha256={preview.sha256}
        name={preview.name} kind={preview.renderer} mime={preview.mediaType??""}/>:
       preview.renderer==="pdf"?
        <PDFPageViewer fileId={preview.fileId} sha={preview.sha256} name={preview.name} seq={currentSeq} revision={sealRevision} epoch={reloadToken} onRevisionChange={setSealRevision}/>:
       preview.structured&&["spreadsheet","presentation","document"].includes(adapter)?
        <OfficeLayoutPreview fileId={preview.fileId} sha={preview.sha256} structured={preview.structured}/>:
       preview.structured&&adapter==="archive"?
        <StructuredFilePreview value={preview.structured}/>:
       adapter==="cad"?
        <CadPreviewStatus fileId={preview.fileId}/>:
       preview.textual?
        <div className="file-text-stage">
         <div className="file-text-tools"><span>{preview.truncated?"已显示文件前 256 KB":"文件内容"}</span>
          <RareButton type="button" aria-pressed={wrapText} onClick={()=>setWrapText(value=>!value)}>{wrapText?"取消自动换行":"自动换行"}</RareButton>
          <RareButton type="button" onClick={()=>void navigator.clipboard.writeText(preview.content).then(()=>announce("预览文本已复制")).catch(()=>announce("复制失败，请手动选择文本",true))}>复制文本</RareButton>
         </div>
         <pre className={"file-text-content"+(wrapText?" file-text-wrap":"")}>{preview.content||"（空文件）"}</pre>
         {preview.truncated&&<p className="file-text-truncated">内容较长，仅显示前 256 KB。下载后可查看完整内容。</p>}
        </div>:
        <div className="file-unsupported">
         <div className="file-unsupported-symbol" aria-hidden="true">{fileExtension(preview.name).slice(0,5)}</div>
         <strong>此格式暂不支持浏览器内直接预览</strong>
         <p>{isCadName(preview.name)?"可前往 3D 查看器检查模型；若服务端暂不支持该格式的转换，请使用专业软件打开。":
          "为了安全，网页不会直接执行 SVG、HTML 或其他未知格式的活动内容。可下载后使用对应应用打开。"}</p>
        </div>}
     </section>

            {tab==="compare"&&<section id="file-panel-compare" role="tabpanel" aria-labelledby="file-tab-compare" className="file-workbench-mode-panel">
      <VersionComparePanel fileId={id} versions={versions}/>
     </section>}

            {tab==="seals"&&<section id="file-panel-seals" role="tabpanel" aria-labelledby="file-tab-seals" className="file-workbench-mode-panel file-workbench-signing">
      {isOfficeName(preview.name)?
       <DocxSealConversion fileId={id} versionSeq={currentSeq} sha={preview.sha256} name={preview.name}/>:
       <FileSealsPanel fileId={id} seq={currentSeq} sha={preview.sha256} name={preview.name} isAdmin={user.isAdmin} controlsTargetId="file-seals-sidebar" onSelectRevision={value=>{setSealRevision(value);setTab("preview")}} onChanged={()=>{setSealRevision(null);refresh();toast.success("签章版本已更新")}}/>}
     </section>}

      </div>
     </div>
    </div>}
   </main>
  </div>
  {editing&&file&&requiresApproval!==null&&<FileEditor file={file} requiresApproval={requiresApproval} onClose={()=>{setEditing(false);refresh();}} onSaved={()=>{announce("编辑已提交，版本状态正在刷新");refresh();}}/>}
  {moving&&file&&<MoveDialog file={file} presetTargetId="" onClose={()=>setMoving(false)}
   onMoved={()=>{setMoving(false);announce("文件已移动");refresh();}} onReload={refresh}/>}
   {sharing&&file&&<ShareDialog resource={{kind:"file",id:file.id,name:file.name}}
    onClose={()=>setSharing(false)} onCreated={()=>{setSharing(false);announce("分享已创建");}}/>}
   {printing&&preview&&<PrintDialog preview={preview} sealRevision={sealRevision} onClose={()=>setPrinting(false)}/>}
  {renaming&&file&&<FileRenameDialog file={file} onClose={()=>setRenaming(false)}
   onRenamed={()=>{setRenaming(false);refresh();}}/>}
  {deleting&&file&&<Dialog open title="移入回收站" onClose={()=>{if(!busy)setDeleting(false);}} closeGuard={()=>!busy}>
   <p>确定将「{file.name}」移入回收站吗？文件及版本记录可以从回收站恢复。</p>
   <div className="dialog-actions"><RareButton type="button" disabled={busy} onClick={()=>setDeleting(false)}>取消</RareButton><MicroHoldToDelete tone="danger" label={busy?"正在删除…":"确认删除"} disabled={busy} onConfirm={()=>void remove()}/></div>
  </Dialog>}
  {rollback&&<RollbackDialog fileId={id} currentSeq={currentSeq} version={rollback}
   onClose={()=>setRollback(null)}
   onCommitted={newSeq=>{setRollback(null);announce(newSeq>0?"已回滚为新版本 v"+newSeq:"回滚成功，正在刷新");refresh();}}
   onPending={()=>{setRollback(null);announce("已提交审批，当前版本保持不变");}}
   onConflict={()=>{setRollback(null);announce("文件已发生变化，请检查最新版本",true);refresh();}}
   onRefresh={refresh}/>}
 </AppShell>;
}
