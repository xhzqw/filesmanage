import type{User}from "../entities/user/model";
import{OrganizationPanel}from "../features/organization/OrganizationPanel";
import{AppShell}from "../shared/ui/AppShell";

export function Org({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout} finderSidebarWidth={240}>
  <div className="panels document-explorer org-panels">
   <main className="work org-work">
    <OrganizationPanel isAdmin={user.isAdmin} currentUserId={user.id}/>
   </main>
  </div>
 </AppShell>;
}
