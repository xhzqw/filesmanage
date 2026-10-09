import {useEffect,useState} from "react";
import {useParams} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {RollbackDialog} from "../features/documents/RollbackDialog";
import type {PreviewData,FileVersion} from "../entities/file/model";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";

const ACTION_LABELS:Record<string,string>={
 upload:"上传",
 edit:"编辑",
 rollback:"回滚",
 restore:"恢复",
};

const CAD_EXTENSIONS=[".stl",".obj",".glb",".gltf",".step",".stp",".iges",".igs",".dxf"];

function isCadName(name:string):boolean{
 const lower=name.toLowerCase();
 return CAD_EXTENSIONS.some(ext=>lower.endsWith(ext));
}

export function Preview({user,onLogout}:{user:User;onLogout:()=>void}){
 const{id=""}=useParams();
 const[preview,setPreview]=useState<PreviewData|null>(null);
 const[versions,setVersions]=useState<FileVersion[]>([]);
 const[status,setStatus]=useState("loading");
 const[notice,setNotice]=useState("");
 const[rollback,setRollback]=useState<FileVersion|null>(null);
 const[reloadToken,setReloadToken]=useState(0);
 const currentSeq=versions.at(-1)?.versionSeq??1;

 useEffect(()=>{
  let valid=true;
  setStatus("loading");
  Promise.all([fileApi.preview(id),fileApi.versions(id)])
   .then(([data,history])=>{
    if(!valid)return;
    setPreview(data);setVersions(history);setStatus("ready");
   })
   .catch(()=>{if(valid)setStatus("failed");});
  return()=>{valid=false;};
 },[id,reloadToken]);

 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    {status==="loading"&&<p className="empty">正在加载预览…</p>}
    {status==="failed"&&<p role="alert" className="notice error">无法读取该文件：不存在或没有预览权限。</p>}
    {status==="ready"&&preview&&<>
     <div className="breadcrumb">{preview.name} · {preview.size} 字节 · v{currentSeq}</div>
     <div className="toolbar">
      <a className="primary" href={"/api/files/"+preview.fileId+"/bytes"} download={preview.name}>下载原始字节</a>
      {preview.name.toLowerCase().endsWith(".docx")&&
       <a className="primary" href={"/office/"+preview.fileId}>在线编辑 DOCX</a>}
      {isCadName(preview.name)&&
       <a className="primary" href={"/model/"+preview.fileId}>3D 模型预览</a>}
      <span className="toolbar-hint">SHA-256 {preview.sha256}</span>
     </div>
     {preview.textual
      ?<pre className="preview-text" data-truncated={String(preview.truncated)}>{preview.content}{preview.truncated?"\n…（预览已截断，下载查看完整内容）":""}</pre>
      :<p className="empty">该格式不支持在线预览，请下载后查看。</p>}
     <div className="toolbar">
      <span className="toolbar-hint">编码 {preview.byteMeta.encoding} · 行尾 {preview.byteMeta.eol} · BOM {preview.byteMeta.hasBom?"有":"无"} · 末尾换行 {preview.byteMeta.endsWithNewline?"有":"无"}</span>
     </div>
     {notice&&<p role="status" className="notice">{notice}</p>}
     <div className="table">
      <table>
       <thead><tr><th scope="col">版本</th><th scope="col">动作</th><th scope="col">大小</th><th scope="col">校验值</th><th scope="col">创建人</th><th scope="col">时间</th><th scope="col">操作</th></tr></thead>
       <tbody>
        {versions.map(v=><tr key={v.versionSeq}>
         <td>v{v.versionSeq}</td>
         <td>{ACTION_LABELS[v.action]??v.action}{v.rollbackTargetSeq?` → v${v.rollbackTargetSeq}`:""}</td>
         <td>{v.sizeBytes}</td>
         <td className="hash" title={v.sha256}>{v.sha256.slice(0,12)}…</td>
         <td>{v.createdBy}</td>
         <td>{v.createdAt.replace("T"," ").slice(0,16)}</td>
         <td><button type="button" disabled={v.versionSeq===currentSeq}
          onClick={()=>{setNotice("");setRollback(v);}}>{v.versionSeq===currentSeq?"当前版本":"回滚到此版本"}</button></td>
        </tr>)}
       </tbody>
      </table>
     </div>
     <p className="hint">回滚以追加新版本方式执行，历史版本不可删除或改写。</p>
    </>}
   </main>
  </div>
  {rollback&&<RollbackDialog fileId={id} currentSeq={currentSeq} version={rollback}
   onClose={()=>setRollback(null)}
   onCommitted={newSeq=>{setRollback(null);setNotice(newSeq>0?`已回滚，新版本为 v${newSeq}`:"已回滚，版本列表已刷新");setReloadToken(token=>token+1);}}
   onPending={()=>{setRollback(null);setNotice("已提交待审批，当前生效版本未变。");}}
   onConflict={()=>{setRollback(null);setNotice("文件已被其他人修改，请刷新后重试");setReloadToken(token=>token+1);}}
   onRefresh={()=>setReloadToken(token=>token+1)}/>}
 </AppShell>;
}
