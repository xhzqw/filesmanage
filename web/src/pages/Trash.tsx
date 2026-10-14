import type{User}from "../entities/user/model";
import{TrashWorkbench}from "../features/trash/TrashWorkbench";
import{AppShell}from "../shared/ui/AppShell";

export function Trash({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <TrashWorkbench onRestored={()=>undefined}/>
   </main>
  </div>
 </AppShell>;
}
