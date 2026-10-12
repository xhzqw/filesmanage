import type{User}from "../entities/user/model";
import{LifecycleLedger}from "../features/documents/LifecycleLedger";
import{AppShell}from "../shared/ui/AppShell";
export function Lifecycle({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}><div className="panels"><main className="work">
  <LifecycleLedger isAdmin={Boolean(user.isAdmin)}/>
 </main></div></AppShell>;
}
