import {useEffect,useRef,useState,type FormEvent} from "react";
import {RareButton,RareInput,RareNotice} from "../shared/ui/rare";
import type {User} from "../entities/user/model";
import {authApi} from "../features/auth/api";
import {ApiError} from "../shared/http";
import {BrandLogo} from "../shared/ui/AppShell";
import "./login-redesign.css";

const REMEMBER_KEY="filesmanage.remember-login";
const CLOSE_DELAY_MS=900;

export function Login({onSuccess}:{onSuccess:(user:User)=>void}){
 const [login,setLogin]=useState(()=>localStorage.getItem(REMEMBER_KEY)??"");
 const [password,setPassword]=useState("");
 const [busy,setBusy]=useState(false);
 const [error,setError]=useState("");
 const [open,setOpen]=useState(false);
 const zone=useRef<HTMLDivElement>(null);
 const entry=useRef<HTMLButtonElement>(null);
 const closeTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const focusOnOpen=useRef(false);
 const suppressHover=useRef(false);
 const pointerInside=useRef(false);

 function cancelClose(){
  if(closeTimer.current!==null){clearTimeout(closeTimer.current);closeTimer.current=null;}
 }
 function expand(focus=false){
  cancelClose();focusOnOpen.current=focus;suppressHover.current=false;setOpen(true);
 }
 function collapse(){
  cancelClose();setOpen(false);setError("");
 }
 function collapseAndReturnFocus(){
  suppressHover.current=true;
  collapse();
  // Do not focus the button while it still has visibility:hidden from the
  // expanded state; let React commit the collapsed view first.
  // Blur the focused control and restore focus once the entry is available.
  if(document.activeElement instanceof HTMLElement)document.activeElement.blur();
  window.setTimeout(()=>entry.current?.focus({preventScroll:true}),90);
 }
 function delayedCollapse(){
  cancelClose();
  // Focusing a control is not a permanent lock: previous logic trapped the
  // card open after any click, including a click on the submit button.
  if(busy)return;
  closeTimer.current=setTimeout(()=>{
   closeTimer.current=null;
   if(pointerInside.current)return;
   const active=document.activeElement;
   if(active instanceof HTMLElement&&zone.current?.contains(active))active.blur();
   setOpen(false);
  },CLOSE_DELAY_MS);
 }
 useEffect(()=>()=>{if(closeTimer.current!==null)clearTimeout(closeTimer.current);},[]);
 useEffect(()=>{
  if(!open||!focusOnOpen.current)return;
  focusOnOpen.current=false;
  const timer=window.setTimeout(()=>document.getElementById("login-account")?.focus(),180);
  return ()=>window.clearTimeout(timer);
 },[open]);
 async function submit(e:FormEvent<HTMLFormElement>){
  e.preventDefault();if(busy)return;cancelClose();setOpen(true);setBusy(true);setError("");
  try{
   const user=await authApi.login(login,password);
   localStorage.setItem(REMEMBER_KEY,login);
   onSuccess(user);
  }catch(cause){
   if(cause instanceof ApiError&&cause.code==="E_RATE_LIMIT"){
    setError(`登录尝试过于频繁，请约 ${cause.retryAfterSeconds??60} 秒后重试。`);
   }else if(cause instanceof ApiError&&cause.code==="E_NETWORK"){
    setError("网络连接失败，请检查连接后重试。");
   }else if(cause instanceof ApiError&&cause.code==="E_INVALID_CREDENTIALS"){
    setError("账号或密码错误。");
   }else setError("登录暂不可用，请稍后重试。");
  }finally{setBusy(false);}
 }
 return <main className="login-minimal"
  onPointerDown={e=>{
   if(open&&!zone.current?.contains(e.target as Node)){
    suppressHover.current=true;collapse();
   }
  }}
  onKeyDown={e=>{
   if(e.key==="Escape"&&open){
    e.preventDefault();
    collapseAndReturnFocus();
   }
  }}>
  <header className="login-minimal-brand">
   <BrandLogo size={32} className="login-minimal-logo" transparent/>
   <h1>中晟生物科技</h1>
  </header>
  <div ref={zone} className={`login-reveal-zone${open?" is-expanded":""}`}
   onPointerEnter={e=>{
    if(e.pointerType==="touch")return;
    pointerInside.current=true;
    cancelClose();
    if(!suppressHover.current)expand();
   }}
   onPointerLeave={e=>{
    if(e.pointerType==="touch")return;
    pointerInside.current=false;
    suppressHover.current=false;
    if(open)delayedCollapse();
   }}
   onKeyDownCapture={e=>{
    // Keep an actively typed form usable even when the mouse is elsewhere.
    if(!pointerInside.current&&open&&e.key!=="Escape")delayedCollapse();
   }}
   onFocusCapture={cancelClose}
   onBlurCapture={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))delayedCollapse();}}>
   <RareButton ref={entry} type="button" className="login-entry"
    aria-label="登录" aria-expanded={open} aria-controls="login-panel"
    tabIndex={open?-1:0}
    onFocus={()=>{if(!open&&!suppressHover.current)expand(true);}}
    onClick={()=>expand(true)}>登录</RareButton>
   <section id="login-panel" className="login-panel" aria-hidden={!open}>
    <h2>登陆</h2>
    <form onSubmit={submit} autoComplete="on">
     <label htmlFor="login-account">账号</label>
     <RareInput id="login-account" autoComplete="username" required tabIndex={open?0:-1}
      placeholder="请输入账号 / 工号" value={login} onChange={e=>setLogin(e.target.value)}/>
     <label htmlFor="login-password">密码</label>
     <RareInput id="login-password" type="password" autoComplete="current-password"
      required invalid={Boolean(error)} tabIndex={open?0:-1}
      placeholder="请输入登录密码" value={password} onChange={e=>setPassword(e.target.value)}/>
     {error&&<RareNotice tone="danger">{error}</RareNotice>}
     <RareButton className="login-submit" tone="primary" type="submit"
      tabIndex={open?0:-1} loading={busy}>登录</RareButton>
    </form>
   </section>
  </div>
 </main>;
}
