import {create} from "zustand";
import {errorCode,errorCopy} from "../errors";

export type ToastTone="info"|"success"|"warning"|"danger"|"loading";
export type ToastItem={id:number;tone:ToastTone;text:string;duration:number};
export const useToastStore=create<{items:ToastItem[]}>(()=>({items:[]}));
let sequence=0;

function publish(tone:ToastTone,text:string,duration=tone==="danger"?7000:tone==="loading"?0:4000){
 const copy=text.trim();
 if(!copy)return -1;
 let id=++sequence;
 useToastStore.setState(state=>{
  // Repeated callbacks/polling must not flood the viewport with identical messages.
  const prior=state.items.find(item=>item.tone===tone&&item.text===copy);
  if(prior){id=prior.id;return state;}
  return {items:[...state.items.slice(-3),{id,tone,text:copy,duration}]};
 });
 return id;
}

export const toast={
 info:(text:string)=>publish("info",text),
 success:(text:string)=>publish("success",text),
 warning:(text:string)=>publish("warning",text,6000),
 error:(text:string)=>publish("danger",text),
 loading:(text:string)=>publish("loading",text),
 dismiss:(id:number)=>useToastStore.setState(state=>({items:state.items.filter(item=>item.id!==id)})),
 clear:()=>useToastStore.setState({items:[]}),
 // Show pending feedback for slow writes only; always surface the final outcome.
 async track<T>(operation:()=>Promise<T>,copy:{loading:string;success:string;error:string|((error:unknown)=>string)}):Promise<T>{
  let pendingId=-1;
  const timer=setTimeout(()=>{pendingId=publish("loading",copy.loading);},450);
  try{
   const result=await operation();
   clearTimeout(timer);
   if(pendingId!==-1)toast.dismiss(pendingId);
   toast.success(copy.success);
   return result;
  }catch(error){
   clearTimeout(timer);
   if(pendingId!==-1)toast.dismiss(pendingId);
   // A dropped connection is not evidence the server rejected a write.
   if(errorCode(error)==="E_NETWORK")toast.warning("网络中断，操作结果未确认；请刷新记录核对后再重试");
   else toast.error(typeof copy.error==="function"?copy.error(error):errorCopy(error,copy.error));
   throw error;
  }
 },
};
