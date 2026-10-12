import {create} from "zustand";
import {errorCode,errorCopy} from "../errors";

export type ToastTone="info"|"success"|"warning"|"danger"|"loading";
export type ToastItem={id:number;tone:ToastTone;text:string;duration:number;revision:number;issuedAt:number};
export const useToastStore=create<{items:ToastItem[]}>(()=>({items:[]}));
let sequence=0;
let owner="";
let identityEpoch=0;
const MAX_VISIBLE=4;
const DUPLICATE_WINDOW_MS=900;
const priority:Record<ToastTone,number>={info:0,success:0,loading:1,warning:2,danger:3};
function durationOf(tone:ToastTone){return tone==="loading"?0:tone==="danger"?7000:tone==="warning"?6000:4000;}

function publish(tone:ToastTone,text:string,{dedupe=true}:{dedupe?:boolean}={}){
 const copy=text.trim();
 if(!copy)return -1;
 const now=Date.now();
 let id=++sequence;
 useToastStore.setState(state=>{
  // Coalesce near-simultaneous standalone notices, never parallel loading operations.
  const prior=dedupe&&tone!=="loading"?state.items.find(item=>item.tone===tone&&item.text===copy&&now-item.issuedAt<DUPLICATE_WINDOW_MS):undefined;
  if(prior){
   id=prior.id;
   return {items:state.items.map(item=>item.id===id?{...item,revision:item.revision+1,issuedAt:now,duration:durationOf(tone)}:item)};
  }
  const entry:ToastItem={id,tone,text:copy,duration:durationOf(tone),revision:0,issuedAt:now};
  if(state.items.length<MAX_VISIBLE)return {items:[...state.items,entry]};
  // Keep serious warnings/errors visible when routine successes arrive.
  let candidate=0;
  for(let i=1;i<state.items.length;i++)
   if(priority[state.items[i]!.tone]<priority[state.items[candidate]!.tone])candidate=i;
  if(priority[tone]<priority[state.items[candidate]!.tone])return state;
  return {items:[...state.items.filter((_,i)=>i!==candidate),entry]};
 });
 return id;
}

function finish(id:number,tone:ToastTone,text:string){
 const copy=text.trim();
 if(!copy){toast.dismiss(id);return;}
 let found=false;
 useToastStore.setState(state=>{
  if(!state.items.some(item=>item.id===id))return state;
  found=true;
  return {items:state.items.map(item=>item.id===id?{...item,tone,text:copy,duration:durationOf(tone),revision:item.revision+1,issuedAt:Date.now()}:item)};
 });
 if(!found)publish(tone,copy,{dedupe:false});
}

export const toast={
 info:(text:string)=>publish("info",text),
 success:(text:string)=>publish("success",text),
 warning:(text:string)=>publish("warning",text),
 error:(text:string)=>publish("danger",text),
 loading:(text:string)=>publish("loading",text,{dedupe:false}),
 dismiss:(id:number)=>useToastStore.setState(state=>({items:state.items.filter(item=>item.id!==id)})),
 // Invalidate notices from already-running operations after identity changes.
 clear:()=>{identityEpoch++;useToastStore.setState({items:[]});},
 bindOwner:(userId:string)=>{if(owner!==userId){owner=userId;toast.clear();}},
 // Show pending feedback for slow writes only; always surface the final outcome.
 async track<T>(operation:()=>Promise<T>,copy:{loading:string;success:string;error:string|((error:unknown)=>string);errorToast?:boolean}):Promise<T>{
  const epoch=identityEpoch;
  let pendingId=-1;
  const timer=setTimeout(()=>{if(epoch===identityEpoch)pendingId=publish("loading",copy.loading,{dedupe:false});},450);
  try{
   const result=await operation();
   clearTimeout(timer);
   if(epoch===identityEpoch){
    if(pendingId!==-1)finish(pendingId,"success",copy.success);
    else publish("success",copy.success,{dedupe:false});
   }
   return result;
  }catch(error){
   clearTimeout(timer);
   if(epoch===identityEpoch){
    const unknown=errorCode(error)==="E_NETWORK";
    const tone=unknown?"warning":"danger";
    const message=unknown?"网络中断，操作结果未确认；请刷新记录核对后再重试"
     :typeof copy.error==="function"?copy.error(error):errorCopy(error,copy.error);
    if(copy.errorToast===false){if(pendingId!==-1)toast.dismiss(pendingId);}
    else if(pendingId!==-1)finish(pendingId,tone,message);
    else publish(tone,message,{dedupe:false});
   }
   throw error;
  }
 },
};
