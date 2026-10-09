import {Navigate,useLocation} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {CollaborationPanel} from "../features/collaboration/CollaborationPanel";
import {StatsPanel} from "../features/collaboration/StatsPanel";
import {SearchPanel} from "../features/collaboration/SearchPanel";

// Page compositions only; the shell chrome itself lives in shared/ui so every
// page layer can reuse it (VIS-09). The page path travels through the shell's
// breadcrumb slot so the top bar carries it (SPEC §3.1) instead of the work
// area spending a row on it.
export function WorkspacePage({user,onLogout}:{user:User;onLogout:()=>void}){
 const location=useLocation();
 const stats=location.pathname.startsWith("/stats");
 return <AppShell user={user} onLogout={onLogout} breadcrumb={<div className="breadcrumb">{stats?"统计与导出":"共享与关注"}</div>}>
  <div className="panels">
   <main className="work">
    {stats?<StatsPanel/>:<CollaborationPanel/>}
   </main>
  </div>
 </AppShell>;
}

export function SearchPage({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout} breadcrumb={<div className="breadcrumb">全文检索</div>}>
  <div className="panels">
   <main className="work">
    <SearchPanel/>
   </main>
  </div>
 </AppShell>;
}

export function NotFoundPage(){
 return <Navigate to="/doc" replace/>;
}
