import {RareButton,RareInput} from "../shared/ui/rare";
import {useState,type FormEvent} from "react";
import type {User} from "../entities/user/model";
import {authApi} from "../features/auth/api";
import {BrandLogo} from "../shared/ui/AppShell";

export function FirstSignIn({onSuccess,onExit}:{onSuccess:(u:User)=>void;onExit:()=>void}) {
  const [currentValue,setCurrent]=useState("");
  const [newValue,setNew]=useState("");
  const [verify,setVerify]=useState("");
  const [message,setMessage]=useState("");
  const [busy,setBusy]=useState(false);
  async function submit(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if(newValue.length<16) {setMessage("新凭据至少需要 16 个字符");return;}
    if(newValue!==verify) {setMessage("两次填写不一致");return;}
    setBusy(true);setMessage("");
    try{onSuccess(await authApi.updateCredential(currentValue,newValue));}
    catch{setMessage("修改失败，请核对原凭据并重试");}
    finally{setBusy(false);}
  }
  return <main className="login-bg">
    <div className="bg-glow bg-glow-blue" aria-hidden="true"/>
    <div className="bg-glow bg-glow-amber" aria-hidden="true"/>
    <section className="login-card" aria-label="首次登录安全设置">
      <div className="brand-lockup">
        <BrandLogo size={48} className="login-logo"/>
        <h1 className="system-name">中晟生物科技</h1>
      </div>
      <h2 className="page-purpose">首次登录安全设置</h2>
      <p>首次登录必须更新初始凭据，完成前不能访问业务目录。</p>
      <form onSubmit={submit}>
        <label htmlFor="previous">原凭据</label>
        <RareInput type="password" id="previous" autoComplete="current-password" value={currentValue} onChange={e=>setCurrent(e.target.value)} required/>
        <label htmlFor="replacement">新凭据（至少16字符）</label>
        <RareInput type="password" id="replacement" autoComplete="new-password" value={newValue} onChange={e=>setNew(e.target.value)} minLength={16} required/>
        <label htmlFor="confirmation">再次填写新凭据</label>
        <RareInput type="password" id="confirmation" autoComplete="new-password" value={verify} onChange={e=>setVerify(e.target.value)} required/>
        {message&&<p role="alert" className="error">{message}</p>}
        <RareButton className="primary" type="submit" disabled={busy}>{busy?"正在保存…":"更新并进入系统"}</RareButton>
      </form>
      <RareButton className="secondary-action" type="button" onClick={onExit}>退出登录</RareButton>
    </section>
  </main>;
}
