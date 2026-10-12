import {Navigate,useLocation} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {CollaborationPanel} from "../features/collaboration/CollaborationPanel";
import {StatsPanel} from "../features/collaboration/StatsPanel";
import {SearchPanel} from "../features/collaboration/SearchPanel";

// Page compositions only; the shell chrome itself lives in shared/ui so every
// page layer can reuse it (VIS-09). Main navigation already names the active
// module: do not insert another full-width, label-only breadcrumb beneath it.
export function WorkspacePage({user,onLogout}:{user:User;onLogout:()=>void}){
 const location=useLocation();
 const stats=location.pathname.startsWith("/stats");
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    {stats?<StatsPanel/>:<CollaborationPanel/>}
   </main>
  </div>
 </AppShell>;
}

export function SearchPage({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work search-page">
    <SearchPanel key={user.id} userId={user.id}/>
   </main>
  </div>
 </AppShell>;
}

export function NotFoundPage(){
 return <Navigate to="/doc" replace/>;
}
