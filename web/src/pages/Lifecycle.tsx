import type{User}from "../entities/user/model";
import{LifecycleLedger}from "../features/documents/LifecycleLedger";
import{AppShell}from "../shared/ui/AppShell";
export function Lifecycle({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout} finderSidebarWidth={240}>
  <div className="panels document-explorer lifecycle-panels">
   <main className="work lifecycle-work">
    <LifecycleLedger isAdmin={Boolean(user.isAdmin)}/>
   </main>
  </div>
 </AppShell>;
}
