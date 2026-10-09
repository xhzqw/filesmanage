import {useState,type FormEvent} from "react";
import type {User} from "../entities/user/model";
import {authApi} from "../features/auth/api";
import {ApiError} from "../shared/http";
import {BrandLogo} from "../shared/ui/AppShell";
import {FluidOrb} from "../shared/ui/rare";

// "记住账号" keeps only the login id in this browser (never a credential);
// there is no auto-login and no self-service reset in this system.
const REMEMBER_KEY="filesmanage.remember-login";

export function Login({onSuccess}:{onSuccess:(user:User)=>void}){
 const [login,setLogin]=useState(()=>localStorage.getItem(REMEMBER_KEY)??"");
 const [password,setPassword]=useState("");
 const [remember,setRemember]=useState(()=>localStorage.getItem(REMEMBER_KEY)!==null);
 const [resetHint,setResetHint]=useState(false);
 const [busy,setBusy]=useState(false);const [error,setError]=useState("");
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();if(busy)return;setBusy(true);setError("");
  try{
   const user=await authApi.login(login,password);
   if(remember)localStorage.setItem(REMEMBER_KEY,login);else localStorage.removeItem(REMEMBER_KEY);
   onSuccess(user);
  }catch(cause){
   if(cause instanceof ApiError&&cause.code==="E_RATE_LIMIT"){
    setError(`登录尝试过于频繁，请约 ${cause.retryAfterSeconds??60} 秒后重试。`);
   }else if(cause instanceof ApiError&&cause.code==="E_NETWORK"){
    setError("网络连接失败，请检查连接后重试。");
   }else if(cause instanceof ApiError&&cause.code==="E_INVALID_CREDENTIALS"){
    setError("账号或密码错误。");
   }else{
    setError("登录暂不可用，请稍后重试。");
   }
  }finally{setBusy(false);}
 }
 return <main className="login-bg">
  <FluidOrb size={320} color="#02A0EA" style={{top:-90,left:-70}}/>
  <FluidOrb size={320} color="#174098" style={{bottom:-100,right:-80,opacity:.12}}/>
  <div className="login-card">
   <div className="brand-lockup">
    <BrandLogo size={48} className="login-logo"/>
    <h1 className="system-name">中晟生物科技</h1>
   </div>
   <form onSubmit={submit}>
    <label htmlFor="username">账号</label>
    <div className="input-wrap">
     <svg className="input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5"/></svg>
     <input id="username" autoComplete="username" required placeholder="请输入账号 / 工号" value={login} onChange={e=>setLogin(e.target.value)}/>
    </div>
    <label htmlFor="password">密码</label>
    <div className="input-wrap">
     <svg className="input-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>
     <input id="password" type="password" autoComplete="current-password" required placeholder="请输入登录密码" value={password} onChange={e=>setPassword(e.target.value)}/>
    </div>
    <div className="form-extras">
     <label className="remember"><input type="checkbox" checked={remember} onChange={e=>setRemember(e.target.checked)}/>记住账号</label>
     <button type="button" className="forgot" onClick={()=>setResetHint(v=>!v)}>忘记密码？</button>
    </div>
    {resetHint&&<p className="reset-hint">本系统不提供自助重置，请联系系统管理员处理。</p>}
    {error&&<div role="alert" className="error">{error}</div>}
    <button className="primary" disabled={busy} type="submit">{busy?"验证中…":"登录"}</button>
   </form>
  </div>
 </main>;
}
