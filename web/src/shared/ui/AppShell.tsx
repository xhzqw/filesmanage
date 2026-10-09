import {useState,type ReactNode} from "react";
import {Link,useLocation} from "react-router-dom";

// The shell only needs the display name; keeping the type structural avoids a
// shared -> entities dependency, which the architecture gate forbids.
type ShellUser={displayName:string};

// DEC-14 brand shell: blue/white engineering palette and yellow folder SVG
// icons. A self-drawn icon must never stand in for the corporate mark — that
// is the imported BrandLogo's job (SPEC §18 BRAND-01/03).
export function FolderIcon({size=16}:{size?:number}){
 return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <path d="M2.5 5.5A2 2 0 0 1 4.5 3.5h4.2l2 2.4h8.8a2 2 0 0 1 2 2v9.6a2 2 0 0 1-2 2h-16a2 2 0 0 1-2 2z" fill="#F5B623"/>
  <path d="M2.5 8.6h19" stroke="#D89A0E" strokeWidth="1.1"/>
 </svg>;
}

// Local static asset per BRAND-07; square source, fixed box, never stretched.
export function BrandLogo({size,className}:{size:number;className:string}){
 return <img className={className} src="/assets/brand/logo-256.png" alt="中晟生物科技标志" width={size} height={size}/>;
}

const NAV=[
 {to:"/doc",label:"文档管理"},
 {to:"/search",label:"提要"},
 {to:"/workspace",label:"共享/关注"},
 {to:"/stats",label:"统计"},
 {to:"/approvals",label:"审批"},
 {to:"/trash",label:"回收站"},
 {to:"/org",label:"组织管理"},
];

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
 return <div className="shell">
  <header className="header">
   <button className="nav-toggle" aria-label="导航菜单" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>☰</button>
   <div className="brand"><BrandLogo size={22} className="brand-logo"/>中晟生物科技<span className="product">{product??"文档管理系统"}</span></div>
   <nav aria-label="主导航" className={open?"open":""}>
    {NAV.map(item=><NavLink key={item.to} to={item.to} onClick={()=>setOpen(false)}>
     {item.label}
    </NavLink>)}
   </nav>
   <div className="header-right">
    <button type="button" className="command-trigger" aria-label="全局搜索" onClick={()=>window.dispatchEvent(new CustomEvent("filesmanage:command-spotlight"))}>
     <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
     <span>全局搜索</span>
     <span className="command-keys"><kbd>Ctrl</kbd><kbd>K</kbd></span>
    </button>
    <div className="account-dropdown-trigger" title="当前登录用户">
     <span className="account">
      <span className="account-avatar" aria-hidden="true">{accountInitial(user.displayName)}</span>
      <span className="account-name">{user.displayName}</span>
      <span className="account-caret" aria-hidden="true">▾</span>
     </span>
    </div>
    {actions}
    <button type="button" className="header-exit-btn" onClick={onLogout} title="退出系统">
     <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
     <span>退出</span>
    </button>
   </div>
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

function NavLink({to,children,onClick}:{to:string;children:ReactNode;onClick:()=>void}){
 const location=useLocation();
 const active=location.pathname===to;
 return <Link to={to} className={active?"active":""} aria-current={active?"page":undefined} onClick={onClick}>{children}</Link>;
}
