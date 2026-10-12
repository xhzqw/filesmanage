import {GooeyNav,RareButton} from "./rare";
import {useContext,useEffect,useRef,useState,type ReactNode} from "react";
import {ShellAccessories} from "./ShellAccessories";
import {useLocation,useNavigate} from "react-router-dom";
import {Menu} from "./Menu";
import {FolderResourceIcon} from "./ResourceIcons";
import "./previewAutoHeader.css";
import "./globalUtilityDock.css";

// The shell only needs the display name; keeping the type structural avoids a
// shared -> entities dependency, which the architecture gate forbids.
type ShellUser={displayName:string;isAdmin?:boolean};

// DEC-14 brand shell: blue/white engineering palette and yellow folder SVG
// icons. A self-drawn icon must never stand in for the corporate mark — that
// is the imported BrandLogo's job (SPEC §18 BRAND-01/03).
export function FolderIcon({size=16}:{size?:number}){
 return <FolderResourceIcon size={size}/>;
}

// Local static asset per BRAND-07; square source, fixed box, never stretched.
export function BrandLogo({size,className}:{size:number;className:string}){
 return <img className={className} src="/assets/brand/logo-256.png" alt="中晟生物科技标志" width={size} height={size}/>;
}

const NAV=[
 {to:"/doc",label:"文档管理"},
 {to:"/search",label:"全局搜索"},
 {to:"/workspace",label:"共享/关注"},
 {to:"/stats",label:"统计"},
 {to:"/approvals",label:"审批"},
 {to:"/lifecycle",label:"生命周期"},
 {to:"/trash",label:"回收站"},
 {to:"/org",label:"组织与权限"},
];
const GOOEY_MAIN_ITEMS=NAV.map(item=>({label:item.label,href:item.to}));

