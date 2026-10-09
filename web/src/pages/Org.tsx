import type{User}from "../entities/user/model";
import{OrganizationPanel}from "../features/organization/OrganizationPanel";
import{AppShell}from "../shared/ui/AppShell";

export function Org({user,onLogout}:{user:User;onLogout:()=>void}){
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">组织管理</div>
    <OrganizationPanel/>
   </main>
  </div>
 </AppShell>;
}
