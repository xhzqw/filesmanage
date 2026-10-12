import {RareTabs} from "../../shared/ui/rare/RareTabs";
import {toast} from "../../shared/ui/feedback";
import {RareBadge,RareButton,RareDataTable,RareInput,RareNotice,RareRowActions,RareSelect} from "../../shared/ui/rare";
import {useCallback,useEffect,useRef,useState,type FormEvent} from "react";
import {Dialog} from "../../shared/ui/Dialog";
import type {User} from "../../entities/user/model";
import "./organization.css";
import "./memberWorkbench.css";
import {useSearchParams} from "react-router-dom";
import {PermissionsPanel} from "./PermissionsPanel";
import {ApprovalPoliciesPanel} from "./ApprovalPoliciesPanel";
import {RoleBindingsPanel,DelegatedRolesWorkspace} from "./RoleWorkspace";
import {DepartmentNavigator} from "./DepartmentNavigator";
import {useOrganizationDirectory} from "./useOrganizationDirectory";
import {useOrganizationMutations} from "./useOrganizationMutations";
import {loginOf} from "./organizationUserLabel";
import {CANDIDATE_CAP,useOrganizationSelectors,type StatusFilter} from "./useOrganizationSelectors";
import {WorkgroupMemberRow} from "./WorkgroupMemberRow";
import {IconUsers,IconSearch} from "./OrganizationIcons";
import {ResetPasswordDialog,SetDisabledDialog,RemoveMemberDialog,CreateUserConfirmDialog,CreateDepartmentDialog,CreateGroupDialog,DeleteWorkgroupDialog} from "./OrganizationDialogs";

type Tone="info"|"error";
type Notice={text:string;tone:Tone};

const MEMBER_DISPLAY_STEP=100;
const GROUP_DISPLAY_STEP=60;

function IconGroup(){
 return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <rect x="2" y="3" width="12" height="10" rx="2"/>
  <path d="M6 8h4"/>
  <path d="M8 6v4"/>
 </svg>;
}

function IconPlus(){
 return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
  <path d="M8 2v12M2 8h12"/>
 </svg>;
}