// The single shell shared by every authenticated page (DESIGN-SYSTEM-v1 §3.1,
// VIS-09): one brand block, one navigation, one identity/exit area. Pages may
// add `actions` (page-specific header buttons) and a `product` subtitle; they
// must not draw their own header.
// The page path deliberately does NOT live here: a breadcrumb is a second
// navigation landmark, and VIS-11 asserts exactly one `header.header nav`, so
// the path is a docked strip at the top of the work area instead (see
// Documents.tsx and the .crumb-bar rule in theme.css).
export function AppShell({user,onLogout,product,actions,children}:{user:ShellUser;onLogout:()=>void;product?:string;actions?:ReactNode;children:ReactNode}){
 const[open,setOpen]=useState(false);
 const[accountOpen,setAccountOpen]=useState(false);
 const accountRef=useRef<HTMLButtonElement>(null);
 const navToggleRef=useRef<HTMLButtonElement>(null);
 const previewHeaderRef=useRef<HTMLElement>(null);
 const revealRef=useRef<HTMLButtonElement>(null);
 const hideHeaderTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
 const[previewHeaderOpen,setPreviewHeaderOpen]=useState(false);
 const navigate=useNavigate();
 const pathname=useLocation().pathname;
 const previewRoute=pathname.startsWith("/preview/");
 function cancelHeaderHide(){
  if(hideHeaderTimer.current!==null){clearTimeout(hideHeaderTimer.current);hideHeaderTimer.current=null}
 }
 function showPreviewHeader(){
  cancelHeaderHide();setPreviewHeaderOpen(true);
 }
 function schedulePreviewHeaderHide(){
  cancelHeaderHide();
  hideHeaderTimer.current=setTimeout(()=>{
   hideHeaderTimer.current=null;
   if(previewHeaderRef.current?.contains(document.activeElement))return;
   if(revealRef.current===document.activeElement&&revealRef.current?.matches(":focus-visible"))return;
   setPreviewHeaderOpen(false);setAccountOpen(false);
  },320);
 }
 useEffect(()=>{
  cancelHeaderHide();setPreviewHeaderOpen(false);setAccountOpen(false);
  return cancelHeaderHide;
 },[previewRoute,pathname]);
 // Keep the main navigation tied to actual routes, including browser
 // back/forward; preview and account subpages have no misleading active tile.
 const activeNav=NAV.findIndex(item=>item.to===pathname);
 const notificationSlot=useContext(ShellAccessories);
 // Once the collapsed navigation opens, keyboard focus must enter the links,
 // otherwise Escape remains on the toggle and cannot close the menu.
 useEffect(()=>{
  if(open)document.querySelector<HTMLAnchorElement>("#shell-main-navigation a[href]")?.focus();
 },[open]);

 return <div className={"shell"+(previewRoute?" shell-preview-autoheader":"")}
  onPointerDownCapture={event=>{
   if(!previewRoute||event.pointerType==="mouse"||!previewHeaderOpen)return;
   const target=event.target as HTMLElement;
   if(!target.closest(".header, .preview-header-hotzone")){
    cancelHeaderHide();setPreviewHeaderOpen(false);setAccountOpen(false);
   }
  }}>
  {previewRoute&&<div className="preview-header-hotzone"
   onPointerEnter={event=>{if(event.pointerType==="mouse"||event.pointerType==="pen")showPreviewHeader()}}
   onPointerLeave={schedulePreviewHeaderHide}>
   <button ref={revealRef} type="button" className="preview-header-reveal"
    aria-label="显示系统顶部菜单" aria-controls="shell-main-navigation"
    aria-expanded={previewHeaderOpen}
    onFocus={showPreviewHeader} onClick={showPreviewHeader}
    onKeyDown={event=>{if(event.key==="Escape"){event.preventDefault();cancelHeaderHide();setPreviewHeaderOpen(false);event.currentTarget.blur()}}}>
    <span aria-hidden="true"/>
   </button>
  </div>}
  <header ref={previewHeaderRef} className={"header"+(previewRoute&&previewHeaderOpen?" is-preview-header-open":"")}
   onPointerEnter={event=>{if(previewRoute&&(event.pointerType==="mouse"||event.pointerType==="pen"))showPreviewHeader()}}
   onPointerLeave={()=>{if(previewRoute)schedulePreviewHeaderHide()}}
   onFocusCapture={()=>{if(previewRoute)showPreviewHeader()}}
   onBlurCapture={()=>{if(previewRoute)schedulePreviewHeaderHide()}}
   onKeyDown={event=>{if(previewRoute&&event.key==="Escape"&&!open){
    event.preventDefault();cancelHeaderHide();setPreviewHeaderOpen(false);document.querySelector<HTMLButtonElement>(".file-sidebar-collapse")?.focus();
   }}}>
   <RareButton ref={navToggleRef} type="button" className="nav-toggle" aria-label="导航菜单" aria-controls="shell-main-navigation"
    aria-expanded={open} onClick={()=>setOpen(v=>!v)}>☰</RareButton>
   <div className="brand"><BrandLogo size={22} className="brand-logo"/>中晟生物科技<span className="product">{product??"文档管理系统"}</span></div>
   <GooeyNav id="shell-main-navigation" aria-label="主导航" className={"header-gooey-nav"+(open?" open":"")}
    items={GOOEY_MAIN_ITEMS} value={activeNav} size="xs" radius={8} separation={12}
    activeColor="var(--brand-blue)" activeLabelColor="var(--text-inverse)"
    onChange={()=>setOpen(false)}
    onKeyDown={event=>{
     if(event.key==="Escape"&&open){setOpen(false);navToggleRef.current?.focus();event.preventDefault();return;}
     if(!["ArrowRight","ArrowLeft","ArrowDown","ArrowUp","Home","End"].includes(event.key))return;
     const links=Array.from(event.currentTarget.querySelectorAll<HTMLAnchorElement>('a[href]'));
     const index=links.indexOf(document.activeElement as HTMLAnchorElement);
     if(index<0)return;
     event.preventDefault();
     const step=event.key==="ArrowRight"||event.key==="ArrowDown"?1:-1;
     const target=event.key==="Home"?0:event.key==="End"?links.length-1:(index+step+links.length)%links.length;
     links[target]?.focus();
    }}/>
   <div className="header-right global-utility-dock" role="group" aria-label="系统快捷工具">
    <RareButton type="button" className="command-trigger" aria-label="快速跳转" onClick={()=>window.dispatchEvent(new CustomEvent("filesmanage:command-spotlight"))}>
     <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
     <span>快速跳转</span>
     <span className="command-keys"><kbd>Ctrl</kbd><kbd>K</kbd></span>
    </RareButton>
    {notificationSlot}
    <div className="account-dropdown-wrapper">
     <RareButton ref={accountRef} type="button" className="account-trigger" aria-label="当前登录用户" aria-haspopup="true" aria-expanded={accountOpen}
      onClick={()=>setAccountOpen(v=>!v)}>
      <span className="account">
       <span className="account-avatar" aria-hidden="true">{accountInitial(user.displayName)}</span>
       <span className="account-name">{user.displayName}</span>
       <svg className="account-caret" width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>
      </span>
     </RareButton>
     <Menu open={accountOpen} label="账户操作菜单" anchor={accountRef.current}
      onClose={()=>setAccountOpen(false)} items={[
       {id:"sessions",label:"登录设备与安全",onSelect:()=>navigate("/account/sessions")},
       {id:"logout",label:"退出系统",danger:true,onSelect:onLogout}
      ]}/>
    </div>

   </div>
   {actions&&<div className="header-page-actions">{actions}</div>}
  </header>
  {children}
 </div>;
}

// Spec §3.1: the identity slot carries a small monogram badge next to the
// name. One character, decorative (the name is the accessible label).
function accountInitial(name:string){
 const first=[...name.trim()][0];
 return first??"·";
}
