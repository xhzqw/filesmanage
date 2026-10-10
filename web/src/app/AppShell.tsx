import {Navigate,useLocation} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {CollaborationPanel} from "../features/collaboration/CollaborationPanel";
import {StatsPanel} from "../features/collaboration/StatsPanel";
import {SearchPanel} from "../features/collaboration/SearchPanel";

// Page compositions only; the shell chrome itself lives in shared/ui so every
// page layer can reuse it (VIS-09). The page path is a docked strip at the top
// of the work area: it must stay a <nav> landmark for DI-15, and VIS-11 allows
// exactly one nav inside header.header.
export function WorkspacePage({user,onLogout}:{user:User;onLogout:()=>void}){
 const location=useLocation();
 const stats=location.pathname.startsWith("/stats");
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb crumb-bar">{stats?"统计与导出":"共享与关注"}</div>
    {stats?<StatsPanel/>:<CollaborationPanel/>}
   </main>
  </div>
 </AppShell>;
}

export function SearchPage({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb crumb-bar">全文检索</div>
    <SearchPanel key={user.id} userId={user.id}/>
   </main>
  </div>
 </AppShell>;
}

export function NotFoundPage(){
 return <Navigate to="/doc" replace/>;
}
