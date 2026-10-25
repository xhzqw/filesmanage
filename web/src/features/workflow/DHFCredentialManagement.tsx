import {useEffect,useRef,useState} from "react";
import {request} from "../../shared/http";
import {RareButton,RareInput,RareTextarea} from "../../shared/ui/rare";
import {errorCopy} from "../../shared/errors";
import "./dhfPilotInbox.css";

type Credential={id:string;signerId:string;keySha:string;status:string;
 validFrom:string;expiresAt:string;registeredBy:string;authorizationRef:string;trialOnly:boolean};
type CredentialPage={items:Credential[];canManage:boolean;trialOnly:boolean};
type Result={id:string;credentialId:string;replayed:boolean;trialOnly:boolean};
type EventKind="activate"|"suspend"|"revoke"|"replace";
const stateLabels:Record<string,string>={
 unactivated:"待激活",activate:"已激活",suspend:"已暂停",revoke:"已撤销",replace:"已替换",
};
const eventLabels:Record<EventKind,string>={activate:"激活 / 恢复",suspend:"暂停",revoke:"永久撤销",replace:"标记已替换"};
const makeKey=()=>Array.from(crypto.getRandomValues(new Uint8Array(16)),
 n=>n.toString(16).padStart(2,"0")).join("");

export function DHFCredentialManagement(){
 const [page,setPage]=useState<CredentialPage|null>(null);
 const [loading,setLoading]=useState(true);
 const [loadError,setLoadError]=useState("");
 const [refresh,setRefresh]=useState(0);
 const [selected,setSelected]=useState<string|null>(null);
 const [mode,setMode]=useState<"detail"|"register">("detail");
 const [signerId,setSignerId]=useState("");
 const [publicKey,setPublicKey]=useState("");
 const [authorizationRef,setAuthorizationRef]=useState("");
 const [validFrom,setValidFrom]=useState("");
 const [expiresAt,setExpiresAt]=useState("");
 const [eventKind,setEventKind]=useState<EventKind>("suspend");
 const [reason,setReason]=useState("");
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [message,setMessage]=useState("");
 const [error,setError]=useState("");
 const pending=useRef<{payload:string;key:string}|null>(null);
 useEffect(()=>{
  let alive=true;setLoading(true);setLoadError("");
  void request<CredentialPage>("/workbench/dhf/credentials")
   .then(data=>{if(alive)setPage(data)})
   .catch(err=>{if(alive)setLoadError(errorCopy(err,"签署凭证状态读取失败"))})
   .finally(()=>{if(alive)setLoading(false)});
  return()=>{alive=false};
 },[refresh]);
 const rows=page?.items??[];
 const active=rows.find(item=>item.id===selected)??rows[0];
 const canManage=Boolean(page?.canManage);
 function setChanged(){pending.current=null;setError("");}
 function choose(id:string){setSelected(id);setMode("detail");setPassword("");setReason("");setChanged();}
 async function register(){
  if(!canManage||busy||!signerId.trim()||!publicKey.trim()||
   !authorizationRef.trim()||!validFrom||!expiresAt||!password)return;
  const payload=JSON.stringify({signerId:signerId.trim(),publicKeyBase64:publicKey.trim(),
   authorizationRef:authorizationRef.trim(),validFrom:new Date(validFrom).toISOString(),
   expiresAt:new Date(expiresAt).toISOString()});
  await submit("/workbench/dhf/credentials",payload,"登记",()=>{setPublicKey("");setPassword("");setMode("detail");});
 }
 async function transition(){
  if(!canManage||busy||!active||reason.trim().length<8||!password)return;
  const payload=JSON.stringify({kind:eventKind,reason:reason.trim()});
  await submit("/workbench/dhf/credentials/"+encodeURIComponent(active.id)+"/events",
   payload,eventLabels[eventKind],()=>{setReason("");setPassword("");});
 }
 async function submit(url:string,payload:string,label:string,onSuccess:()=>void){
  if(busy)return;setBusy(true);setError("");setMessage("");
  try {
   if(!pending.current||pending.current.payload!==url+":"+payload)
    pending.current={payload:url+":"+payload,key:makeKey()};
   const result=await request<Result>(url,{method:"POST",body:JSON.stringify({
    ...JSON.parse(payload) as Record<string,unknown>,password,idempotencyKey:pending.current.key,
   })});
   if(!result.trialOnly||!result.credentialId)throw Error("试点操作未被确认");
   pending.current=null;
   onSuccess();
   setMessage(label+(result.replayed?"：已核对原记录":"：已写入不可变记录")+"，不代表正式企业电子签署授权。");
   setRefresh(value=>value+1);
  }catch(err){setError(errorCopy(err,label+"失败，请先核对独立授权、身份及凭证状态"))}
  finally{setBusy(false);setPassword("")}
 }
 return <div className="dhf-pilot-shell">
  <section className="dhf-pilot-list" aria-label="试点签署凭证清单">
   <div className="dhf-pilot-toolbar">
    <strong>试点签署凭证</strong>
    <RareButton type="button" onClick={()=>setRefresh(n=>n+1)}>刷新</RareButton>
   </div>
   {canManage?<div className="dhf-pilot-filter">
    <RareButton type="button" onClick={()=>{setMode("register");setPassword("");setChanged();}}>登记公钥凭证</RareButton>
   </div>:null}
   {loading?<div className="dhf-pilot-empty">正在核对管理授权…</div>:
    loadError?<div className="dhf-pilot-empty" role="alert">{loadError}</div>:
    !canManage?<div className="dhf-pilot-empty">当前账号没有独立审批的试点凭证操作员授权。管理员身份不自动授予此权限。</div>:
    rows.length===0?<div className="dhf-pilot-empty">尚无由你登记的试点凭证</div>:
    <div className="dhf-pilot-scroll">{rows.map(item=><RareButton type="button" key={item.id}
     className={"dhf-pilot-task"+(active?.id===item.id&&mode==="detail"?" is-selected":"")}
     onClick={()=>choose(item.id)} aria-pressed={active?.id===item.id&&mode==="detail"}>
     <strong className="dhf-pilot-task-title">{item.signerId}</strong>
     <span className="dhf-pilot-task-meta">{stateLabels[item.status]??item.status} · {item.id}</span>
     <span className="dhf-pilot-task-date">至 {new Date(item.expiresAt).toLocaleString("zh-CN")}</span>
    </RareButton>)}</div>}
  </section>
  <section className="dhf-pilot-detail" aria-label="签署凭证详情与登记">
   {message?<div className="dhf-pilot-feedback" role="status">{message}</div>:null}
   {!canManage?<div className="dhf-pilot-empty">凭证管理须先经独立授权；管理员身份本身不授予操作权限。</div>:
    <div className="dhf-pilot-content">
     {mode==="register"?<>
      <span className="dhf-pilot-overline">DHF / 凭证管理 · 试点</span>
      <h2>登记签署公钥</h2>
      <p>仅登记外部独立保管的 Ed25519 公钥。此操作不签发企业 CA 证书，也不接收或保存私钥。</p>
      <div className="dhf-pilot-opinion">
       <label>签署人用户 ID <RareInput value={signerId} onChange={e=>{setSignerId(e.target.value);setChanged();}}/></label>
       <label>Ed25519 公钥（Base64）<RareTextarea rows={2} value={publicKey}
        onChange={e=>{setPublicKey(e.target.value);setChanged();}}/></label>
       <label>独立授权引用 <RareInput value={authorizationRef}
        onChange={e=>{setAuthorizationRef(e.target.value);setChanged();}}/></label>
       <label>有效起始 <RareInput type="datetime-local" value={validFrom}
        onChange={e=>{setValidFrom(e.target.value);setChanged();}}/></label>
       <label>有效截止 <RareInput type="datetime-local" value={expiresAt}
        onChange={e=>{setExpiresAt(e.target.value);setChanged();}}/></label>
       <label>本人密码再认证 <RareInput type="password" autoComplete="off" value={password}
        onChange={e=>setPassword(e.target.value)}/></label>
       {error?<p role="alert">{error}</p>:null}
       <div className="dhf-pilot-actions">
        <RareButton type="button" disabled={busy||!password||!publicKey||!signerId||!authorizationRef||!validFrom||!expiresAt}
         onClick={()=>void register()}>{busy?"正在登记…":"登记试点凭证"}</RareButton>
        <RareButton type="button" onClick={()=>{setMode("detail");setChanged();}}>取消</RareButton>
       </div>
      </div>
     </>:active?<>
      <span className="dhf-pilot-overline">DHF / 凭证管理 · 试点</span>
      <h2>{active.signerId}</h2>
      <dl><div><dt>状态</dt><dd>{stateLabels[active.status]??active.status}</dd></div>
       <div><dt>授权引用</dt><dd>{active.authorizationRef}</dd></div>
       <div><dt>起始时间</dt><dd>{new Date(active.validFrom).toLocaleString("zh-CN")}</dd></div>
       <div><dt>截止时间</dt><dd>{new Date(active.expiresAt).toLocaleString("zh-CN")}</dd></div>
      </dl>
      <section className="dhf-pilot-evidence"><h3>原始公钥指纹</h3>
       <div className="dhf-pilot-evidence-item"><code>{active.keySha}</code>
        <span>撤销后旧签名仍可按原公钥独立验签；撤销凭证禁止创建新候选。</span></div>
      </section>
      {active.status!=="revoke"&&active.status!=="replace"?<div className="dhf-pilot-opinion">
       <h3>不可变凭证状态事件</h3>
       <div className="dhf-pilot-actions">{(["activate","suspend","revoke","replace"] as EventKind[]).map(kind=>
        <RareButton type="button" key={kind} onClick={()=>{setEventKind(kind);setChanged();}}
         disabled={kind==="activate"?active.status==="activate":active.status!=="activate"&&active.status!=="suspend"}>
         {eventKind===kind?"✓ ":""}{eventLabels[kind]}
        </RareButton>)}</div>
       <RareTextarea rows={3} value={reason} onChange={e=>{setReason(e.target.value);setChanged();}}
        placeholder="记录不少于 8 字的独立操作依据和撤销/替换原因"/>
       <label>再次输入本人密码 <RareInput type="password" autoComplete="off" value={password}
        onChange={e=>setPassword(e.target.value)}/></label>
       {error?<p role="alert">{error}</p>:null}
       <RareButton type="button" disabled={busy||!password||reason.trim().length<8}
        onClick={()=>void transition()}>{busy?"正在提交…":"记录"+eventLabels[eventKind]}</RareButton>
      </div>:<p>该凭证为不可逆终态，不能再次激活。</p>}
     </>:<div className="dhf-pilot-empty">选择一条凭证，或登记经独立授权的新公钥。</div>}
     <p className="dhf-pilot-disclaimer">所有操作仅为试点凭证账本；不得据此执行正式 Stage Gate 接受、合规数字签发或 CDW 受控分发。</p>
    </div>}
  </section>
 </div>;
}
