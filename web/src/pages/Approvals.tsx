import{Link}from "react-router-dom";
import type{User}from "../entities/user/model";
import{ApprovalInbox}from "../features/workflow/ApprovalInbox";

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 return <div className="shell">
  <header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档治理中心</span></div>
   <nav aria-label="主导航"><Link to="/doc">文档管理</Link><Link to="/trash">回收站</Link><Link to="/org">组织管理</Link><a href="/approvals">审批</a></nav>
   <span className="account">{user.displayName}</span><button onClick={onLogout}>退出</button>
  </header>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">审批工作台</div>
    <ApprovalInbox currentUser={user}/>
   </main>
  </div>
 </div>;
}
