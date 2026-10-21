import type{User}from "../entities/user/model";
import{TrashWorkbench}from "../features/trash/TrashWorkbench";
import{AppShell}from "../shared/ui/AppShell";

export function Trash({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout} finderSidebarWidth={240}>
  <div className="panels document-explorer trash-explorer">
   <TrashWorkbench onRestored={()=>undefined}/>
  </div>
 </AppShell>;
}
