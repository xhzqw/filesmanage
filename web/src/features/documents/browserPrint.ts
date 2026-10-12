import type {PreviewData} from "../../entities/file/model";
import {fileApi} from "./api";
import {resolvePreviewAdapter} from "./previewAdapters";

export type Paper="A4"|"A3"|"letter";
export type Orientation="portrait"|"landscape";
export type PrintOptions={paper:Paper;orientation:Orientation;watermark:string;sheet?:string};
export type BrowserPrintKind="pdf"|"office"|"image"|"text";
const escapeHTML=(value:string)=>value.replace(/[&<>"']/g,ch=>({
 "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;",
}[ch]??ch));

export function browserPrintKind(preview:PreviewData):BrowserPrintKind|null{
 const kind=resolvePreviewAdapter(preview);
 if(kind==="pdf")return "pdf";
 if(kind==="document"||kind==="spreadsheet"||kind==="presentation")return "office";
 if(kind==="image")return "image";
 if(kind==="text"&&preview.textual&&!preview.truncated)return "text";
 return null;
}

/** Opens a transient top-level browsing context synchronously in a click
 * gesture. No content or user-supplied markup is evaluated here. */
export function openPrintWindow():Window{
 const popup=window.open("","_blank");
 if(!popup)throw new Error("浏览器阻止打印窗口，请允许此站点弹出窗口。");
 popup.opener=null;
 popup.document.open();
 popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>准备打印</title><body style="font:14px system-ui;padding:2em">正在验证文件权限与版本…</body>');
 popup.document.close();
 return popup;
}

export async function authorizeAndOpenPrint(popup:Window,preview:PreviewData,options:PrintOptions):Promise<void>{
 const kind=browserPrintKind(preview);
 if(!kind)throw new Error("此格式不支持批量浏览器打印，或文本预览不完整");
 if((kind==="pdf"||kind==="office")&&options.watermark.trim())
  throw new Error("PDF / Office 无法安全叠加浏览器水印，请关闭水印再打印");
 if(options.sheet&&resolvePreviewAdapter(preview)!=="spreadsheet")
  throw new Error("只能为 Excel 文件指定工作表");
 if(popup.closed)throw new Error("打印窗口已关闭");
 const result=await fileApi.preparePrint(preview.fileId,preview.sha256);
 if(result.sha256.toLowerCase()!==preview.sha256.toLowerCase())
  throw new Error("文件版本已变化，请刷新文件列表后重试");
 if(popup.closed)throw new Error("打印窗口已关闭");
 if(kind==="pdf"||kind==="office"){
  popup.location.replace(kind==="pdf"?fileApi.printMediaUrl(preview.fileId,result.sha256):
   fileApi.printOfficeUrl(preview.fileId,result.sha256,options.sheet));
  return;
 }
 renderPrintDocument(popup,preview,
  kind==="image"?fileApi.printMediaUrl(preview.fileId,result.sha256):"",kind,options);
}

export function renderPrintDocument(
 popup:Window,preview:PreviewData,src:string,kind:"image"|"text",options:PrintOptions,
):void{
 const mark=options.watermark.trim().slice(0,60);
 popup.document.open();
 popup.document.write('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>'+
  escapeHTML(preview.name.slice(0,200))+'</title><style>'+
  '@page{size:'+options.paper+' '+options.orientation+';margin:12mm}'+
  'html,body{background:white;color:#161f2b;margin:0;padding:0}'+
  'main{max-width:100%;margin:auto}pre{font:10pt/1.5 Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;tab-size:4}'+
  'img{display:block;max-width:100%;max-height:95vh;object-fit:contain;margin:auto}'+
  '.print-mark{position:fixed;top:49%;left:50%;width:100%;text-align:center;'+
  'transform:translate(-50%,-50%) rotate(-27deg);pointer-events:none;z-index:99;'+
  'font:700 32pt/1.3 system-ui,sans-serif;letter-spacing:.12em;color:rgba(65,82,110,.18);overflow-wrap:anywhere}'+
  '@media print{img{max-height:100%}}'+
  '</style></head><body><main></main></body></html>');
 popup.document.close();
 const main=popup.document.querySelector("main");
 if(!main)throw new Error("打印页面初始化失败");
 if(kind==="text"){
  const pre=popup.document.createElement("pre");
  pre.textContent=preview.content;
  main.append(pre);
 }else{
  const img=popup.document.createElement("img");
  img.alt=preview.name;
  main.append(img);
  img.addEventListener("error",()=>{main.textContent="图片加载失败，请检查文件权限和版本";},{once:true});
  img.addEventListener("load",()=>{popup.focus();popup.print();},{once:true});
  img.src=src;
 }
 if(mark){
  const el=popup.document.createElement("div");
  el.className="print-mark";el.textContent=mark;
  el.setAttribute("aria-hidden","true");
  popup.document.body.append(el);
 }
 if(kind==="text"){popup.focus();popup.print();}
}
