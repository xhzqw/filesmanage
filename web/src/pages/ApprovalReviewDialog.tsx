import {useEffect,useMemo,useState} from "react";
import {RareBadge,RareButton,RareTabs} from "../shared/ui/rare";
import {Dialog} from "../shared/ui/Dialog";
import type {Approval} from "../features/workflow/api";
import {workflowApi} from "../features/workflow/api";
import {fileApi,type VersionComparison} from "../features/documents/api";
import type {PreviewData} from "../entities/file/model";
import {OfficeChangeGrid} from "../features/documents/OfficeChangeGrid";
import {compactDiff} from "../features/documents/VersionComparePanel";
import {StructuredFilePreview} from "../features/documents/StructuredFilePreview";
import {errorCopy} from "../shared/errors";
import "./approvalReview.css";

function PendingPreview({data,approval}:{data:PreviewData;approval:Approval}){
 const mediaUrl=workflowApi.draftMediaUrl(approval.id,data.sha256);
 if(data.renderer==="image")return <img className="approval-review-image" src={mediaUrl} alt={"待审批图片："+data.name}/>;
 if(data.renderer==="pdf")return <iframe className="approval-review-frame" title={"待审批 PDF："+data.name} src={mediaUrl}/>;
 if(data.renderer==="video")return <video className="approval-review-video" src={mediaUrl} controls preload="metadata"/>;
 if(data.renderer==="audio")return <audio className="approval-review-audio" src={mediaUrl} controls preload="metadata"/>;
 if(data.textual)return <pre className="approval-review-text">{data.content||"（空文件）"}{data.truncated&&"\n\n——仅显示前 256 KB——"}</pre>;
 if(data.structured)return <StructuredFilePreview value={data.structured}/>;
 return <p className="approval-review-empty">暂不支持此格式的在线预览；可以下载待审稿后使用专业软件检查。</p>;
}