export function OrganizationPanel({isAdmin,currentUserId}:{isAdmin:boolean;currentUserId:string}){
 const[selectedGroup,setSelectedGroup]=useState("");
 const[deleteGroupTarget,setDeleteGroupTarget]=useState<{id:string;name:string;departmentId:string|null}|null>(null);
 const {users,departments,groups,
  usersState,departmentsState,groupsState,
  setUsersToken,setDepartmentsToken,setGroupsToken,groupMembers,setGroupMembers,
  membersState,setMembersToken,reloadUsers,reloadDepartments,reloadGroups,reloadMembers}=useOrganizationDirectory(isAdmin,selectedGroup);
 const[notice,setNotice]=useState<Notice|null>(null);
 useEffect(()=>{
  if(notice&&notice.tone!=="error")(notice.text.startsWith("已")?toast.success:toast.info)(notice.text);
 },[notice]);

 // 视图与筛选状态：默认 Tab 1 为部门成员，Tab 2 为工作组管理
 const[queryParams,setQueryParams]=useSearchParams();
 const activeTab=queryParams.get("tab")==="approvals"&&isAdmin?"approvals":queryParams.get("tab")==="roles"?"roles":queryParams.get("tab")==="permissions"?"permissions":queryParams.get("tab")==="groups"?"groups":"members";
 // The resource folder is shared across tabs; leaving a dirty editor requires consent.
 const[hasUnsavedChanges,setHasUnsavedChanges]=useState(false);
 const[discardDialogOpen,setDiscardDialogOpen]=useState(false);
 const pendingNavigation=useRef<(()=>void)|null>(null);
 const requestNavigation=useCallback((navigate:()=>void)=>{
  if(hasUnsavedChanges){pendingNavigation.current=navigate;setDiscardDialogOpen(true);}
  else navigate();
 },[hasUnsavedChanges]);
 const setActiveTab=(tab:"members"|"groups"|"permissions"|"roles"|"approvals")=>{
  if(tab===activeTab)return;
  requestNavigation(()=>setQueryParams(old=>{
   const next=new URLSearchParams(old);next.set("tab",tab);return next;
  }));
 };
 useEffect(()=>{
  if(!hasUnsavedChanges)return;
  const beforeUnload=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue="";};
  window.addEventListener("beforeunload",beforeUnload);
  return()=>window.removeEventListener("beforeunload",beforeUnload);
 },[hasUnsavedChanges]);
 const[selectedDepartment,setSelectedDepartment]=useState("");
 const[memberQuery,setMemberQuery]=useState("");
 const[statusFilter,setStatusFilter]=useState<StatusFilter>("all");
 const[memberLimit,setMemberLimit]=useState(MEMBER_DISPLAY_STEP);

 // 工作组状态
 const[groupQuery,setGroupQuery]=useState("");
 const[groupLimit,setGroupLimit]=useState(GROUP_DISPLAY_STEP);
 const[groupMemberLimit,setGroupMemberLimit]=useState(MEMBER_DISPLAY_STEP);
 const[candidateQuery,setCandidateQuery]=useState("");

 // 对话框表单状态
 const[newUser,setNewUser]=useState({login:"",displayName:"",password:"",departmentId:""});
 const[createFormOpen,setCreateFormOpen]=useState(false);
 const[resetTarget,setResetTarget]=useState<User|null>(null);
 const[stateTarget,setStateTarget]=useState<User|null>(null);
 const[removeTarget,setRemoveTarget]=useState<User|null>(null);
 const[createUserOpen,setCreateUserOpen]=useState(false);
 const[createDepartmentOpen,setCreateDepartmentOpen]=useState(false);
 const[createGroupOpen,setCreateGroupOpen]=useState(false);

 const {deptById,deptIndex,departmentLabel,departmentOptions,unassignedCount,deptCounts,
  needle,filteredMembers,filteredGroups,candidates}=useOrganizationSelectors({
  users,departments,groups,groupMembers,selectedDepartment,memberQuery,statusFilter,groupQuery,candidateQuery
 });
 useEffect(()=>setMemberLimit(MEMBER_DISPLAY_STEP),[selectedDepartment,statusFilter,memberQuery]);
 useEffect(()=>{
  if(!filteredGroups.some(group=>group.id===selectedGroup))
   setSelectedGroup(filteredGroups[0]?.id??"");
 },[filteredGroups,selectedGroup]);
 useEffect(()=>setGroupLimit(GROUP_DISPLAY_STEP),[groupQuery,selectedDepartment]);
 useEffect(()=>setGroupMemberLimit(MEMBER_DISPLAY_STEP),[selectedGroup]);
 const selectedGroupRow=filteredGroups.find(g=>g.id===selectedGroup)??null;
 const deptFilter=departmentsState==="ready"||departments.length>0?selectedDepartment:"";

 const {addBusy,createUser,resetPassword,applyDisabled,removeMember,addMember,createDepartment,createGroup,deleteGroup}=
  useOrganizationMutations({
   newUser,setNewUser,resetTarget,stateTarget,removeTarget,selectedGroup,selectedGroupRow,
   setNotice,setCandidateQuery,setGroupMembers,
   reloadUsers,reloadDepartments,reloadGroups,reloadMembers
  });

 const canCreateUser=
  newUser.login.trim()!==""&&newUser.displayName.trim()!==""&&newUser.password.length>=16;

 function submitCreateUser(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(!canCreateUser)return;
  setNotice(null);
  setCreateFormOpen(false);
  setCreateUserOpen(true);
 }

 if(!isAdmin)
  return <DelegatedRolesWorkspace/>;

 const usersReady=usersState==="ready"||users.length>0;
 const membersAvailable=membersState==="ready"||groupMembers.length>0;
 const departmentsReady=departmentsState==="ready"||departments.length>0;
 const groupsReady=groupsState==="ready"||groups.length>0;

 const memberEmpty=users.length===0
  ?"还没有账号。"
  :needle!==""
   ?"没有匹配的成员（按姓名或账号搜索）。"
   :selectedDepartment==="__unassigned"
    ?"暂无未分配部门的成员。"
    :deptFilter!==""
     ?"该部门（含子部门）暂无成员。"
     :"没有成员。";

 const scopeText=departmentsState==="failed"&&departments.length===0
  ?"范围：全部账号（部门数据不可用，暂不能按部门筛选）"
  :selectedDepartment==="__unassigned"
   ?`范围：未分配部门（${unassignedCount} 人）`
   :deptFilter===""
    ?`范围：全体组织（${users.length} 人）`
    :"范围："+departmentLabel(deptFilter)+"（含全部子部门）";

 const scopeLabel=selectedDepartment===""
  ?"全体组织"
  :selectedDepartment==="__unassigned"
   ?"未分配部门"
   :departmentLabel(selectedDepartment);

 const candidateEmpty=!usersReady
  ?"账号列表不可用，无法选择成员。"
  :candidateQuery.trim()!==""
   ?"没有匹配的可加入账号。"
   :"所有可用账号都已在该工作组中。";

 const memberTableEmpty=usersState==="loading"
  ?"正在读取用户…"
  :usersState==="failed"
   ?"用户列表读取失败，请先用上方的重试按钮。"
   :memberEmpty;

 return <div className="work-body">
  {/* 顶部工具栏：指标摘要与全局快捷创建 */}
  <div className="toolbar">
   <span className="toolbar-hint">{`账号 ${users.length} · 部门 ${departments.length} · 工作组 ${groups.length}`}</span>
   <RareButton type="button" onClick={()=>{setNotice(null);setCreateDepartmentOpen(true);}}>
    <IconPlus/>新建部门
   </RareButton>
   <RareButton type="button" className="primary" tone="primary" onClick={()=>{setNotice(null);setCreateGroupOpen(true);}}>
    <IconPlus/>创建工作组
   </RareButton>
  </div>

  {notice?.tone==="error"&&<RareNotice tone="danger">{notice.text}</RareNotice>}

  {/* 双栏主工作台：左侧组织架构树 + 右侧主工作区卡片 */}
  <div className="org-workbench">
   <DepartmentNavigator departments={departments} departmentsState={departmentsState}
    deptIndex={deptIndex} deptById={deptById} deptCounts={deptCounts}
    selectedDepartment={selectedDepartment} onSelect={setSelectedDepartment}
    usersCount={users.length} unassignedCount={unassignedCount}
    onRetry={()=>setDepartmentsToken(token=>token+1)}/>

   {/* 右侧：组织工作区 */}
   <section className="org-card org-stage-card" aria-label="组织管理主工作区">
    <div className="org-tabs-bar">
     <RareTabs className="org-tabs-nav" label="组织管理视图">
      <RareButton type="button" role="tab" aria-selected={activeTab==="members"} tabIndex={activeTab==="members"?0:-1} id="org-tab-members" aria-controls="org-panel-members"
       className={"org-tab"+(activeTab==="members"?" active":"")}
       onClick={()=>setActiveTab("members")}>
       <span className="org-tab-icon"><IconUsers/></span>
       <span>部门成员</span>
       <span className="org-tab-badge">{filteredMembers.length}</span>
      </RareButton>
      <RareButton type="button" role="tab" aria-selected={activeTab==="groups"} tabIndex={activeTab==="groups"?0:-1} id="org-tab-groups" aria-controls="org-panel-groups"
       className={"org-tab"+(activeTab==="groups"?" active":"")}
       onClick={()=>setActiveTab("groups")}>
       <span className="org-tab-icon"><IconGroup/></span>
       <span>工作组管理</span>
       <span className="org-tab-badge">{filteredGroups.length}</span>
      </RareButton>
      <RareButton type="button" role="tab" aria-selected={activeTab==="permissions"} tabIndex={activeTab==="permissions"?0:-1} id="org-tab-permissions" aria-controls="org-panel-permissions"
       className={"org-tab"+(activeTab==="permissions"?" active":"")}
       onClick={()=>setActiveTab("permissions")}>权限管理</RareButton>
      {isAdmin&&<RareButton type="button" role="tab" aria-selected={activeTab==="approvals"} tabIndex={activeTab==="approvals"?0:-1} id="org-tab-approvals" aria-controls="org-panel-approvals"
       className={"org-tab"+(activeTab==="approvals"?" active":"")} onClick={()=>setActiveTab("approvals")}>审批策略</RareButton>}
      <RareButton type="button" role="tab" aria-selected={activeTab==="roles"} tabIndex={activeTab==="roles"?0:-1} id="org-tab-roles" aria-controls="org-panel-roles"
       className={"org-tab"+(activeTab==="roles"?" active":"")}
       onClick={()=>setActiveTab("roles")}>管理角色</RareButton>
     </RareTabs>

     {/* 当前部门范围标识 */}
     {activeTab!=="permissions"&&activeTab!=="roles"&&activeTab!=="approvals"&&<div className="org-scope-badge">
      <span className="org-scope-dot" aria-hidden="true"/>
      <span>范围：{scopeLabel}</span>
      {selectedDepartment!==""&&<RareButton type="button" className="org-scope-reset"
       title="清除部门筛选，显示全体" onClick={()=>setSelectedDepartment("")}>✕</RareButton>}
     </div>}
    </div>

    {activeTab==="permissions"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-permissions" aria-labelledby="org-tab-permissions"><PermissionsPanel users={users} groups={groups}
     usersState={usersState} groupsState={groupsState}
     onRetryUsers={()=>setUsersToken(token=>token+1)}
     onRetryGroups={()=>setGroupsToken(token=>token+1)} onDirtyChange={setHasUnsavedChanges} requestNavigation={requestNavigation}/></div>}
    {activeTab==="approvals"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-approvals" aria-labelledby="org-tab-approvals">
     <ApprovalPoliciesPanel users={users} usersState={usersState} onRetryUsers={()=>setUsersToken(token=>token+1)} onDirtyChange={setHasUnsavedChanges} requestNavigation={requestNavigation}/></div>}
    {activeTab==="roles"&&<div className="rare-tab-panel" role="tabpanel" id="org-panel-roles" aria-labelledby="org-tab-roles"><RoleBindingsPanel users={users} onDirtyChange={setHasUnsavedChanges}/></div>}

    {/* Tab 1: 部门成员 */}
    {activeTab==="members"&&<div className="org-tab-stage" role="tabpanel" id="org-panel-members" aria-labelledby="org-tab-members">
     {/* 搜索与筛选条 */}
     <div className="org-filter-bar">
      <div className="org-filter-left">
       <div className="org-member-search-wrap">
        <IconSearch/>
        <RareInput className="org-search" type="search" aria-label="搜索成员" autoComplete="off"
         placeholder="按姓名或账号搜索成员" value={memberQuery} onChange={event=>setMemberQuery(event.target.value)}/>
       </div>
       <RareSelect className="org-select" aria-label="按状态筛选"
        value={statusFilter} onChange={e=>setStatusFilter(e.target.value as StatusFilter)}>
        <option value="all">全部状态</option>
        <option value="normal">正常</option>
        <option value="disabled">已禁用</option>
        <option value="admin">系统管理员</option>
       </RareSelect>
       {usersState==="failed"&&<RareButton type="button" className="secondary-action" onClick={()=>setUsersToken(token=>token+1)}>重新读取用户</RareButton>}
      </div>
      <span className="toolbar-hint">显示 {Math.min(memberLimit,filteredMembers.length)} / {filteredMembers.length} 位成员</span>
      <RareButton type="button" className="primary org-add-member" onClick={()=>{setNotice(null);setCreateFormOpen(true);}}><IconPlus/>新增成员</RareButton>
     </div>



     {/* 成员数据表格 */}
     <div className="org-table-container">
      <RareDataTable className="org-members-table" aria-label="成员列表" aria-busy={usersState==="loading"?true:undefined}>
       <thead>
        <tr>
         <th scope="col">姓名</th>
         <th className="org-member-optional" scope="col">账号</th>
         <th className="org-member-optional" scope="col">部门</th>
         <th scope="col">状态</th>
         <th scope="col">操作</th>
        </tr>
       </thead>
       <tbody>
        {filteredMembers.slice(0,memberLimit).map(user=><tr key={user.id}>
         <td>
          <div className="org-user-cell">
           <span className="org-avatar" aria-hidden="true">{user.displayName.slice(0,1)}</span>
           <span className="org-user-name">{user.displayName}</span>
           <span className="org-member-mobile-meta" title={loginOf(user)}>{loginOf(user)||"—"} · {departmentLabel(user.departmentId)}</span>
          </div>
         </td>
         <td className="org-member-optional">
          <code className="org-user-login">{loginOf(user)||"—"}</code>
         </td>
         <td className="org-member-optional" title={user.departmentId&&!deptById.has(user.departmentId)?user.departmentId:undefined}>
          <span className="org-dept-tag">{departmentLabel(user.departmentId)}</span>
         </td>
         <td>
          <span className="org-badges">
           {user.isAdmin&&<RareBadge tone="info" dot>系统管理员</RareBadge>}
           {user.disabled===true&&<RareBadge tone="danger" dot
            title="账号已禁用：无法登录，现有会话已失效；其工作组与授权记录仍保留。">已禁用</RareBadge>}
           {user.disabled!==true&&<RareBadge tone="success" dot>正常</RareBadge>}
          </span>
         </td>
         <td className="org-member-actions"><RareRowActions>
          <RareButton type="button" onClick={()=>{setNotice(null);setResetTarget(user);}}>重置密码</RareButton>
          {user.id===currentUserId
           ?<RareButton type="button" disabled title="不能对当前登录账号执行禁用">禁用</RareButton>
           :<RareButton type="button" tone={user.disabled===true?"neutral":"danger"} className={user.disabled===true?"org-btn-enable":"danger"}
             onClick={()=>{setNotice(null);setStateTarget(user);}}>{user.disabled===true?"启用":"禁用"}</RareButton>}
         </RareRowActions></td>
        </tr>)}
        {filteredMembers.length===0&&<tr><td colSpan={5} className="empty">{memberTableEmpty}</td></tr>}
       </tbody>
      </RareDataTable>
     </div>
     {filteredMembers.length>memberLimit&&<div className="org-list-more">
      <span className="hint">已显示 {memberLimit} / {filteredMembers.length} 位成员</span>
      <RareButton type="button" onClick={()=>setMemberLimit(limit=>limit+MEMBER_DISPLAY_STEP)}>
       显示更多成员
      </RareButton>
     </div>}


    </div>}
    {createFormOpen&&<Dialog open title="新增成员" className="org-create-user-dialog" initialFocus="#org-new-login" onClose={()=>setCreateFormOpen(false)}>
     <div className="org-create-user-card">
      <div className="org-create-user-head">
       <div className="org-create-user-title">
        <IconPlus/>
        <span>快速添加新成员</span>
       </div>
       <span className="hint">初始密码至少 16 位</span>
      </div>
      <form className="inline-form org-form org-create-form" onSubmit={submitCreateUser}>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-login">新账号</label>
        <RareInput id="org-new-login" aria-label="新账号" placeholder="新账号" value={newUser.login}
         onChange={event=>setNewUser(prev=>({...prev,login:event.target.value}))}/>
       </div>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-name">姓名</label>
        <RareInput id="org-new-name" aria-label="姓名" placeholder="姓名" value={newUser.displayName}
         onChange={event=>setNewUser(prev=>({...prev,displayName:event.target.value}))}/>
       </div>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-pwd">初始密码</label>
        <RareInput id="org-new-pwd" aria-label="初始密码" placeholder="初始密码（≥16 位）" type="password" autoComplete="new-password" value={newUser.password}
         onChange={event=>setNewUser(prev=>({...prev,password:event.target.value}))}/>
       </div>
       <div className="org-field">
        <label className="org-field-label" htmlFor="org-new-dept">部门</label>
        <RareSelect id="org-new-dept" className="org-select" aria-label="部门" value={newUser.departmentId}
         onChange={event=>setNewUser(prev=>({...prev,departmentId:event.target.value}))}>
         <option value="">未分配部门</option>
         {departmentOptions.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
        </RareSelect>
       </div>
       <div className="dialog-actions org-create-form-actions"><RareButton type="button" onClick={()=>setCreateFormOpen(false)}>取消</RareButton>
        <RareButton className="primary" tone="primary" type="submit" disabled={!canCreateUser}>核对并创建</RareButton></div>
      </form>
     </div>
    </Dialog>}

    {/* Tab 2: 工作组管理（Master-Detail 双栏结构） */}
    {activeTab==="groups"&&<div className="org-groups-stage" role="tabpanel" id="org-panel-groups" aria-labelledby="org-tab-groups">
     {/* 左侧：工作组卡片列表 */}
     <div className="org-group-list-col">
      <div className="org-card-header">
       <h4 className="org-card-title">
        <IconGroup/>
        <span>工作组列表</span>
        <RareBadge className="org-count-pill" tone="neutral">{filteredGroups.length}</RareBadge>
       </h4>
      </div>

      <div className="org-search-box">
       <IconSearch/>
       <RareInput className="org-search" type="search" aria-label="搜索工作组" placeholder="搜索工作组"
        value={groupQuery} onChange={e=>setGroupQuery(e.target.value)}/>
       {groupQuery&&<RareButton type="button" className="org-group-search-clear" aria-label="清空工作组搜索" title="清空工作组搜索"
        onClick={()=>setGroupQuery("")}>×</RareButton>}
      </div>

       {groupsState==="loading"&&<p className="hint org-inline-message">正在读取工作组…</p>}
       {groupsState==="failed"&&<div className="org-inline-message">
       <RareNotice tone="danger">读取工作组列表失败。</RareNotice>
       <RareButton type="button" className="secondary-action" onClick={()=>setGroupsToken(t=>t+1)}>重试</RareButton>
      </div>}

       {groupsReady&&groups.length===0&&<p className="empty org-list-empty">暂无工作组，可使用顶部按钮创建。</p>}

      {groupsReady&&groups.length>0&&<ul className="org-group-cards-list">
       {filteredGroups.slice(0,groupLimit).map(group=>{
        const isSelected=group.id===selectedGroup;
        return <li key={group.id}>
         <RareButton type="button" className={"org-group-card"+(isSelected?" active":"")}
          aria-pressed={isSelected} aria-label={"查看工作组 "+group.name}
          onClick={()=>setSelectedGroup(group.id)}>
           <div className="org-group-card-header">
            <span className="org-group-list-icon"><IconGroup/></span>
            <span className="org-group-name" title={group.name}>{group.name}</span>
            {isSelected&&membersAvailable&&<span className="org-group-selected-count" aria-label={"成员 "+groupMembers.length+" 人"}>{groupMembers.length}</span>}
           </div>
         </RareButton>
        </li>;
       })}
       {filteredGroups.length===0&&<li className="empty">没有匹配的工作组。</li>}
      </ul>}
      {filteredGroups.length>groupLimit&&<div className="org-list-more">
       <span className="hint">已显示 {groupLimit} / {filteredGroups.length} 个工作组</span>
       <RareButton type="button" onClick={()=>setGroupLimit(limit=>limit+GROUP_DISPLAY_STEP)}>显示更多工作组</RareButton>
      </div>}
     </div>

     {/* 右侧：所选工作组详情与成员维护 */}
     <div className="org-group-detail-col">
      {selectedGroupRow===null
        ?<div className="empty org-group-empty">请从左侧选择一个工作组以查看并配置成员。</div>
       :<>
        <div className="org-group-banner">
         <div className="org-group-banner-info">
          <h4 className="org-group-detail-title">{selectedGroupRow.name}</h4>
           <RareBadge className="org-dept-pill" tone="neutral">{selectedGroupRow.departmentId?departmentLabel(selectedGroupRow.departmentId):"公共工作组"}</RareBadge>
         </div>
         <div className="org-group-banner-actions">
          <RareBadge tone="info" className="org-group-member-count">{groupMembers.length} 位成员</RareBadge>
          <RareButton type="button" tone="danger" className="danger" onClick={()=>setDeleteGroupTarget(selectedGroupRow)}>删除工作组</RareButton>
         </div>
        </div>

        {/* 组内成员列表 */}
        <div className="org-group-section">
         <div className="org-section-header">
          <h5>组内成员（{groupMembers.length}）</h5>
          {membersState==="failed"&&<RareButton type="button" className="secondary-action" onClick={()=>setMembersToken(t=>t+1)}>重试</RareButton>}
         </div>

         {membersState==="loading"&&<p className="hint">正在读取工作组成员…</p>}
         {membersAvailable&&<div className="org-member-grid">
          {groupMembers.slice(0,groupMemberLimit).map(member=><WorkgroupMemberRow key={member.id}
           user={member} kind="member" onAction={()=>{setNotice(null);setRemoveTarget(member);}}/>)}
          {groupMembers.length===0&&<p className="empty org-grid-empty">该工作组暂无成员，可在下方添加成员。</p>}
         </div>}
         {membersAvailable&&groupMembers.length>groupMemberLimit&&
          <div className="org-list-more">
           <span className="hint">已显示 {groupMemberLimit} / {groupMembers.length} 位工作组成员</span>
           <RareButton type="button" onClick={()=>setGroupMemberLimit(n=>n+MEMBER_DISPLAY_STEP)}>
            显示更多组内成员
           </RareButton>
          </div>}
        </div>

        {/* 添加成员到工作组 */}
        <div className="org-group-section">
         <div className="org-section-header">
          <h5>添加成员</h5>
         </div>

         {!usersReady
          ?<p className="hint">{usersState==="loading"?"正在读取可选择的账号…":"账号列表不可用，无法选择新成员。"}</p>
          :<>
           <div className="org-search-box org-candidate-search">
            <IconSearch/>
            <RareInput className="org-search" type="search" aria-label="搜索可加入的账号" autoComplete="off"
             placeholder="按姓名或账号搜索可加入的账号" value={candidateQuery} onChange={event=>setCandidateQuery(event.target.value)}/>
           </div>

           <div className="org-candidate-grid">
            {candidates.map(user=><WorkgroupMemberRow key={user.id} user={user} kind="candidate"
             department={departmentLabel(user.departmentId)} busy={addBusy!==""}
             onAction={()=>addMember(user)}/>)}
             {candidates.length===0&&<p className="empty org-grid-empty">{candidateEmpty}</p>}
           </div>

           {candidates.length>=CANDIDATE_CAP&&<p className="hint">最多显示 {CANDIDATE_CAP} 个候选账号，继续输入可缩小范围。</p>}
          </>}
        </div>
       </>}
     </div>
    </div>}
   </section>
  </div>

  <Dialog open={discardDialogOpen} title="未保存的修改" className="org-dialog"
   onClose={()=>{pendingNavigation.current=null;setDiscardDialogOpen(false);}}>
   <p>当前编辑尚未保存。离开后将丢弃这些修改。</p>
   <div className="dialog-actions">
    <RareButton type="button" onClick={()=>{pendingNavigation.current=null;setDiscardDialogOpen(false);}}>继续编辑</RareButton>
    <RareButton type="button" className="danger" tone="danger" onClick={()=>{
     const next=pendingNavigation.current;
     pendingNavigation.current=null;setDiscardDialogOpen(false);setHasUnsavedChanges(false);
     next?.();
    }}>放弃修改并离开</RareButton>
   </div>
  </Dialog>
  {deleteGroupTarget&&<DeleteWorkgroupDialog name={deleteGroupTarget.name}
   count={deleteGroupTarget.id===selectedGroup?groupMembers.length:0}
   onClose={()=>setDeleteGroupTarget(null)}
   onSubmit={()=>deleteGroup(deleteGroupTarget)}
   onOpenPermissions={()=>{setDeleteGroupTarget(null);requestNavigation(()=>setQueryParams(old=>{const next=new URLSearchParams(old);next.set("tab","permissions");next.set("view","folder");return next;}));}}/>}
  {/* 对话框保持原样 */}
  {resetTarget&&<ResetPasswordDialog target={resetTarget} department={departmentLabel(resetTarget.departmentId)}
   onClose={()=>setResetTarget(null)} onSubmit={resetPassword}/>}
  {stateTarget&&<SetDisabledDialog target={stateTarget} department={departmentLabel(stateTarget.departmentId)}
   onClose={()=>setStateTarget(null)} onSubmit={applyDisabled}/>}
  {removeTarget&&<RemoveMemberDialog member={removeTarget} groupName={selectedGroupRow?.name??""}
   department={departmentLabel(removeTarget.departmentId)}
   onClose={()=>setRemoveTarget(null)} onSubmit={removeMember}/>}
  {createUserOpen&&<CreateUserConfirmDialog draft={{login:newUser.login.trim(),displayName:newUser.displayName.trim()}}
   department={departmentLabel(newUser.departmentId)}
   onClose={()=>{setCreateUserOpen(false);if(newUser.login.trim())setCreateFormOpen(true);}} onSubmit={createUser}/>}
  {createDepartmentOpen&&<CreateDepartmentDialog options={departmentOptions} defaultParentId={deptFilter}
   listAvailable={departmentsReady}
   onClose={()=>setCreateDepartmentOpen(false)} onSubmit={createDepartment}/>}
  {createGroupOpen&&<CreateGroupDialog options={departmentOptions} defaultDepartmentId={deptFilter}
   listAvailable={departmentsReady}
   onClose={()=>setCreateGroupOpen(false)} onSubmit={createGroup}/>}
 </div>;
}
