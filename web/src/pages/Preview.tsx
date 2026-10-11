import {RareBadge,RareButton,RareInput,RareTabs,MicroHoldToDelete} from "../shared/ui/rare";
import {useEffect,useState,type FormEvent} from "react";
import {Link,useNavigate,useParams} from "react-router-dom";
import {fileApi,formatSize,type FileLifecycle} from "../features/documents/api";
import {MediaPreview} from "../features/documents/MediaPreview";
import {StructuredFilePreview} from "../features/documents/StructuredFilePreview";
import {OfficeLayoutPreview} from "../features/documents/OfficeLayoutPreview";
import {CadPreviewStatus} from "../features/documents/CadPreviewStatus";
import {resolvePreviewAdapter,ADAPTER_TITLES} from "../features/documents/previewAdapters";
import {FileEditor} from "../features/documents/FileEditor";
import {FileMetadataEditor} from "../features/documents/FileMetadataEditor";
import {FileLifecyclePanel} from "../features/documents/FileLifecyclePanel";
import {VersionComparePanel} from "../features/documents/VersionComparePanel";
import {FileReviewPanel} from "../features/documents/FileReviewPanel";
import {MoveDialog} from "../features/documents/FileTable";
import {RollbackDialog} from "../features/documents/RollbackDialog";
import {ShareDialog} from "../features/collaboration/ShareDialog";
import {workflowApi} from "../features/workflow/api";
import {request} from "../shared/http";
import {errorCopy} from "../shared/errors";
import {Dialog} from "../shared/ui/Dialog";
import type {PreviewData,FileVersion,FileItem} from "../entities/file/model";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import "./previewWorkbench.css";

