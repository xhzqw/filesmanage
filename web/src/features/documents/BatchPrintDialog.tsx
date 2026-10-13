import {useState} from "react";
import type {FileItem} from "../../entities/file/model";
import {Dialog} from "../../shared/ui/Dialog";
import {FileTypeIcon} from "../../shared/ui/FileTypeIcon";
import {RareButton,RareInput,RareSelect} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import {fileApi} from "./api";
import {authorizeAndOpenPrint,openPrintWindow,type Paper,type Orientation} from "./browserPrint";
import "./batchPrint.css";

type ItemState={state:"opened"|"failed";message:string};

// Manual per-file confirmation is intentional: browsers reliably allow ONE
// popup per user gesture, not dozens; the OS never reports paper completion.
export function BatchPrintDialog({files,onClose}:{files:FileItem[];onClose:()=>void}){
 const selection=files;
 const [active,setActive]=useState(0);
 const [state,setState]=useState<Record<string,ItemState>>({});
 const [busy,setBusy]=useState(false);
 const [paper,setPaper]=useState<Paper>("A4");
 const [orientation,setOrientation]=useState<Orientation>("portrait");
 const [watermark,setWatermark]=useState(false);
 const [markText,setMarkText]=useState("内部资料");
 const item=selection[active];
 const opened=selection.filter(file=>state[file.id]?.state==="opened").length;
 const unsupported=/\.(?:dwg|dxf|stl|step|stp|iges|igs|obj|glb|gltf|3mf|ply|msh)$/i;

 async function openSelected(){
  if(busy||!item)return;
  if(unsupported.test(item.name)){
   setState(current=>({...current,[item.id]:{state:"failed",message:"工程图纸请在模型查看器单独出图"}}));
   return;
  }
  let popup:Window;
  try{popup=openPrintWindow();}
  catch(error){
   setState(current=>({...current,[item.id]:{state:"failed",message:errorCopy(error,"无法打开打印窗口")}}));
   return;
  }
  setBusy(true);
  try{
   const preview=await fileApi.preview(item.id);
   if(preview.sha256.toLowerCase()!==item.sha256.toLowerCase())
    throw new Error("文件在选择后已更新，请刷新列表后重试");
   await authorizeAndOpenPrint(popup,preview,{paper,orientation,watermark:watermark?markText:""});
   setState(current=>({...current,[item.id]:{state:"opened",message:"已打开打印预览（未确认物理打印）"}}));
  }catch(error){
   if(!popup.closed)popup.close();
   setState(current=>({...current,[item.id]:{state:"failed",message:errorCopy(error,"无法准备此文件打印")}}));
  }finally{setBusy(false);}
 }
 return <Dialog open title="批量打印" className="batch-print-dialog" onClose={onClose} closeGuard={()=>!busy}>
  <div className="batch-print-layout">
   <div className="batch-print-files" role="group" aria-label="待打印文件">
    <div className="batch-print-count">{selection.length} 个文件 · {opened} 份已打开预览</div>
    {selection.map((file,index)=><RareButton type="button" key={file.id} disabled={busy}
     className={"batch-print-row"+(index===active?" active":"")}
     aria-pressed={index===active} onClick={()=>setActive(index)}>
     <span className="batch-print-index">{index+1}</span>
     <FileTypeIcon name={file.name} size={18}/>
     <span className="batch-print-name" title={file.name}>{file.name}</span>
     <span className={"batch-print-state "+(state[file.id]?.state??"pending")}>
      {state[file.id]?.state==="opened"?"已预览":state[file.id]?.state==="failed"?"失败":
       "待处理"}
     </span>
    </RareButton>)}
   </div>
   <div className="batch-print-settings">
    <strong className="batch-print-current" title={item?.name}>{item?.name??"没有选择文件"}</strong>
    <label>纸张<RareSelect aria-label="批量打印纸张" disabled={busy} value={paper} onChange={event=>setPaper(event.target.value as Paper)}>
     <option value="A4">A4</option><option value="A3">A3</option><option value="letter">Letter</option>
    </RareSelect></label>
    <label>方向<RareSelect aria-label="批量打印方向" disabled={busy} value={orientation} onChange={event=>setOrientation(event.target.value as Orientation)}>
     <option value="portrait">纵向</option><option value="landscape">横向</option>
    </RareSelect></label>
    <label className="batch-print-mark"><RareInput type="checkbox" checked={watermark} disabled={busy}
     onChange={event=>setWatermark(event.target.checked)}/> 文本/图片水印</label>
    {watermark&&<label>水印文字<RareInput value={markText} disabled={busy} maxLength={60}
     onChange={event=>setMarkText(event.target.value)}/></label>}
    <p className="batch-print-note">逐份打开系统打印预览。PDF/Office 页码和打印区域由浏览器设置；水印仅支持文本、图片。</p>
    {item&&state[item.id]&&<p role="status" className="batch-print-result">{state[item.id]?.message}</p>}
    <div className="batch-print-navigation">
     <RareButton type="button" disabled={busy||active===0} onClick={()=>setActive(i=>Math.max(0,i-1))}>上一份</RareButton>
     <RareButton type="button" disabled={busy||active===selection.length-1} onClick={()=>setActive(i=>Math.min(selection.length-1,i+1))}>下一份</RareButton>
    </div>
   </div>
  </div>
  <div className="dialog-actions">
   <RareButton type="button" disabled={busy} onClick={onClose}>关闭</RareButton>
   <RareButton type="button" className="primary" loading={busy} disabled={!item} onClick={()=>void openSelected()}>
    打开当前打印预览
   </RareButton>
  </div>
 </Dialog>;
}
