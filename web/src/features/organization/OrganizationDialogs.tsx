import {useState,type FormEvent} from "react";
import type {User} from "../../entities/user/model";
import {Dialog} from "../../shared/ui/Dialog";
import {RareButton,RareInput,RareNotice,RareSelect} from "../../shared/ui/rare";

export type DialogResult={ok:string}|{error:string};
type Tone="info"|"error";
const loginOf=(user:User)=>user.login??"";

// Confirmation flows live outside the workbench rendering tree.
// Mutations remain provided by the owning workspace as callbacks.
export function ResetPasswordDialog({target,department,onClose,onSubmit}:{
 target:User;
 department:string;
 onClose:()=>void;
 onSubmit:(password:string)=>Promise<DialogResult>;
}){
 const[password,setPassword]=useState("");
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);
 const[confirmDiscard,setConfirmDiscard]=useState(false);
 const dirty=password!==""&&result===null;

 async function submit(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy||password.length<16)return;
  setBusy(true);
  const outcome=await onSubmit(password);
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else{
   setPassword("");
   setResult({text:outcome.ok,tone:"info"});
  }
 }

 function requestClose(){
  if(busy)return;
  if(dirty){setConfirmDiscard(true);return;}
  onClose();
 }

 return <Dialog open title={`重置密码 — ${target.displayName}`} onClose={onClose} className="org-dialog"
  initialFocus="#org-reset-password"
  closeGuard={()=>{if(busy)return false;if(dirty){setConfirmDiscard(true);return false;}return true;}}>
  {confirmDiscard
   ?<>
    <p className="hint">已输入的新密码将被丢弃，不会提交给服务端。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={()=>setConfirmDiscard(false)} disabled={busy}>继续编辑</RareButton>
     <RareButton type="button" tone="danger" className="danger" onClick={onClose} disabled={busy}>放弃并关闭</RareButton>
    </div>
   </>
   :result
    ?<>
     <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
     <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
    </>
    :<form onSubmit={submit}>
     <p>账号：{loginOf(target)||"—"}</p>
     <p>部门：{department}</p>
     {target.disabled===true&&<p className="hint">该账号当前已禁用：重置密码不会启用账号。</p>}
     <p className="hint">提交后该账号的全部登录会话立即失效，可使用新密码直接登录。</p>
     <label htmlFor="org-reset-password">新密码</label>
     <RareInput id="org-reset-password" type="password" autoComplete="new-password" value={password}
      onChange={event=>setPassword(event.target.value)} disabled={busy}/>
     <p className="hint">至少 16 个字符（客户端只校验长度，密码策略以服务端判定为准）。</p>
     <div className="dialog-actions">
      <RareButton type="button" className="secondary-action" onClick={requestClose} disabled={busy}>取消</RareButton>
      <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={password.length<16}>确认重置密码</RareButton>
     </div>
    </form>}
 </Dialog>;
}

export function SetDisabledDialog({target,department,onClose,onSubmit}:{
 target:User;
 department:string;
 onClose:()=>void;
 onSubmit:()=>Promise<DialogResult>;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);
 const disabling=target.disabled!==true;

 async function run(){
  if(busy)return;
  setBusy(true);
  const outcome=await onSubmit();
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title={disabling?"禁用账号":"启用账号"} onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>账号：{loginOf(target)||"—"}（{target.displayName}）</p>
    <p>部门：{department}</p>
    <p>当前状态：{target.disabled===true?"已禁用":"正常"}</p>
    <p>{disabling
     ?"影响：禁用后该账号立即无法登录，现有登录会话立即失效；其工作组与授权记录保留，启用后恢复。该操作写入审计日志。"
     :"影响：启用后该账号可再次登录，并恢复原有的工作组与授权（最终生效权限由服务端判定）。"}</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone={disabling?"danger":"primary"} className={disabling?"danger":"primary"} loading={busy}>
      {busy?(disabling?"禁用中…":"启用中…"):(disabling?"确认禁用":"确认启用")}
     </RareButton>
    </div>
   </form>}
 </Dialog>;
}

