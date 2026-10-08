import {useState,type FormEvent} from "react";
import type {User} from "../entities/user/model";
import {authApi} from "../features/auth/api";

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
    <section className="login-card" aria-label="首次登录安全设置">
      <span className="organization">中晟生物科技</span>
      <h1>首次登录安全设置</h1>
      <p>首次登录必须更新初始凭据，完成前不能访问业务目录。</p>
      <form onSubmit={submit}>
        <label htmlFor="previous">原凭据</label>
        <input type="password" id="previous" autoComplete="current-password" value={currentValue} onChange={e=>setCurrent(e.target.value)} required/>
        <label htmlFor="replacement">新凭据（至少16字符）</label>
        <input type="password" id="replacement" autoComplete="new-password" value={newValue} onChange={e=>setNew(e.target.value)} minLength={16} required/>
        <label htmlFor="confirmation">再次填写新凭据</label>
        <input type="password" id="confirmation" autoComplete="new-password" value={verify} onChange={e=>setVerify(e.target.value)} required/>
        {message&&<p role="alert" className="error">{message}</p>}
        <button className="primary" type="submit" disabled={busy}>{busy?"正在保存…":"更新并进入系统"}</button>
      </form>
      <button className="secondary-action" type="button" onClick={onExit}>退出登录</button>
    </section>
  </main>;
}