type Tab="preview"|"details"|"versions"|"compare"|"review";
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
 const[tab,setTab]=useState<Tab>("preview");
 const[notice,setNotice]=useState("");
 const[error,setError]=useState("");
 const[rollback,setRollback]=useState<FileVersion|null>(null);
 const[editing,setEditing]=useState(false);
 const[sharing,setSharing]=useState(false);
 const[moving,setMoving]=useState(false);
 const[renaming,setRenaming]=useState(false);
 const[renameValue,setRenameValue]=useState("");
 const[deleting,setDeleting]=useState(false);
 const[busy,setBusy]=useState(false);
 const[requiresApproval,setRequiresApproval]=useState<boolean|null>(null);
 const[favorite,setFavorite]=useState<boolean|null>(null);
 const[favoriteBusy,setFavoriteBusy]=useState(false);
 const[wrapText,setWrapText]=useState(true);
 const[reloadToken,setReloadToken]=useState(0);
 const[lifecycle,setLifecycle]=useState<FileLifecycle|null>(null);
 const archived=lifecycle?.state==="archived";
 const currentSeq=Math.max(file?.currentVersionSeq??1,...versions.map(v=>v.versionSeq));
 const adapter=preview?resolvePreviewAdapter(preview):"unsupported";
 const canManage=file!==null;

 useEffect(()=>{
  let valid=true;
  setStatus("loading");setError("");
  Promise.all([fileApi.preview(id),fileApi.versions(id),fileApi.meta(id).catch(()=>null)])
   .then(([data,history,meta])=>{
    if(!valid)return;
    setPreview(data);setVersions(history);setFile(meta?.file??null);setStatus("ready");
   }).catch(err=>{if(valid){setStatus("failed");setError(errorCopy(err,"无法读取文件，请检查访问权限。"));}});
  return()=>{valid=false;};
 },[id,reloadToken]);

 useEffect(()=>{
  let live=true;setLifecycle(null);
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
 function announce(message:string,isError=false){setError(isError?message:"");setNotice(isError?"":message);}
 function download(){
  if(!preview)return;
  const link=document.createElement("a");
  link.href=bytesUrl(preview.fileId);link.download=preview.name;
  document.body.append(link);link.click();link.remove();
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
 async function rename(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!file||busy||!renameValue.trim())return;
  setBusy(true);
  try{
   await fileApi.rename(file.id,renameValue.trim());
   setRenaming(false);announce("文件已重命名");refresh();
  }catch(err){announce(errorCopy(err,"重命名失败"),true);}
  finally{setBusy(false);}
 }
 async function remove(){
  if(!file||busy)return;
  setBusy(true);
  try{
   await fileApi.remove(file.id);
   navigate("/doc?folder="+encodeURIComponent(file.folderId),{replace:true});
  }catch(err){announce(errorCopy(err,"删除失败"),true);}
  finally{setBusy(false);}
 }

 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work file-preview-page">
    {status==="loading"&&<p className="empty" role="status">正在加载文件…</p>}
    {status==="failed"&&<div className="file-workbench-error"><p role="alert" className="notice error">{error}</p><RareButton onClick={refresh}>重新加载</RareButton></div>}
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
      <div className="file-workbench-actions" aria-label="文件操作">
       <RareButton type="button" className="primary" onClick={download}>下载</RareButton>
       {isOfficeName(preview.name)&&!archived&&<Link className="rare-button file-action-link" to={"/office/"+id}>在线编辑</Link>}
       {isCadName(preview.name)&&<Link className="rare-button file-action-link" to={"/model/"+id}>3D 查看</Link>}
       {preview.textual&&canManage&&!archived&&<RareButton type="button" disabled={requiresApproval===null}
        onClick={()=>setEditing(true)}>编辑内容</RareButton>}
       <RareButton type="button" disabled={!canManage||favorite===null||favoriteBusy} onClick={()=>void toggleFavorite()}>
        {favorite===null?"收藏不可用":favorite?"取消收藏":"收藏"}
       </RareButton>
       {canManage&&!archived&&<RareButton type="button" onClick={()=>{setRenameValue(preview.name);setRenaming(true);}}>重命名</RareButton>}
       {canManage&&!archived&&<RareButton type="button" onClick={()=>setMoving(true)}>移动</RareButton>}
       {canManage&&user.isAdmin&&<RareButton type="button" onClick={()=>setSharing(true)}>分享</RareButton>}
       {canManage&&!archived&&<RareButton type="button" className="file-delete-trigger" onClick={()=>setDeleting(true)}>删除</RareButton>}
      </div>
     </header>
     {(notice||error)&&<p role={error?"alert":"status"} className={"notice"+(error?" error":"")}>{error||notice}</p>}
     <RareTabs className="file-workbench-tabs" label="文件详情">
      {([["preview","预览"],["details","文件信息"],["versions","版本历史 ("+versions.length+")"],["compare","版本对比"],["review","审查批注"]] as const).map(([value,label])=>
       <RareButton key={value} type="button" id={"file-tab-"+value} role="tab"
        aria-selected={tab===value} tabIndex={tab===value?0:-1}
        aria-controls={"file-panel-"+value} onClick={()=>setTab(value)}>{label}</RareButton>)}
     </RareTabs>
     {tab==="preview"&&<section id="file-panel-preview" role="tabpanel" aria-labelledby="file-tab-preview" className="file-workbench-panel">
      <div className="file-section-caption"><strong>文件预览</strong><span>{ADAPTER_TITLES[adapter]}</span></div>
      {(preview.renderer==="image"||preview.renderer==="video"||preview.renderer==="audio")?
       <MediaPreview key={preview.fileId+preview.sha256} fileId={preview.fileId} sha256={preview.sha256}
        name={preview.name} kind={preview.renderer} mime={preview.mediaType??""}/>:
       preview.renderer==="pdf"?
        <div className="file-pdf-stage">
         <iframe title={"PDF 预览："+preview.name} src={fileApi.mediaUrl(preview.fileId,preview.sha256)}
          sandbox="allow-scripts allow-downloads" referrerPolicy="no-referrer"/>
         <p>若浏览器不支持内嵌 PDF，可使用上方的「下载」。</p>
        </div>:
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
         <RareButton type="button" onClick={download}>下载文件</RareButton>
        </div>}
     </section>}
     {tab==="details"&&<section id="file-panel-details" role="tabpanel" aria-labelledby="file-tab-details" className="file-workbench-panel file-details-panel">
      <h2>文件属性</h2>
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
     {tab==="compare"&&<section id="file-panel-compare" role="tabpanel" aria-labelledby="file-tab-compare" className="file-workbench-panel">
      <VersionComparePanel fileId={id} versions={versions}/>
     </section>}
     {tab==="review"&&<section id="file-panel-review" role="tabpanel" aria-labelledby="file-tab-review" className="file-workbench-panel">
      <FileReviewPanel fileId={id} versions={versions}/>
     </section>}
     {tab==="versions"&&<section id="file-panel-versions" role="tabpanel" aria-labelledby="file-tab-versions" className="file-workbench-panel file-versions-panel">
      <div className="file-section-caption"><strong>版本记录</strong><span>所有历史均保留 · 回滚会创建新版本</span></div>
      <FileLifecyclePanel fileId={id} currentSeq={currentSeq} lifecycle={lifecycle} onUpdated={value=>{setLifecycle(value);announce("生命周期状态已更新");}}/>
      {versions.length===0?<p className="empty">暂无版本记录</p>:
      <div className="table file-versions-table"><table>
       <thead><tr><th scope="col">版本</th><th scope="col">操作</th><th scope="col">文件大小</th><th scope="col">创建人</th><th scope="col">时间</th><th scope="col">版本操作</th></tr></thead>
       <tbody>{versions.slice().reverse().map(v=><tr key={v.versionSeq}>
        <td><strong>v{v.versionSeq}</strong> {v.versionSeq===currentSeq&&<span className="file-current-version">当前</span>}</td>
        <td>{ACTION_LABELS[v.action]??v.action}{v.rollbackTargetSeq?" · 来自 v"+v.rollbackTargetSeq:""}</td>
        <td>{formatSize(v.sizeBytes)}</td><td>{v.createdBy}</td><td>{versionTime(v.createdAt)}</td>
        <td>{v.versionSeq===currentSeq?"—":<RareButton type="button" disabled={!canManage||archived} onClick={()=>{announce("");setRollback(v);}}>回滚到此版本</RareButton>}</td>
       </tr>)}</tbody>
      </table></div>}
     </section>}
    </div>}
   </main>
  </div>
  {editing&&file&&requiresApproval!==null&&<FileEditor file={file} requiresApproval={requiresApproval} onClose={()=>{setEditing(false);refresh();}} onSaved={()=>{announce("编辑已提交，版本状态正在刷新");refresh();}}/>}
  {moving&&file&&<MoveDialog file={file} presetTargetId="" onClose={()=>setMoving(false)}
   onMoved={()=>{setMoving(false);announce("文件已移动");refresh();}} onReload={refresh}/>}
  {sharing&&file&&<ShareDialog resource={{kind:"file",id:file.id,name:file.name}}
   onClose={()=>setSharing(false)} onCreated={()=>{setSharing(false);announce("分享已创建");}}/>}
  {renaming&&<Dialog open title="重命名文件" onClose={()=>{if(!busy)setRenaming(false);}} closeGuard={()=>!busy}>
   <form onSubmit={rename}>
    <label htmlFor="file-workbench-rename">新文件名</label>
    <RareInput id="file-workbench-rename" value={renameValue} maxLength={200} required disabled={busy} onChange={e=>setRenameValue(e.target.value)}/>
    <div className="dialog-actions"><RareButton type="button" disabled={busy} onClick={()=>setRenaming(false)}>取消</RareButton><RareButton type="submit" className="primary" disabled={busy||!renameValue.trim()}>保存</RareButton></div>
   </form>
  </Dialog>}
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
