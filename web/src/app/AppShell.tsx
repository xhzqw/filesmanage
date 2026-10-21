import {Navigate} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {StatsPanel} from "../features/collaboration/StatsPanel";
import {SearchPanel} from "../features/collaboration/SearchPanel";

// Page compositions only; the shell chrome itself lives in shared/ui so every
// page layer can reuse it (VIS-09). Main navigation already names the active
// module: do not insert another full-width, label-only breadcrumb beneath it.
export function WorkspacePage({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout} finderSidebarWidth={240}>
  <div className="panels document-explorer stats-explorer">
   <StatsPanel/>
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
