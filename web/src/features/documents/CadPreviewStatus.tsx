import {useEffect,useState} from "react";
import {RareButton} from "../../shared/ui/rare";
import {fileApi} from "./api";
import {errorCopy} from "../../shared/errors";

type Derivative=Awaited<ReturnType<typeof fileApi.derivativeStatus>>;
export function CadPreviewStatus({fileId}:{fileId:string}){
 const [info,setInfo]=useState<Derivative|null>(null);
 const [status,setStatus]=useState<"loading"|"ready"|"failed">("loading");
 const [failure,setFailure]=useState("");
 const [reload,setReload]=useState(0);
 useEffect(()=>{
  let active=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  setStatus("loading");
  setInfo(null);
  const poll=async()=>{
   try{
    const data=await fileApi.derivativeStatus(fileId);
    if(!active)return;
    setInfo(data);setStatus("ready");
    if(data.found&&(data.state==="queued"||data.state==="running")){
     timer=setTimeout(()=>{
      if(document.visibilityState==="hidden"){
       timer=setTimeout(poll,3500);
      }else{void poll();}
     },3500);
    }
   }catch(error){
    if(active){setFailure(errorCopy(error,"无法读取转换状态"));setStatus("failed");}
   }
  };
  void poll();
  return()=>{active=false;if(timer!==undefined)clearTimeout(timer);};
 },[fileId,reload]);
 const state=info?.state;
 const unsupported=info?.class==="licensed"||info?.class==="unverified";
 return <div className="file-unsupported" role="status">
  <strong>三维模型预览</strong>
  {status==="loading"&&<p>正在查询模型状态…</p>}
  {status==="failed"&&<p>{failure}</p>}
  {status==="ready"&&<p>{unsupported?"当前格式需要额外的转换能力，尚不能直接生成三维预览。":
   !info?.found?"尚未生成模型预览。打开 3D 查看器后可请求转换。":
   state==="queued"?"转换任务正在排队，可稍后刷新状态。":
   state==="running"?"服务器正在转换模型，可稍后刷新状态。":
   state==="failed"?"模型转换失败："+(info.errorCode??"请检查源文件或转换器"):
   state==="ready"||state==="completed"||state==="succeeded"?"模型已就绪，可以打开 3D 查看器。":
   "当前转换状态："+(state??"未知")}</p>}
  <div className="preview-reader-dock" role="group" aria-label="模型预览状态工具">
   <RareButton type="button" onClick={()=>setReload(x=>x+1)}>刷新状态</RareButton>
  </div>
 </div>;
}
