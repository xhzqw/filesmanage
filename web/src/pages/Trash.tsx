import {Link}from "react-router-dom";
import type{User}from "../entities/user/model";
import{TrashList}from "../features/trash/TrashList";

export function Trash({user,onLogout}:{user:User;onLogout:()=>void}){
 return <div className="shell">
  <header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档治理中心</span></div>
   <nav aria-label="主导航"><Link to="/doc">文档管理</Link><a href="/trash">回收站</a></nav>
   <span className="account">{user.displayName}</span><button onClick={onLogout}>退出</button>
  </header>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">回收站</div>
    <TrashList onRestored={()=>undefined}/>
   </main>
  </div>
 </div>;
}
