import type{User}from "../entities/user/model";
import{ApprovalInbox}from "../features/workflow/ApprovalInbox";
import{AppShell}from "../shared/ui/AppShell";

export function Approvals({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">审批工作台</div>
    <ApprovalInbox currentUser={user}/>
   </main>
  </div>
 </AppShell>;
}
