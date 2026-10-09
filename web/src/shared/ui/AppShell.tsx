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
 {to:"/doc",label:"文档管理",icon:"folder"},
 {to:"/search",label:"搜索",icon:"search"},
 {to:"/workspace",label:"共享/关注",icon:"share"},
 {to:"/stats",label:"统计",icon:"chart"},
 {to:"/approvals",label:"审批",icon:"check"},
 {to:"/trash",label:"回收站",icon:"trash"},
 {to:"/org",label:"组织管理",icon:"org"},
];

// The single shell shared by every authenticated page (DESIGN-SYSTEM-v1 §3.1,
// VIS-09): one brand block, one navigation, one identity/exit area. Pages may
// add `actions` (page-specific header buttons) and a `product` subtitle; they
// must not draw their own header.
export function AppShell({user,onLogout,product,actions,children}:{user:ShellUser;onLogout:()=>void;product?:string;actions?:ReactNode;children:ReactNode}){
 const[open,setOpen]=useState(false);
 return <div className="shell">
  <header className="header">
   <button className="nav-toggle" aria-label="导航菜单" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>☰</button>
   <div className="brand"><BrandLogo size={30} className="brand-logo"/>中晟生物科技 <span className="product">{product??"文档管理系统"}</span></div>
   <nav aria-label="主导航" className={open?"open":""}>
    {NAV.map(item=><NavLink key={item.to} to={item.to} onClick={()=>setOpen(false)}>
     {item.icon==="folder"?<FolderIcon size={14}/>:null}{item.label}
    </NavLink>)}
   </nav>
   <span className="account">{user.displayName}</span>
   {actions}
   <button onClick={onLogout}>退出</button>
  </header>
  {children}
 </div>;
}

function NavLink({to,children,onClick}:{to:string;children:ReactNode;onClick:()=>void}){
 const location=useLocation();
 const active=location.pathname===to;
 return <Link to={to} className={active?"active":""} onClick={onClick}>{children}</Link>;
}
