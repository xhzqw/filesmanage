import {Link} from "react-router-dom";
import type {User} from "../entities/user/model";
import {CollaborationPanel} from "../features/collaboration/CollaborationPanel";
import {StatsPanel} from "../features/collaboration/StatsPanel";
import {useLocation} from "react-router-dom";

// Collaboration shell: sharing/favorites and stats/export.
export function Workspace({user,onLogout}:{user:User;onLogout:()=>void}){
 const location=useLocation();
 const stats=location.pathname.startsWith("/stats");
 return <div className="shell">
  <header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">文档治理中心</span></div>
   <nav aria-label="主导航"><Link to="/doc">文档管理</Link><Link to="/workspace">共享/关注</Link><Link to="/stats">统计</Link><Link to="/approvals">审批</Link><Link to="/trash">回收站</Link><Link to="/org">组织管理</Link></nav>
   <span className="account">{user.displayName}</span><button onClick={onLogout}>退出</button>
  </header>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">{stats?"统计与导出":"共享与关注"}</div>
    {stats?<StatsPanel/>:<CollaborationPanel/>}
   </main>
  </div>
 </div>;
}
