import type{User}from "../entities/user/model";
import{TrashList}from "../features/trash/TrashList";
import{AppShell}from "../shared/ui/AppShell";

export function Trash({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">回收站</div>
    <TrashList onRestored={()=>undefined}/>
   </main>
  </div>
 </AppShell>;
}