export function RemoveMemberDialog({member,groupName,department,onClose,onSubmit}:{
 member:User;
 groupName:string;
 department:string;
 onClose:()=>void;
 onSubmit:()=>Promise<DialogResult>;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(){
  if(busy)return;
  setBusy(true);
  const outcome=await onSubmit();
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="移除工作组成员" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>工作组：{groupName||"—"}</p>
    <p>成员：{member.displayName}（{loginOf(member)||"—"}）</p>
    <p>部门：{department}</p>
    <p>影响：移除后该账号不再通过本工作组获得授权；直接授予该账号的权限不受影响，最终生效权限由服务端判定。之后可以重新加入。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone="danger" loading={busy}>确认移除</RareButton>
    </div>
   </form>}
 </Dialog>;
}

export function CreateUserConfirmDialog({draft,department,onClose,onSubmit}:{
 draft:{login:string;displayName:string};
 department:string;
 onClose:()=>void;
 onSubmit:()=>Promise<DialogResult>;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(){
  if(busy)return;
  setBusy(true);
  const outcome=await onSubmit();
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="创建账号确认" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={event=>{event.preventDefault();run();}}>
    <p>账号：{draft.login}</p>
    <p>姓名：{draft.displayName}</p>
    <p>部门：{department}</p>
    <p className="hint">密码不会在界面回显；创建后该账号可直接使用此密码登录。</p>
    <p className="hint">取消不会清空表单内容，可以修改后再提交。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>返回修改</RareButton>
     <RareButton type="submit" tone="primary" loading={busy}>确认创建</RareButton>
    </div>
   </form>}
 </Dialog>;
}

export function CreateDepartmentDialog({options,defaultParentId,listAvailable,onClose,onSubmit}:{
 options:{id:string;label:string}[];
 defaultParentId:string;
 listAvailable:boolean;
 onClose:()=>void;
 onSubmit:(name:string,parentId:string)=>Promise<DialogResult>;
}){
 const[name,setName]=useState("");
 const[parentId,setParentId]=useState(defaultParentId);
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy||name.trim()==="")return;
  setBusy(true);
  const outcome=await onSubmit(name.trim(),parentId);
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="新建部门" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={run}>
    <label htmlFor="org-new-department">部门名称</label>
    <RareInput id="org-new-department" value={name} maxLength={80} disabled={busy}
     onChange={event=>setName(event.target.value)}/>
    <label htmlFor="org-new-department-parent">上级部门</label>
    <RareSelect id="org-new-department-parent" className="org-select" value={parentId} disabled={busy}
     onChange={event=>setParentId(event.target.value)}>
     <option value="">（顶层部门）</option>
     {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
    </RareSelect>
    <p className="hint">{listAvailable
     ?"默认挂在部门树当前筛选的部门下（未选择时为顶层部门），可更改。"
     :"部门列表不可用，只能创建顶层部门。"}名称最多 80 个字符；成员与工作组需要另行指派。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={name.trim()===""}>创建部门</RareButton>
    </div>
   </form>}
 </Dialog>;
}

export function CreateGroupDialog({options,defaultDepartmentId,listAvailable,onClose,onSubmit}:{
 options:{id:string;label:string}[];
 defaultDepartmentId:string;
 listAvailable:boolean;
 onClose:()=>void;
 onSubmit:(name:string,departmentId:string)=>Promise<DialogResult>;
}){
 const[name,setName]=useState("");
 const[departmentId,setDepartmentId]=useState(defaultDepartmentId);
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);

 async function run(event:FormEvent<HTMLFormElement>){
  event.preventDefault();
  if(busy||name.trim()==="")return;
  setBusy(true);
  const outcome=await onSubmit(name.trim(),departmentId);
  setBusy(false);
  if("error" in outcome)setResult({text:outcome.error,tone:"error"});
  else setResult({text:outcome.ok,tone:"info"});
 }

 return <Dialog open title="创建工作组" onClose={onClose} closeGuard={()=>!busy} className="org-dialog">
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions"><RareButton type="button" tone="primary" className="primary" onClick={onClose} autoFocus>关闭</RareButton></div>
   </>
   :<form onSubmit={run}>
    <label htmlFor="org-new-group">工作组名称</label>
    <RareInput id="org-new-group" value={name} maxLength={80} disabled={busy}
     onChange={event=>setName(event.target.value)}/>
    <label htmlFor="org-new-group-department">所属部门</label>
    <RareSelect id="org-new-group-department" className="org-select" value={departmentId} disabled={busy}
     onChange={event=>setDepartmentId(event.target.value)}>
     <option value="">（不指定部门）</option>
     {options.map(option=><option key={option.id} value={option.id}>{option.label}</option>)}
    </RareSelect>
    <p className="hint">{listAvailable
     ?"默认使用部门树当前筛选的部门（未选择时留空），可更改。"
     :"部门列表不可用，只能创建不指定部门的工作组。"}名称最多 80 个字符；成员在创建后于“添加成员”中维护。</p>
    <div className="dialog-actions">
     <RareButton type="button" className="secondary-action" onClick={onClose} disabled={busy}>取消</RareButton>
     <RareButton type="submit" tone="primary" className="primary" loading={busy} disabled={name.trim()===""}>创建工作组</RareButton>
    </div>
   </form>}
 </Dialog>;
}


/** Explicit group deletion confirmation; no mutation occurs on opening the dialog. */
export function DeleteWorkgroupDialog({name,count,onClose,onSubmit,onOpenPermissions}:{
 name:string;count:number;onClose:()=>void;onSubmit:()=>Promise<DialogResult>;
 onOpenPermissions:()=>void;
}){
 const[busy,setBusy]=useState(false);
 const[result,setResult]=useState<{text:string;tone:Tone}|null>(null);
 async function run(){
  if(busy)return;
  setBusy(true);
  try{
   const outcome=await onSubmit();
   if("error" in outcome)setResult({text:outcome.error,tone:"error"});
   else setResult({text:outcome.ok,tone:"info"});
  }finally{setBusy(false);}
 }
 return <Dialog open title="删除工作组" className="org-dialog" onClose={onClose} closeGuard={()=>!busy}>
  {result
   ?<>
    <RareNotice tone={result.tone==="error"?"danger":"success"}>{result.text}</RareNotice>
    <div className="dialog-actions">
     {result.tone==="error"&&<RareButton type="button" onClick={onOpenPermissions}>查看权限管理</RareButton>}
     <RareButton type="button" tone="primary" className="primary" onClick={onClose}>关闭</RareButton>
    </div>
   </>
   :<>
    <p>确定删除工作组「{name}」？</p>
    <p>将解除该组的 {count} 个成员关联。成员账号及其个人授权不会被删除。</p>
    <p className="hint">如果该组仍有文件夹授权或共享引用，服务端会拒绝删除。</p>
    <div className="dialog-actions">
     <RareButton type="button" onClick={onClose}>取消</RareButton>
     <RareButton type="button" tone="danger" className="danger" disabled={busy} loading={busy} onClick={()=>void run()}>
      确认删除工作组
     </RareButton>
    </div>
   </>}
 </Dialog>;
}
