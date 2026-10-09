import {useState,type FormEvent} from "react";
import type {User} from "../entities/user/model";
import {authApi} from "../features/auth/api";
import {BrandLogo} from "../shared/ui/AppShell";
export function Login({onSuccess}:{onSuccess:(user:User)=>void}){
 const [login,setLogin]=useState("");const[password,setPassword]=useState("");
 const[busy,setBusy]=useState(false);const[error,setError]=useState("");
 async function submit(e:FormEvent<HTMLFormElement>){e.preventDefault();setBusy(true);setError("");
  try{onSuccess(await authApi.login(login,password));}catch{setError("账号或密码错误，或服务暂不可用");}finally{setBusy(false);}
 }
 return <main className="login-bg"><div className="login-card">
  <BrandLogo size={88} className="login-logo"/>
  <span className="organization">中晟生物科技</span><h1>文档管理系统</h1>
  <p>机械设计与工程文件的安全协作系统</p>
  <form onSubmit={submit}><label htmlFor="username">账号</label>
  <input id="username" autoComplete="username" required value={login} onChange={e=>setLogin(e.target.value)}/>
  <label htmlFor="password">密码</label>
  <input id="password" type="password" required autoComplete="current-password" value={password} onChange={e=>setPassword(e.target.value)}/>
  {error&&<div role="alert" className="error">{error}</div>}
  <button className="primary" disabled={busy} type="submit">{busy?"验证中…":"登录"}</button></form>
 </div></main>;
}
