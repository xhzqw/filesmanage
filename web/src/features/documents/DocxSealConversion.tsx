import {useState} from "react";
import {useNavigate} from "react-router-dom";
import {RareButton} from "../../shared/ui/rare";
import {toast} from "../../shared/ui/feedback";
import {fileApi} from "./api";
import {errorCopy} from "../../shared/errors";
import "./docxSealConversion.css";

export function DocxSealConversion({fileId,versionSeq,sha,name}:{fileId:string;versionSeq:number;sha:string;name:string}){
 const navigate=useNavigate();
 const[busy,setBusy]=useState(false);
 const[error,setError]=useState("");
 async function convert(){
  if(busy)return;
  setBusy(true);setError("");
  try{
   const data=await fileApi.convertDOCXForSigning(fileId,versionSeq,sha,crypto.randomUUID());
   toast.success("PDF 副本已生成，已进入签章");
   navigate("/preview/"+encodeURIComponent(data.fileId)+"?tab=seals");
  }catch(cause){setError(errorCopy(cause,"PDF 转换失败，请核实下载和上传权限"))}
  finally{setBusy(false)}
 }
 return <div className="docx-seal-conversion">
  <div className="docx-seal-conversion-meta"><strong>签名 / 盖章</strong>
   <p>DOCX 先转换为 PDF，原始 Word 文件保持不变。转换后即可选页、放置签章和输入密码确认。</p>
   <small title={name}>源文件：{name} · v{versionSeq}</small>
  </div>
  <RareButton type="button" className="primary" loading={busy} onClick={()=>void convert()}>
   转换为 PDF 并继续签章
  </RareButton>
  {error&&<p role="alert" className="notice error">{error}</p>}
 </div>;
}
