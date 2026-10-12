import {useEffect,useRef,useState,type FormEvent} from "react";
import {approvalPolicyApi,type FolderApprovalPolicy} from "../../entities/approval/api";
import {errorCode,errorCopy} from "../../shared/errors";
import {toast} from "../../shared/ui/feedback";
import {observeWorkspaceChange} from "../../shared/resourceSync";

type LoadState="loading"|"ready"|"failed";
type Notice={message:string;error:boolean};
type PolicySnapshot={folderId:string;ids:string[];enabled:boolean;configured:boolean};

function normalizePolicy(folderId:string,policy:FolderApprovalPolicy):PolicySnapshot{
 const ids=policy.approverIds?.length?policy.approverIds:[policy.approverId??""];
 return {folderId,ids,enabled:policy.configured&&policy.enabled===true,configured:policy.configured};
}

/** Read/write state is scoped to the folder; a late response cannot change another editor.
 * Network-uncertain writes are never retried until a successful server read. */
export function useApprovalPolicyEditor(folderId:string){
 const activeFolder=useRef(folderId);activeFolder.current=folderId;
 const [status,setStatus]=useState<LoadState>("ready");
 const [refresh,setRefresh]=useState(0);
 const [snapshot,setSnapshot]=useState<PolicySnapshot|null>(null);
 const [approverIds,setApproverIds]=useState<string[]>([""]);
 const [enabled,setEnabled]=useState(false);
 const [confirmRemove,setConfirmRemove]=useState(false);
 const [notice,setNotice]=useState<Notice|null>(null);
 const [unknownFolder,setUnknownFolder]=useState("");
 const unknownFolders=useRef(new Set<string>());
 const writeLock=useRef<{folderId:string}|null>(null);
 const [writingFolder,setWritingFolder]=useState("");
 const [remoteChanged,setRemoteChanged]=useState(false);

 const current=snapshot?.folderId===folderId?snapshot:null;
 const configured=current?.configured??false;
 const busy=writingFolder===folderId&&folderId!=="";
 const unknown=unknownFolder===folderId||unknownFolders.current.has(folderId);
 const dirty=!!current&&(current.enabled!==enabled||current.ids.join("|")!==approverIds.join("|"));
 const protectedDraft=dirty||busy||unknown||remoteChanged;

 // Change folder, not refresh: replace local edit state and invalidate confirmations.
 useEffect(()=>{
  setSnapshot(null);setApproverIds([""]);setEnabled(false);
  setConfirmRemove(false);setNotice(null);setRemoteChanged(false);
  setUnknownFolder(unknownFolders.current.has(folderId)?folderId:"");
  if(!folderId){setStatus("ready");return;}
  setStatus("loading");
 },[folderId]);

 useEffect(()=>{
  if(!folderId)return;
  let live=true;
  setStatus("loading");
  approvalPolicyApi.get(folderId).then(policy=>{
   if(!live||activeFolder.current!==folderId)return;
   const next=normalizePolicy(folderId,policy);
   // A live invalidation is not permission to destroy a draft.
   if(snapshotRef.current?.folderId!==folderId||!dirtyRef.current){
    setSnapshot(next);setApproverIds(next.ids);setEnabled(next.enabled);
    setConfirmRemove(false);setRemoteChanged(false);
   }else{
    setRemoteChanged(true);
   }
   unknownFolders.current.delete(folderId);setUnknownFolder("");
   setStatus("ready");
  }).catch(error=>{
   if(!live||activeFolder.current!==folderId)return;
   setStatus("failed");
   setNotice({message:errorCopy(error,"读取审批策略失败"),error:true});
  });
  return()=>{live=false;};
 },[folderId,refresh]);

 const snapshotRef=useRef(snapshot);snapshotRef.current=snapshot;
 const dirtyRef=useRef(dirty);dirtyRef.current=protectedDraft;
 useEffect(()=>observeWorkspaceChange(()=>{
  if(dirtyRef.current){
   setRemoteChanged(true);
  }else{
   setRefresh(n=>n+1);
  }
 },["approval-policy","permissions"]),[]);

 function discardAndReload(){
  if(writeLock.current?.folderId===folderId)return;
  // Explicit discard of the draft is the only forced remote replacement.
  setSnapshot(null);setApproverIds([""]);setEnabled(false);
  setConfirmRemove(false);setRemoteChanged(false);setNotice(null);
  setRefresh(n=>n+1);
 }
 function editIds(ids:string[]){setApproverIds(ids);setConfirmRemove(false);setNotice(null);}
 function editEnabled(value:boolean){setEnabled(value);setConfirmRemove(false);setNotice(null);}

 async function performWrite(kind:"save"|"remove"){
  if(!folderId||status!=="ready"||writeLock.current||unknownFolders.current.has(folderId))return;
  const target=folderId;
  const values=[...approverIds],nextEnabled=enabled;
  writeLock.current={folderId:target};setWritingFolder(target);setNotice(null);setConfirmRemove(false);
  try{
   if(kind==="save")await approvalPolicyApi.set(target,values,nextEnabled);
   else await approvalPolicyApi.clear(target);
   if(activeFolder.current!==target)return;
   const next:PolicySnapshot=kind==="save"
    ?{folderId:target,ids:values,enabled:nextEnabled,configured:true}
    :{folderId:target,ids:[""],enabled:false,configured:false};
   setSnapshot(next);setApproverIds(next.ids);setEnabled(next.enabled);setRemoteChanged(false);
   toast.success(kind==="save"?"审批策略已保存":"审批策略已移除");
   setRefresh(n=>n+1);
  }catch(error){
   if(activeFolder.current!==target)return;
   if(errorCode(error)==="E_NETWORK"){
    unknownFolders.current.add(target);setUnknownFolder(target);
    setNotice({message:"网络中断，操作结果未确认。请重新读取服务端策略后再操作。",error:true});
    toast.warning("审批操作结果未确认，请核对后再重试");
   }else{
    const message=errorCopy(error,kind==="save"?"保存策略失败":"移除策略失败");
    setNotice({message,error:true});toast.error(message);
   }
  }finally{
   if(writeLock.current?.folderId===target)writeLock.current=null;
   if(activeFolder.current===target)setWritingFolder("");
  }
 }
 async function save(event:FormEvent<HTMLFormElement>,usersReady:boolean){
  event.preventDefault();
  if(!usersReady||!current||!approverIds.length||approverIds.some(id=>!id)
    ||new Set(approverIds).size!==approverIds.length)return;
  await performWrite("save");
 }
 async function remove(){
  if(!configured)return;
  await performWrite("remove");
 }

 return {status,approverIds,enabled,configured,busy,confirmRemove,notice,
  remoteChanged,unknown,dirty,protectedDraft,editingReady:status==="ready"&&!!current,
  setConfirmRemove,editIds,editEnabled,discardAndReload,save,remove};
}
