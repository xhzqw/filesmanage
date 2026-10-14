import {RareBadge,RareButton} from "../../shared/ui/rare";
import type {User} from "../../entities/user/model";

export function WorkgroupMemberRow({user,kind,department,busy=false,onAction}:{
 user:User;kind:"member"|"candidate";department?:string;busy?:boolean;onAction:()=>void;
}){
 const member=kind==="member";
 return <div className={member?"org-member-card":"org-candidate-card"}>
  <div className={member?"org-member-card-info":"org-candidate-info"}>
   <span className="org-avatar" aria-hidden="true">{user.displayName.slice(0,1)}</span>
   <div className={member?"org-member-card-text":"org-candidate-text"}>
    <span className={member?"org-member-card-name":"org-candidate-name"} title={user.displayName}>{user.displayName}</span>
    <code className={member?"org-member-card-login":"org-candidate-login"} title={user.login??""}>{user.login??""}</code>
   </div>
   {member
    ?user.disabled===true&&<RareBadge tone="danger" dot>已禁用</RareBadge>
    :<RareBadge className="org-dept-pill" tone="neutral">{department??"未分配部门"}</RareBadge>}
  </div>
  <RareButton type="button" tone={member?"danger":"primary"}
   className={(member?"danger":"primary")+" org-action-btn"} disabled={!member&&busy}
   onClick={onAction}>{member?"移除":busy?"加入中…":"加入"}</RareButton>
 </div>;
}
