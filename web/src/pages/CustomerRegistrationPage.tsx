import {useState} from "react";
import {Link,useSearchParams} from "react-router-dom";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {CustomerRegistrationWorkspace} from "../features/customers/CustomerRegistrationWorkspace";
import "./customerData.css";
import "./customerRegistrationPage.css";

/** Customer registration is a business queue inside the existing workbench route tree.
 * File formal approval and file edit workflows remain unchanged. */
export function CustomerRegistrationPage({user,onLogout}:{user:User;onLogout:()=>void}){
 const[params]=useSearchParams();
 const[refresh,setRefresh]=useState(0);
 return <AppShell user={user} onLogout={onLogout}>
  <div className="panels customers-panels">
   <main className="work customer-work customer-registration-page">
    <div className="customer-registration-route">
     <nav aria-label="工作台位置" className="customer-approval-breadcrumb">
      <Link to="/workbench">工作台</Link><span aria-hidden="true">›</span><strong>客户登记审批</strong>
      <Link to="/customers" className="customer-approval-back">返回客户资料 ↗</Link>
     </nav>
     <CustomerRegistrationWorkspace actorId={user.id} refreshToken={refresh}
      initialScope={params.get("scope")==="mine"?"mine":"inbox"} onDecided={()=>setRefresh(v=>v+1)}/>
    </div>
   </main>
  </div>
 </AppShell>;
}