export function ApprovalReviewDialog({approval,onClose}:{approval:Approval;onClose:()=>void}){
 const[tab,setTab]=useState<"diff"|"preview">("diff");
 const[comparison,setComparison]=useState<VersionComparison|null>(null);
 const[draft,setDraft]=useState<PreviewData|null>(null);
 const[current,setCurrent]=useState<PreviewData|null>(null);
 const[error,setError]=useState("");
 const[loading,setLoading]=useState(true);
 const[retry,setRetry]=useState(0);
 const[showAll,setShowAll]=useState(false);
 useEffect(()=>{
  let live=true;setLoading(true);setError("");setComparison(null);setDraft(null);setCurrent(null);
  Promise.all([workflowApi.compareDraft(approval.id),workflowApi.previewDraft(approval.id)])
   .then(([diff,data])=>{if(live){setComparison(diff);setDraft(data);}})
   .catch(err=>{if(live)setError(errorCopy(err,"待审稿读取失败"));})
   .finally(()=>{if(live)setLoading(false);});
  fileApi.preview(approval.fileId).then(data=>{if(live)setCurrent(data);}).catch(()=>{});
  return()=>{live=false;};
 },[approval.id,approval.fileId,retry]);
 const compact=useMemo(()=>comparison?.mode==="text"?(showAll?comparison.lines.map((_,index):{kind:"line";index:number}=>({kind:"line",index})):compactDiff(comparison.lines)):[],[comparison,showAll]);
 const baseMatchesCurrent=current?.sha256===comparison?.left.sha256;
 const mediaCurrent=(current?.renderer==="image"||current?.renderer==="pdf")&&baseMatchesCurrent;
 return <Dialog open title={"审阅待审稿 · "+approval.fileName} onClose={onClose} className="approval-review-dialog">
  <div className="approval-review-heading">
   <RareTabs label="待审内容" className="approval-review-tabs">
    <RareButton type="button" role="tab" aria-selected={tab==="diff"} onClick={()=>setTab("diff")}>变更对比</RareButton>
    <RareButton type="button" role="tab" aria-selected={tab==="preview"} onClick={()=>setTab("preview")}>在线预览</RareButton>
   </RareTabs>
   <RareButton type="button" disabled={loading} onClick={()=>setRetry(n=>n+1)}>刷新</RareButton>
  </div>
  {loading&&<p role="status" className="approval-review-empty">正在核对待审内容…</p>}
  {error&&<p role="alert" className="approval-error">{error}</p>}
  {!loading&&!error&&comparison&&draft&&<>
   <div className="approval-review-version-bar">
    <span>已发布基准 v{comparison.left.seq}</span><span aria-hidden="true">→</span><strong>待审批（尚未发布）</strong>
    <RareBadge tone={comparison.mode==="identical"?"neutral":"warning"}>{comparison.mode==="identical"?"内容相同":"有变更"}</RareBadge>
   </div>
   {tab==="diff"&&<div className="approval-review-body">
    {comparison.mode==="identical"?<p className="approval-review-empty">基准版本与待审稿字节完全一致。</p>:
     comparison.mode==="metadata"||comparison.mode==="large"?<div className="approval-review-fallback">
      <p>{comparison.mode==="large"?"文件超出安全文本对比上限，无法显示完整差异。":"此格式不支持逐行差异。可查看待审稿或使用专业软件对比。"}</p>
      <dl><dt>基准 SHA-256</dt><dd>{comparison.left.sha256}</dd><dt>待审 SHA-256</dt><dd>{comparison.right.sha256}</dd></dl>
      {mediaCurrent&&current?.renderer==="image"&&draft.renderer==="image"&&<div className="approval-review-sidebyside">
       <div><strong>已发布基准</strong><img src={fileApi.mediaUrl(approval.fileId,current.sha256)} alt="已发布基准图"/></div>
       <div><strong>待审稿</strong><img src={workflowApi.draftMediaUrl(approval.id,draft.sha256)} alt="待审图片"/></div>
      </div>}
      {current&&!baseMatchesCurrent&&<p className="approval-review-warning">当前已发布版本与申请基准不同。请核实版本冲突，不能将当前版本当成申请基准。</p>}
     </div>:
     comparison.detail==="office_semantic"&&comparison.semanticChanges?<div className="approval-review-office"><p>Office 语义差异：仅对可提取段落、单元格等内容进行比较，不代表页面排版或公式计算完全一致。</p><OfficeChangeGrid changes={comparison.semanticChanges}/></div>:
     <div className="approval-review-diff">
      <div className="approval-review-diff-tools"><strong>+{comparison.added} / −{comparison.removed} 行</strong>
       <RareButton type="button" aria-pressed={showAll} onClick={()=>setShowAll(value=>!value)}>{showAll?"只看变更":"显示全部"}</RareButton></div>
      <div role="table" aria-label="待审稿与基准版本差异" className="approval-review-diff-lines">
       {compact.map(part=>part.kind==="fold"?<div role="row" className="file-diff-fold" key={"f"+part.start}>省略 {part.count} 行未变更内容</div>:
        <div role="row" key={part.index} className={"file-diff-line "+comparison.lines[part.index]!.kind}>
         <span className="file-diff-number">{comparison.lines[part.index]!.left??""}</span>
         <span className="file-diff-number">{comparison.lines[part.index]!.right??""}</span>
         <span className="file-diff-sign">{comparison.lines[part.index]!.kind==="added"?"+":comparison.lines[part.index]!.kind==="removed"?"−":" "}</span>
         <span className="file-diff-text">{comparison.lines[part.index]!.text||" "}</span>
        </div>)}
      </div>
     </div>}
   </div>}
   {tab==="preview"&&<div className="approval-review-body approval-review-preview">
    <PendingPreview data={draft} approval={approval}/>
   </div>}
  </>}
  <div className="dialog-actions approval-review-footer">
   <span>待审稿不会替换当前版本，只有终级审批通过后才会发布。</span>
   <RareButton type="button" onClick={onClose}>关闭</RareButton>
  </div>
 </Dialog>;
}
