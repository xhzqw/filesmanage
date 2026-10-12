import {useState} from "react";
import {useNavigate} from "react-router-dom";
import type {PreviewData} from "../../entities/file/model";
import {Dialog} from "../../shared/ui/Dialog";
import {RareButton,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {fileApi} from "./api";
import {resolvePreviewAdapter} from "./previewAdapters";
import "./printDialog.css";

type Paper="A4"|"A3"|"letter";
type Orientation="portrait"|"landscape";
const escapeHTML=(value:string)=>value.replace(/[&<>"']/g,ch=>({
 "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
}[ch]??ch));

// Standalone same-origin browsing context. All printable text is a DOM text
// node; user document HTML/SVG is NEVER inserted as executable markup.
function renderPage(popup:Window,preview:PreviewData,source:string,kind:"text"|"image",paper:Paper,orientation:Orientation){
 const safeTitle=escapeHTML(preview.name.slice(0,200));
 popup.document.open();
 popup.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>'+safeTitle+
  '</title><style>@page{size:'+paper+' '+orientation+';margin:12mm}'+
  'html,body{background:#fff;color:#161f2b;margin:0;padding:0}'+
  'main{max-width:100%;margin:auto}pre{font:10pt/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4}'+
  'img{display:block;max-width:100%;max-height:95vh;object-fit:contain;margin:auto}'+
  '@media print{img{max-height:100%}}'+
  '</style></head><body><main></main></body></html>');
 popup.document.close();
 const main=popup.document.querySelector("main");
 if(!main)throw new Error("无法创建打印页面");
 if(kind==="text"){
  const pre=popup.document.createElement("pre");
  pre.textContent=preview.content;
  main.append(pre);
  popup.focus();popup.print();
  return;
 }
 const image=popup.document.createElement("img");
 image.alt=preview.name;
 image.onload=()=>{popup.focus();popup.print();};
 image.onerror=()=>{main.textContent="打印图片加载失败。请检查文件权限或版本是否发生变化。";};
 image.src=source;
 main.append(image);
}

export function PrintDialog({preview,onClose}:{preview:PreviewData;onClose:()=>void}){
 const navigate=useNavigate();
 const [paper,setPaper]=useState<Paper>("A4");
 const [orientation,setOrientation]=useState<Orientation>("portrait");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const kind=resolvePreviewAdapter(preview);
 const isPdf=kind==="pdf";
 const isOffice=["document","spreadsheet","presentation"].includes(kind);
 const isImage=kind==="image";
 const isText=kind==="text"&&preview.textual;
 const isCad=kind==="cad";
 const printable=isPdf||isOffice||isImage||(isText&&!preview.truncated);
 const previewUrl=isPdf||isImage?fileApi.mediaUrl(preview.fileId,preview.sha256):
  isOffice?"/api/files/"+encodeURIComponent(preview.fileId)+"/preview/office-pdf?v="+encodeURIComponent(preview.sha256):"";

 async function print(){
  if(busy||!printable)return;
  // Must open synchronously inside the click gesture, before awaiting ACL
  // checks/conversion, or Chrome may block the printing context.
  const popup=window.open("","_blank");
  if(!popup){setError("浏览器阻止了打印窗口，请允许此站点弹出窗口后重试。");return;}
  popup.opener=null;
  popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>准备打印</title><body style="font:14px system-ui;padding:2em">正在检查权限并准备打印内容…</body>');
  popup.document.close();
  setBusy(true);setError("");
  try{
   const prep=await fileApi.preparePrint(preview.fileId,preview.sha256);
   if(prep.sha256!==preview.sha256)throw new Error("文件版本已更新，请刷新页面后再打印。");
   if(popup.closed)throw new Error("打印窗口已关闭。");
   if(isPdf||isOffice){
    // Native PDF viewer owns page-range/copies/scale. Do not claim these can
    // be controlled by CSS or that opening the viewer means physical success.
    popup.location.replace(isPdf?fileApi.printMediaUrl(preview.fileId,prep.sha256):
     fileApi.printOfficeUrl(preview.fileId,prep.sha256));
   }else{
    renderPage(popup,preview,isImage?fileApi.printMediaUrl(preview.fileId,prep.sha256):"",
     isImage?"image":"text",paper,orientation);
   }
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
     isPdf||isOffice?<iframe className="document-print-pdf" title={"页面布局预览："+preview.name}
      src={previewUrl} sandbox="allow-scripts" referrerPolicy="no-referrer"/>:
     isText?<pre className="document-print-text">{preview.content||"（空文件）"}</pre>:
     <div className="document-print-empty">{isCad?"图纸在工程查看器内出图":"此格式没有可打印预览"}</div>}
    <span className="document-print-preview-caption">{isPdf||isOffice?"页面预览 · 实际打印以浏览器设置为准":
     isImage?"原始图像 · 按比例缩放":isText?"文本内容 · 自动分页":"工程图纸"}</span>
   </div>
   <div className="document-print-options">
    <strong title={preview.name} className="document-print-filename">{preview.name}</strong>
    {isCad?<p>机械图纸请在工程查看器中选择图层、比例与纸张后出图。</p>:
     !printable?<p>{isText&&preview.truncated?"文件超过文本预览上限，已禁止打印截断内容。":"此文件格式暂不支持浏览器打印。"}</p>:null}
    {!(isPdf||isOffice)&&<><label>纸张<RareSelect aria-label="纸张" value={paper} disabled={busy} onChange={e=>setPaper(e.target.value as Paper)}>
     <option value="A4">A4</option><option value="A3">A3</option><option value="letter">Letter</option>
    </RareSelect></label>
    <label>方向<RareSelect aria-label="方向" value={orientation} disabled={busy} onChange={e=>setOrientation(e.target.value as Orientation)}>
     <option value="portrait">纵向</option><option value="landscape">横向</option>
    </RareSelect></label></>}
    {(isPdf||isOffice)&&<small>将在浏览器 PDF 查看器中设置纸张、页码、份数和缩放后打印。</small>}
    {isImage&&<small>图片按比例缩放适应纸张，不裁切原图。</small>}
    {isText&&!preview.truncated&&<small>自动换行并按纸张分页；不执行文件中的代码。</small>}
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
