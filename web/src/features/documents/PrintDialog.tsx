import {useEffect,useState} from "react";
import {useNavigate} from "react-router-dom";
import type {PreviewData} from "../../entities/file/model";
import {Dialog} from "../../shared/ui/Dialog";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {BrandLoader,BrandLoadingLabel} from "../../shared/ui/BrandLoader";
import {errorCopy} from "../../shared/errors";
import {fileApi} from "./api";
import {resolvePreviewAdapter} from "./previewAdapters";
import {authorizeAndOpenPrint,browserPrintKind,openPrintWindow,type Paper,type Orientation} from "./browserPrint";
import "./printDialog.css";


export function PrintDialog({preview,onClose,sealRevision=null}:{preview:PreviewData;onClose:()=>void;sealRevision?:number|null}){
 const navigate=useNavigate();
 const [paper,setPaper]=useState<Paper>("A4");
 const [orientation,setOrientation]=useState<Orientation>("portrait");
 const [markEnabled,setMarkEnabled]=useState(false);
 const [markText,setMarkText]=useState("内部资料");
 const [sheets,setSheets]=useState<{name:string}[]>([]);
 const [selectedSheet,setSelectedSheet]=useState("");
 const [sheetState,setSheetState]=useState<"loading"|"ready"|"failed">("loading");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [pdfImageUrl,setPdfImageUrl]=useState("");
 const [pdfImageError,setPdfImageError]=useState(false);
 const [pdfImageRetry,setPdfImageRetry]=useState(0);
 const kind=resolvePreviewAdapter(preview);
 const isPdf=kind==="pdf";
 const isOffice=["document","spreadsheet","presentation"].includes(kind);
 const isImage=kind==="image";
 const isText=kind==="text"&&preview.textual;
 const isCad=kind==="cad";
 const isSpreadsheet=kind==="spreadsheet";
 const printable=browserPrintKind(preview)!==null;
 const previewUrl=isPdf||isImage?fileApi.mediaUrl(preview.fileId,preview.sha256):
   isOffice?"/api/files/"+encodeURIComponent(preview.fileId)+"/preview/office-pdf?v="+encodeURIComponent(preview.sha256):"";
 const pdfPageUrl=isPdf?fileApi.pdfPageUrl(preview.fileId,preview.sha256,1,sealRevision)+(pdfImageRetry?"&attempt="+pdfImageRetry:""):"";
 const pdfImageReady=pdfImageUrl===pdfPageUrl;
 useEffect(()=>{setPdfImageError(false);setPdfImageRetry(0);},[preview.fileId,preview.sha256,sealRevision]);
 useEffect(()=>{
  if(!isSpreadsheet)return;
  let valid=true;
  setSheetState("loading");setSelectedSheet("");setSheets([]);
  fileApi.printSheets(preview.fileId,preview.sha256).then(result=>{
   if(valid){setSheets(result);setSheetState("ready");}
  }).catch(()=>{if(valid)setSheetState("failed");});
  return()=>{valid=false;};
 },[isSpreadsheet,preview.fileId,preview.sha256]);

 async function print(){
  if(busy||!printable)return;
  // Must open synchronously inside the click gesture, before awaiting ACL
  // checks/conversion, or Chrome may block the printing context.
  let popup:Window;
  try{popup=openPrintWindow();}catch(cause){setError(errorCopy(cause,"无法打开打印窗口"));return;}
  setBusy(true);setError("");
  try{
   await authorizeAndOpenPrint(popup,preview,{
    paper,orientation,watermark:markEnabled?markText:"",sheet:isSpreadsheet?selectedSheet:"",sealRevision,
   });
   onClose();
  }catch(cause){
   if(!popup.closed)popup.close();
   setError(errorCopy(cause,"打印准备失败，请检查权限、文件版本或转换服务。"));
  }finally{setBusy(false);}
 }

 return <Dialog open title="打印文件" onClose={()=>{if(!busy)onClose();}} closeGuard={()=>!busy} className="document-print-dialog">
  <div className="document-print-layout">
   <div className="document-print-preview" aria-label="文件打印内容预览">
    {isImage?<img className="document-print-image" src={previewUrl} alt={"图片预览："+preview.name}/>:
     isPdf?<div className="document-print-pdf-stage" aria-busy={!pdfImageReady&&!pdfImageError}>
      {!pdfImageReady&&!pdfImageError&&<div className="document-print-pdf-loading" role="status" aria-label="正在渲染 PDF 首页">
       <BrandLoader size="md" decorative/>
      </div>}
      {pdfImageError&&<div className="document-print-pdf-loading" role="alert">
       <span>首页预览失败</span><RareButton type="button" onClick={()=>{setPdfImageRetry(i=>i+1);setPdfImageError(false);}}>重试</RareButton>
      </div>}
      <img key={pdfPageUrl} className={"document-print-pdf"+(pdfImageReady?"":" is-pending")}
       src={pdfPageUrl} alt={"PDF 首页："+preview.name} aria-hidden={!pdfImageReady}
       onLoad={()=>{setPdfImageUrl(pdfPageUrl);setPdfImageError(false);}}
       onError={()=>setPdfImageError(true)}/>
     </div>:
     isOffice?<div className="document-print-empty">Office 页面将转换为 PDF 后交给浏览器打印</div>:
     isText?<pre className="document-print-text">{preview.content||"（空文件）"}</pre>:
     <div className="document-print-empty">{isCad?"图纸在工程查看器内出图":"此格式没有可打印预览"}</div>}
    <span className="document-print-preview-caption">{isPdf||isOffice?"页面预览 · 实际打印以浏览器设置为准":
     isImage?"原始图像 · 按比例缩放":isText?"文本内容 · 自动分页":"工程图纸"}</span>
   </div>
   <div className="document-print-options">
    <strong title={preview.name} className="document-print-filename"><FileTypeIcon name={preview.name} size={19}/> {preview.name}</strong>
    {isCad?<p>机械图纸请在工程查看器中选择图层、比例与纸张后出图。</p>:
     !printable?<p>{isText&&preview.truncated?"文件超过文本预览上限，已禁止打印截断内容。":"此文件格式暂不支持浏览器打印。"}</p>:null}
    {!(isPdf||isOffice)&&<><label>纸张<RareSelect aria-label="纸张" value={paper} disabled={busy} onChange={e=>setPaper(e.target.value as Paper)}>
     <option value="A4">A4</option><option value="A3">A3</option><option value="letter">Letter</option>
    </RareSelect></label>
    <label>方向<RareSelect aria-label="方向" value={orientation} disabled={busy} onChange={e=>setOrientation(e.target.value as Orientation)}>
     <option value="portrait">纵向</option><option value="landscape">横向</option>
    </RareSelect></label></>}
    {(isPdf||isOffice)&&<small>将在浏览器 PDF 查看器中设置纸张、页码、份数和缩放后打印。</small>}
    {isSpreadsheet&&<label>工作表
     <RareSelect aria-label="打印工作表" disabled={busy||sheetState!=="ready"} value={selectedSheet}
      onChange={event=>setSelectedSheet(event.target.value)}>
      <option value="">全部可见工作表</option>
      {sheets.map(sheet=><option key={sheet.name} value={sheet.name}>{sheet.name}</option>)}
     </RareSelect>
     <small>{sheetState==="loading"?<BrandLoadingLabel>正在读取工作表…</BrandLoadingLabel>:sheetState==="failed"?"工作表列表不可用，可直接打印整个工作簿":
      "单独打印工作表时，原预览仍显示整个工作簿。输出采用文档原有打印区域与分页设置。"}</small>
    </label>}
    {isImage&&<small>图片按比例缩放适应纸张，不裁切原图。</small>}
    {isText&&!preview.truncated&&<small>自动换行并按纸张分页；不执行文件中的代码。</small>}
    {(isImage||isText)&&<><label className="document-print-mark-option">
     <RareInput type="checkbox" checked={markEnabled} disabled={busy} onChange={event=>setMarkEnabled(event.target.checked)}/>
     页面水印
    </label>
    {markEnabled&&<label>水印文字<RareInput className="document-print-mark-input" value={markText} maxLength={60}
     disabled={busy} onChange={event=>setMarkText(event.target.value)}/></label>}</>}
    {(isPdf||isOffice)&&<small>PDF/Office 的水印需要写入打印派生文件，原生浏览器打印暂不支持叠加。</small>}
   </div>
  </div>
  {error&&<p role="alert" className="notice error">{error}</p>}
  <div className="dialog-actions">
   <RareButton type="button" disabled={busy} onClick={onClose}>取消</RareButton>
   {isCad?<RareButton type="button" className="primary" onClick={()=>{onClose();navigate("/model/"+encodeURIComponent(preview.fileId));}}>打开工程图</RareButton>:
    <RareButton type="button" className="primary" disabled={!printable||busy} onClick={()=>void print()}>{busy?"正在准备…":isPdf||isOffice?"打开打印预览":"打印"}</RareButton>}
  </div>
 </Dialog>;
}
