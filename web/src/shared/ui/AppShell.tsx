import {RareButton} from "./rare";
import {useContext,useRef,useState,type ReactNode} from "react";
import {ShellAccessories} from "./ShellAccessories";
import {Link,useLocation,useNavigate} from "react-router-dom";
import {Menu} from "./Menu";
import {FolderResourceIcon} from "./ResourceIcons";

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
 {to:"/search",label:"提要"},
 {to:"/workspace",label:"共享/关注"},
 {to:"/stats",label:"统计"},
 {to:"/approvals",label:"审批"},
 {to:"/lifecycle",label:"生命周期"},
 {to:"/trash",label:"回收站"},
 {to:"/org",label:"组织与权限"},
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
 const[accountOpen,setAccountOpen]=useState(false);
 const accountRef=useRef<HTMLButtonElement>(null);
 const navigate=useNavigate();
 const notificationSlot=useContext(ShellAccessories);

 return <div className="shell">
  <header className="header">
   <RareButton className="nav-toggle" aria-label="导航菜单" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>☰</RareButton>
   <div className="brand"><BrandLogo size={22} className="brand-logo"/>中晟生物科技<span className="product">{product??"文档管理系统"}</span></div>
   <nav aria-label="主导航" className={open?"open":""}>
    {NAV.map(item=><NavLink key={item.to} to={item.to} onClick={()=>setOpen(false)}>
     {item.label}
    </NavLink>)}
   </nav>
   <div className="header-right">
    <RareButton type="button" className="command-trigger" aria-label="全局搜索" onClick={()=>window.dispatchEvent(new CustomEvent("filesmanage:command-spotlight"))}>
     <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>
     <span>全局搜索</span>
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
    {actions}
    <RareButton type="button" className="header-exit-btn" onClick={onLogout} title="退出系统">
     <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
     <span className="header-exit-label">退出</span>
    </RareButton>
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
