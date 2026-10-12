import {useEffect,useState} from "react";
import type {User} from "../../entities/user/model";
import {organizationApi,type Department,type Workgroup} from "./api";
import {observeWorkspaceChange} from "../../shared/resourceSync";

export type LoadState="loading"|"ready"|"failed";

/** Directory data and asynchronous synchronization are isolated from view rendering.
 * Each effect ignores results for a superseded selection or refresh token. */
export function useOrganizationDirectory(isAdmin:boolean,selectedGroup:string){
 const[users,setUsers]=useState<User[]>([]);
 const[departments,setDepartments]=useState<Department[]>([]);
 const[groups,setGroups]=useState<Workgroup[]>([]);
 const[usersState,setUsersState]=useState<LoadState>("loading");
 const[departmentsState,setDepartmentsState]=useState<LoadState>("loading");
 const[groupsState,setGroupsState]=useState<LoadState>("loading");
 const[usersToken,setUsersToken]=useState(0);
 const[departmentsToken,setDepartmentsToken]=useState(0);
 const[groupsToken,setGroupsToken]=useState(0);
 const[groupMembers,setGroupMembers]=useState<User[]>([]);
 const[membersState,setMembersState]=useState<LoadState>("loading");
 const[membersToken,setMembersToken]=useState(0);

 useEffect(()=>{
  if(!isAdmin)return;
  let valid=true;
  setUsersState("loading");
  organizationApi.users()
   .then(data=>{if(valid){setUsers(data);setUsersState("ready");}})
   .catch(()=>{if(valid)setUsersState("failed");});
  return()=>{valid=false;};
 },[isAdmin,usersToken]);

 useEffect(()=>{
  if(!isAdmin)return;
  let valid=true;
  setDepartmentsState("loading");
  organizationApi.departments()
   .then(data=>{if(valid){setDepartments(data);setDepartmentsState("ready");}})
   .catch(()=>{if(valid)setDepartmentsState("failed");});
  return()=>{valid=false;};
 },[isAdmin,departmentsToken]);

 useEffect(()=>{
  if(!isAdmin)return;
  let valid=true;
  setGroupsState("loading");
  organizationApi.groups()
   .then(data=>{if(valid){setGroups(data);setGroupsState("ready");}})
   .catch(()=>{if(valid)setGroupsState("failed");});
  return()=>{valid=false;};
 },[isAdmin,groupsToken]);
 useEffect(()=>observeWorkspaceChange(()=>{
  setUsersToken(token=>token+1);setDepartmentsToken(token=>token+1);
  setGroupsToken(token=>token+1);setMembersToken(token=>token+1);
 },["organization","permissions"]),[]);

 useEffect(()=>{
  if(!isAdmin||selectedGroup==="")return;
  let valid=true;
  setMembersState("loading");
  organizationApi.members(selectedGroup)
   .then(data=>{if(valid){setGroupMembers(data);setMembersState("ready");}})
   .catch(()=>{if(valid){setGroupMembers([]);setMembersState("failed");}});
  return()=>{valid=false;};
 },[isAdmin,selectedGroup,membersToken]);

 return {users,setUsers,departments,setDepartments,groups,setGroups,
  usersState,setUsersState,departmentsState,setDepartmentsState,groupsState,setGroupsState,
  setUsersToken,setDepartmentsToken,setGroupsToken,
  groupMembers,setGroupMembers,membersState,setMembersState,setMembersToken};
}
