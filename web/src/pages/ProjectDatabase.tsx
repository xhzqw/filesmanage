// ProjectDatabase.tsx
// 「项目」工作台组件 —— 对标 Notion Database 的多视图项目/任务管理。
// 挂载方式见 BACKEND-API.md §0 / SPEC-project-db.md §5：作为 CDWWorkbench 侧边栏第二组
// 「项目与任务」的两个一级视图（projects / my-projects）。
// 数据契约见 project-db/react/project-api.ts → 落地为 web/src/features/projects/api.ts。
// 落地位置：web/src/pages/ProjectDatabase.tsx（与 CDWWorkbench.tsx、projectIcons.tsx 同目录）。
// 后端对接规范见 BACKEND-API.md。

import{useEffect,useMemo,useRef,useState}from "react";
import{Link,useSearchParams}from "react-router-dom";
import type{User}from "../entities/user/model";
import{RareButton,RareInput,RareSelect,RareTextarea,RareNotice}from "../shared/ui/rare";
import{toast}from "../shared/ui/feedback";
import{errorCopy}from "../shared/errors";
import{newIdempotencyKey}from "../shared/ids";
import{organizationApi}from "../features/organization/api";
import{observeWindowReturn}from "../shared/resourceSync";
import{DocumentPicker,type PickedDocument,type DocumentPickerSource}from "../shared/ui/DocumentPicker";
import{fileApi}from "../features/documents/api";
import{folderApi}from "../features/folders/api";
import{FileTypeIcon}from "../shared/ui/FileTypeIcon";
import{projectApi,type Project,type ProjectStatus,type ProjectPriority,type ProjectTeam,type ProjectWriteInput}from "../features/projects/api";
import"./projectDatabase.css";

/* ------------------------- 常量 ------------------------- */
const STATUS:Record<ProjectStatus,{label:string;tone:"neutral"|"info"|"success"}>={
 notstarted:{label:"未开始",tone:"neutral"},
 progress:{label:"进行中",tone:"info"},
 done:{label:"已完成",tone:"success"},
};
const ST_KEYS=Object.keys(STATUS) as ProjectStatus[];
const PRI_TONE:Record<ProjectPriority,string>={high:"h",mid:"m",low:"l"};
const PRI_LABEL:Record<ProjectPriority,string>={high:"高",mid:"中",low:"低"};
const TEAMS:ProjectTeam[]=["","销售部","产品设计","人力资源","供应链","工程部","文件管理"];
const ICONS=["◇","◈","▦","✦","◎"];

// 「关联文档」选择器的数据源：shared/ui/DocumentPicker 不依赖 features，
// 由本页（page 层）把真实的受控文件读取接口注入进去。
const DOC_SOURCE:DocumentPickerSource={
 folders:parentId=>folderApi.children(parentId,"").then(page=>
  (page.items??[]).filter(f=>f.canSelect!==false).map(f=>({id:f.id,name:f.name,hasChildren:!!f.hasChildren}))),
 files:(folderId,cursor,signal)=>fileApi.list(folderId,"name_asc",cursor,20,signal).then(page=>({
  items:(page.items??[]).map(f=>({id:f.id,name:f.name,sizeBytes:f.sizeBytes,updatedAt:f.updatedAt})),
  nextCursor:page.nextCursor??"",
 })),
};

const ORIGIN=Date.parse("2025-01-01");
const DAY=86400000;
const SPAN=365;
const MONTH_L=["1月","2月","3月","4月","5月","6月","7月","8月","9月","10月","11月","12月"];
function dayIdx(t:number){return Math.round((t-ORIGIN)/DAY);}
function isoDate(d:Date){return d.getFullYear()+"-"+String(d.getMonth()+1).padStart(2,"0")+"-"+String(d.getDate()).padStart(2,"0");}
function fmtDate(iso:string|null){return iso?iso.split("-")[1]+"/"+iso.split("-")[2]+"/"+iso.split("-")[0]:"—";}

type ViewKind="board"|"table"|"gantt";
interface ColVis{status:boolean;owner:boolean;priority:boolean;team:boolean;start:boolean;end:boolean;progress:boolean}
const DEFAULT_COLVIS:ColVis={status:true,owner:true,priority:true,team:true,start:true,end:true,progress:true};
const COLVIS_FIELDS:[keyof ColVis,string,string][]=[
 ["status","◔","状态"],["owner","☺","负责人"],["priority","◎","优先级"],
 ["team","▤","团队"],["start","▭","开始日期"],["end","▭","结束日期"],["progress","◍","进度"],
];

interface Draft{
 name:string;icon:string;description:string;status:ProjectStatus;ownerId:string;
 team:ProjectTeam;priority:ProjectPriority;startDate:string|null;endDate:string|null;
 progress:number;favorite:boolean;
}
const emptyDraft=():Draft=>({
 name:"",icon:"◇",description:"",status:"notstarted",ownerId:"",team:"",
 priority:"mid",startDate:null,endDate:null,progress:0,favorite:false,
});
function draftOf(p:Project):Draft{
 return{name:p.name,icon:p.icon,description:p.description,status:p.status,ownerId:p.ownerId,
  team:p.team,priority:p.priority,startDate:p.startDate,endDate:p.endDate,progress:p.progress,favorite:p.favorite};
}
function inputOf(d:Draft):ProjectWriteInput{
 return{name:d.name.trim(),icon:d.icon,description:d.description,status:d.status,ownerId:d.ownerId,
  team:d.team,priority:d.priority,startDate:d.startDate||null,endDate:d.endDate||null,progress:d.progress};
}

export function ProjectDatabase({user,initialScope="all"}:{
 user:User;initialScope?:"all"|"mine";
}){
 const[params,setParams]=useSearchParams();
 const[projects,setProjects]=useState<Project[]>([]);
 const[busy,setBusy]=useState(true);
 const[error,setError]=useState("");
 const[refreshToken,refresh]=useState(0);

 const[view,setView]=useState<ViewKind>(params.get("view")==="table"?"table":params.get("view")==="gantt"?"gantt":"board");
 const[colVis,setColVis]=useState<ColVis>(DEFAULT_COLVIS);
 const[sort,setSort]=useState<{field:string;dir:1|-1}>({field:"none",dir:1});
 const[filterStatus,setFilterStatus]=useState<Record<ProjectStatus,boolean>>({notstarted:true,progress:true,done:true});
 const[scope,setScope]=useState<"all"|"mine">(initialScope);
 const[search,setSearch]=useState("");
 const[ganttScale,setGanttScale]=useState<0|1>(0);

 const[drawer,setDrawer]=useState<{mode:"new"|"edit";id:number;draft:Draft}|null>(null);
 // 与 drawer 同步的 ref：窗口重新获得焦点时要用最新值，又不能因此重新订阅事件
 const drawerRefState=useRef<{mode:"new"|"edit";id:number}|null>(null);
 useEffect(()=>{drawerRefState.current=drawer?{mode:drawer.mode,id:drawer.id}:null;},[drawer]);
 const[detail,setDetail]=useState<Project|null>(null);
 const[processing,setProcessing]=useState(false);
 const[colVisOpen,setColVisOpen]=useState(false);
 const[users,setUsers]=useState<User[]>([]);
 const requestKeys=useRef(new Map<string,string>());
 // 评论/待办输入保持受控：提交成功才清空，失败时用户输入不丢
 const[cmtText,setCmtText]=useState("");
 const[todoText,setTodoText]=useState("");
 const[todoBusy,setTodoBusy]=useState(false);
 // 「关联文档」走真实的受控文件选择器；记录本次要关联到哪个项目
 const[docPickerFor,setDocPickerFor]=useState<number|null>(null);

 /* 数据获取 */
 useEffect(()=>{
  const controller=new AbortController();let active=true;
  setBusy(true);setError("");
  projectApi.list(controller.signal).then(page=>{if(active)setProjects(page.items??[]);})
   .catch(e=>{if(active&&!(e instanceof DOMException&&e.name==="AbortError"))setError(errorCopy(e,"项目加载失败"));})
   .finally(()=>{if(active)setBusy(false);});
  return()=>{active=false;controller.abort();};
 },[refreshToken,user.id]);

 useEffect(()=>{
  let live=true;
  projectApi.getView().then(({config})=>{
   if(!live||!config)return;
   if(config.colVis)setColVis({...DEFAULT_COLVIS,...config.colVis});
   if(config.sort)setSort(config.sort);
   if(config.filters?.status)setFilterStatus(config.filters.status);
   if(config.scope)setScope(config.scope);
   if(config.columnConfig?.ganttScale!=null)setGanttScale(config.columnConfig.ganttScale);
  }).catch(()=>undefined);
  return()=>{live=false;};
 },[user.id]);

 useEffect(()=>{
  let live=true;
  organizationApi.users().then(l=>{if(live)setUsers(l);}).catch(()=>undefined);
  return()=>{live=false;};
 },[user.id]);

 /* 从文件预览页切回时刷新：文件可能已被改名/删除，抽屉里的关联文档要保持真实 */
 useEffect(()=>observeWindowReturn(()=>{
  refresh(v=>v+1);
  // 用 ref 读当前抽屉 id，避免把它们放进依赖导致频繁重订阅
  const open=drawerRefState.current;
  if(open&&open.mode==="edit"){
   projectApi.get(open.id).then(r=>{if(r?.project)setDetail(r.project);}).catch(()=>undefined);
  }
 // eslint-disable-next-line react-hooks/exhaustive-deps
 }),[user.id]);

 /* 视图状态落库（防抖） */
 useEffect(()=>{
  const when=window.setTimeout(()=>{
   void projectApi.putView({
    colVis,
    sort,
    filters:{status:filterStatus},
    scope,
    view,
    columnConfig:{ganttScale},
   }).catch(()=>undefined);
  },450);
  return()=>window.clearTimeout(when);
 },[colVis,sort,filterStatus,scope,view,ganttScale]);

 const visible=useMemo(()=>{
  const q=search.trim().toLocaleLowerCase();
  let list=projects.filter(p=>!p.archived).filter(p=>scope!=="mine"||p.ownerId===user.id)
   .filter(p=>filterStatus[p.status]!==false).filter(p=>!q||p.name.toLocaleLowerCase().includes(q));
  if(sort.field!=="none"&&sort.field!=="name"){
   const f=sort.field;
   list=[...list].sort((a,b)=>{
    if(f==="priority")return (["high","mid","low"].indexOf(a.priority)-["high","mid","low"].indexOf(b.priority))*sort.dir;
    const av=a[f as keyof Project] as unknown;const bv=b[f as keyof Project] as unknown;
    if(typeof av==="number"&&typeof bv==="number")return(av-bv)*sort.dir;
    if(typeof av==="string"&&typeof bv==="string")return av.localeCompare(bv)*sort.dir;
    return 0;
   });
  }
  return list;
 },[projects,scope,search,filterStatus,sort,user.id]);

 // 工作区计数：口径统一为「未归档」，与左栏徽标一致，不受当前筛选影响
 const scopeCount=useMemo(()=>{
  const live=projects.filter(p=>!p.archived);
  return{all:live.length,mine:live.filter(p=>p.ownerId===user.id).length};
 },[projects,user.id]);

 // 搜索有词但无命中 ≠ 一条数据都没有，两种空态要给不同出口
 const emptyKind:""|"search"|"filter"|"none"=useMemo(()=>{
  const live=projects.filter(p=>!p.archived);
  if(!live.length)return"none";
  if(visible.length)return"";
  return search.trim()?"search":"filter";
 },[projects,visible,search]);

 const groups=useMemo(()=>{
  const g:Record<ProjectStatus,Project[]>={notstarted:[],progress:[],done:[]};
  visible.forEach(p=>g[p.status].push(p));
  // 列内稳定排序：优先级高→低，再按结束日期近→远，避免接口返回顺序抖动
  const pri=["high","mid","low"] as ProjectPriority[];
  ST_KEYS.forEach(st=>g[st].sort((a,b)=>{
   const d=pri.indexOf(a.priority)-pri.indexOf(b.priority);if(d)return d;
   const ae=a.endDate??"9999-99-99",be=b.endDate??"9999-99-99";
   return ae.localeCompare(be);
  }));
  return g;
 },[visible]);

 /* 写操作 */
 // 快速连改（表格内联下拉）时用 pending 集合而不是全屏 processing 锁，
 // 否则一次下拉会让整张表短暂失去响应。
 const inflight=useRef(new Set<string>());
 async function patch(id:number,patch:Partial<ProjectWriteInput>&{favorite?:boolean},name?:string){
  // 幂等键必须按「项目 + 字段集」区分：同一项目同一批字段在途时复用同一个键
  // （重试不产生重复写入），不同字段则用新键（否则会被后端当成重复请求丢弃）。
  const sig="patch:"+id+":"+Object.keys(patch).sort().join(",");
  if(inflight.current.has(sig))return;
  inflight.current.add(sig);
  const key=requestKeys.current.get(sig)??newIdempotencyKey();
  requestKeys.current.set(sig,key);
  try{
   await toast.track(()=>projectApi.update(id,patch),{loading:"正在保存…",success:name?`已保存「${name}」`:"已更新",error:e=>errorCopy(e,"保存失败")});
   requestKeys.current.delete(sig);refresh(v=>v+1);
  }catch{return;}finally{inflight.current.delete(sig);}
 }
 // 抽屉保存走全屏锁（一次提交整份草稿）
 async function patchFull(id:number,patch:Partial<ProjectWriteInput>&{favorite?:boolean},name?:string){
  if(processing)return;
  setProcessing(true);
  const sig="full:"+id;
  const key=requestKeys.current.get(sig)??newIdempotencyKey();
  requestKeys.current.set(sig,key);
  try{
   await toast.track(()=>projectApi.update(id,patch),{loading:"正在保存…",success:name?`已保存「${name}」`:"已更新",error:e=>errorCopy(e,"保存失败")});
   requestKeys.current.delete(sig);refresh(v=>v+1);
   return true;
  }catch{return false;}finally{setProcessing(false);}
 }
 async function create(input:ProjectWriteInput){
  if(processing)return;
  setProcessing(true);
  try{
   await toast.track(()=>projectApi.create(input),{loading:"正在创建…",success:"项目已创建",error:e=>errorCopy(e,"创建失败")});
   refresh(v=>v+1);setDrawer(null);setDetail(null);
  }finally{setProcessing(false);}
 }

 function openDrawer(mode:"new"|"edit",p?:Project){
  if(p){setDetail(p);setDrawer({mode,id:p.id,draft:draftOf(p)});projectApi.get(p.id).then(r=>{if(r?.project)setDetail(r.project);}).catch(()=>undefined);}
  else{setDetail(null);setDrawer({mode:"new",id:0,draft:emptyDraft()});}
  setColVisOpen(false);
 }
 function setDraft(patch:Partial<Draft>){setDrawer(d=>d?{...d,draft:{...d.draft,...patch}}:d);}
 // 有未保存改动时关抽屉要拦一下，避免白填一遍
 const dirty=useMemo(()=>{
  if(!drawer)return false;
  if(drawer.mode==="new")return JSON.stringify(drawer.draft)!==JSON.stringify(emptyDraft());
  const p=projects.find(x=>x.id===drawer.id);
  return !!p&&JSON.stringify(drawer.draft)!==JSON.stringify(draftOf(p));
 },[drawer,projects]);

 function closeDrawer(force=false){
  if(!force&&drawer&&(drawer.mode==="edit"||dirty)){
   if(dirty&&!window.confirm("还有未保存的改动，确定关闭？"))return;
  }
  setDrawer(null);setDetail(null);
 }
 async function saveDrawer(){
  if(!drawer)return;
  if(!drawer.draft.name.trim()){toast.info("请填写项目名称");return;}
  if(drawer.draft.startDate&&drawer.draft.endDate&&drawer.draft.endDate<drawer.draft.startDate){toast.error("结束日期不能早于开始日期");return;}
  if(drawer.mode==="new"){await create(inputOf(drawer.draft));}
  else{const ok=await patchFull(drawer.id,inputOf(drawer.draft),drawer.draft.name);if(ok)closeDrawer(true);}
 }
 async function toggleFav(){
  if(!drawer)return;
  const p=projects.find(x=>x.id===drawer.id);
  const fav=!drawer.draft.favorite;
  setDraft({favorite:fav});
  if(p){await patch(p.id,{favorite:fav});setDetail(d=>d&&d.id===p.id?{...d,favorite:fav}:d);}
 }
 async function archiveMe(){
  if(!drawer)return;
  const p=projects.find(x=>x.id===drawer.id);if(!p)return;
  if(!window.confirm("归档后「"+p.name+"」将从列表隐藏，可在回收站之外的归档视图找回。确认归档？"))return;
  try{await toast.track(()=>projectApi.archive(p.id),{loading:"正在归档…",success:"已归档",error:e=>errorCopy(e,"归档失败")});
   refresh(v=>v+1);closeDrawer(true);}catch{}
 }
 async function removeMe(){
  if(!drawer)return;
  const p=projects.find(x=>x.id===drawer.id);if(!p)return;
  if(!window.confirm("确认删除「"+p.name+"」？"))return;
  try{await toast.track(()=>projectApi.remove(p.id),{loading:"正在删除…",success:"已删除",error:e=>errorCopy(e,"删除失败")});refresh(v=>v+1);closeDrawer(true);}catch{}
 }

 function refreshDetail(id:number){
  projectApi.get(id).then(res=>{if(res?.project)setDetail(res.project);}).catch(()=>undefined);
 }
 async function commentNow(id:number,text:string){
  try{
   await toast.track(()=>projectApi.addComment(id,text),{loading:"…",success:"已评论",error:e=>errorCopy(e,"评论失败")});
   setCmtText("");refreshDetail(id);
  }catch{/* 失败保留输入，用户可直接重试 */}
 }
 function todoToggle(id:number,todoId:string,done:boolean){
  return toast.track(()=>projectApi.setTodo(id,todoId,done),{loading:"…",success:"已更新",error:e=>errorCopy(e,"保存失败")}).then(()=>refreshDetail(id));
 }
 async function todoAdd(id:number,text:string){
  setTodoBusy(true);
  try{
   await toast.track(()=>projectApi.addTodo(id,text),{loading:"…",success:"待办已添加",error:e=>errorCopy(e,"保存失败")});
   setTodoText("");refreshDetail(id);
  }catch{/* 同上，保留输入 */}finally{setTodoBusy(false);}
 }
 function todoRemove(id:number,todoId:string){
  return toast.track(()=>projectApi.removeTodo(id,todoId),{loading:"…",success:"已删除",error:e=>errorCopy(e,"保存失败")}).then(()=>refreshDetail(id));
 }
 function docRemove(id:number,docId:string){
  return toast.track(()=>projectApi.removeDoc(id,docId),{loading:"…",success:"已解除关联",error:e=>errorCopy(e,"保存失败")}).then(()=>refreshDetail(id));
 }
 // 从受控文件库里挑真实文件；一次可挑多份，用批量接口一次提交，
 // 避免逐个 POST 出现「关联了一半」的中间态。
 async function attachDocs(id:number,docs:PickedDocument[]){
  if(!docs.length)return;
  try{
   await toast.track(()=>projectApi.addDocs(id,docs),
    {loading:"正在关联 "+docs.length+" 份文档…",success:"已关联 "+docs.length+" 份文档",error:e=>errorCopy(e,"关联失败")});
   refreshDetail(id);refresh(v=>v+1);
  }catch{/* toast 已提示，用户可重试 */}
 }
 function onDelete(p:Project){
  if(!window.confirm("确认删除「"+p.name+"」？"))return;
  void toast.track(()=>projectApi.remove(p.id),{loading:"正在删除…",success:"已删除",error:e=>errorCopy(e,"删除失败")}).then(()=>refresh(v=>v+1));
 }

 const dragId=useRef<number|null>(null);
 function dropCol(status:ProjectStatus){return(ev:React.DragEvent)=>{ev.preventDefault();const id=dragId.current;dragId.current=null;if(id==null)return;const p=projects.find(x=>x.id===id);if(!p||p.status===status)return;const body:Partial<ProjectWriteInput>={status};if(status==="done")body.progress=100;void patch(id,body,p.name);};}

 // 抽屉 Esc 关闭 + 打开时把焦点移进去（键盘用户不被困在背景）
 const drawerRef=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  if(!drawer)return;
  const prev=document.activeElement as HTMLElement|null;
  const node=drawerRef.current?.querySelector<HTMLInputElement>(".pj-dr-title");
  node?.focus();
  if(drawer.mode==="edit")node?.select();
  function onKey(ev:KeyboardEvent){
   if(ev.key==="Escape"){ev.stopPropagation();closeDrawer();}
  }
  document.addEventListener("keydown",onKey);
  return()=>{document.removeEventListener("keydown",onKey);prev?.focus?.();};
  // eslint-disable-next-line react-hooks/exhaustive-deps
 },[drawer?.mode,drawer?.id]);

 function setViewWrite(k:ViewKind){setView(k);setParams(prev=>{const n=new URLSearchParams(prev);n.set("view",k);return n;},{replace:true});}
 function toggleStatus(k:ProjectStatus){setFilterStatus(s=>({...s,[k]:!s[k]}));}

 /* ============================ 渲染 ============================ */
 // 纯内容组件：不套 AppShell、不带自己的侧栏。
 // 它作为工作台的一个视图渲染，侧栏由 CDWWorkbench 提供，避免出现「两套壳」。
 return<>
     <div className="pj-shell">
      <header className="pj-header"><div className="pj-crumb">赖·威威的工作空间 总部 <span>/</span> <b>项目</b></div></header>
      <div className="pj-title-row">
       <div><h1 className="pj-h1">项目</h1><p className="pj-sub">统一管理研发、受控流程与部门协作项目的进度、负责人与交付状态</p></div>
       <RareButton type="button" tone="primary" onClick={()=>openDrawer("new")}>＋ 新建项目</RareButton>
      </div>
      <div className="pj-scope-tabs">
       <RareButton type="button" className={"pj-scope"+(scope==="all"?" active":"")} onClick={()=>setScope("all")}>全部项目</RareButton>
       <RareButton type="button" className={"pj-scope"+(scope==="mine"?" active":"")} onClick={()=>setScope("mine")}>我的项目</RareButton>
      </div>

      <div className="pj-toolbar">
       <div className="pj-view-toggle">
        {([["board","看板"],["table","表格"],["gantt","甘特"]]as[ViewKind,string][]).map(([k,l])=>
         <RareButton key={k} type="button" className={"pj-vt"+(view===k?" active":"")} onClick={()=>setViewWrite(k)}>{l}</RareButton>)}
       </div>
       <span className="pj-tool-spacer"/>
       <div className="pj-search-wrap"><RareInput type="search" className="pj-search" placeholder="搜索项目…" value={search} onChange={e=>setSearch(e.target.value)} aria-label="搜索项目"/></div>
       <RareButton type="button" tone="ghost" className={colVisOpen?"is-active":""} onClick={()=>setColVisOpen(v=>!v)}>列</RareButton>
      </div>

      <div className="pj-filterbar">
       <span className="pj-meta">{visible.length} 个项目{visible.length!==scopeCount[scope]?<small className="pj-meta-total"> / 共 {scopeCount[scope]}</small>:null}</span>
       <RareSelect searchable className="pj-sort" aria-label="排序" value={sort.field} onChange={ev=>setSort({field:ev.target.value,dir:1})}>
        <option value="none">默认排序</option><option value="name">名称</option><option value="priority">优先级</option>
        <option value="progress">进度</option><option value="startDate">开始日期</option><option value="ownerName">负责人</option>
       </RareSelect>
       <span className="pj-fgroup">{ST_KEYS.map(s=>
        <RareButton key={s} type="button" tone={filterStatus[s]?"primary":"neutral"} className="pj-fstatus" aria-pressed={filterStatus[s]} onClick={()=>toggleStatus(s)}>{STATUS[s].label}</RareButton>)}
       </span>
      </div>

      {/* 错误与加载态沿用工作台既有写法：RareNotice + .cdw-message，
          不要在这里另造一套提示样式。 */}
      {error&&<><RareNotice tone="danger">{error} <RareButton type="button" onClick={()=>refresh(v=>v+1)}>重试</RareButton></RareNotice>
       <div className="pj-error-hold" aria-hidden="true"/></>}
      {busy&&!projects.length&&<div className="cdw-message">加载项目…</div>}

      {/* 三种「空」必须分开说：没有数据 / 搜索无命中 / 筛选无结果，否则用户会误判成系统丢了数据。
          结构对齐工作台 .cdw-empty：图标块 + strong + p + 按钮。 */}
      {!busy&&!error&&emptyKind==="none"&&(
       <div className="cdw-empty"><span className="cdw-empty-icon" aria-hidden="true">▤</span>
        <strong>还没有任何项目</strong>
        <p>点击「＋ 新建项目」登记第一个项目</p>
        <RareButton type="button" tone="primary" onClick={()=>openDrawer("new")}>新建项目</RareButton></div>)}
      {!busy&&!error&&emptyKind==="search"&&(
       <div className="cdw-empty"><span className="cdw-empty-icon" aria-hidden="true">⌕</span>
        <strong>没有匹配「{search.trim()}」的项目</strong>
        <p>可以更换关键词继续查找，或清空搜索回到全部项目</p>
        <RareButton type="button" tone="ghost" onClick={()=>setSearch("")}>清除搜索</RareButton></div>)}
      {!busy&&!error&&emptyKind==="filter"&&(
       <div className="cdw-empty"><span className="cdw-empty-icon" aria-hidden="true">◔</span>
        <strong>当前筛选条件下没有项目</strong>
        <p>已隐藏 {ST_KEYS.filter(s=>!filterStatus[s]).map(s=>STATUS[s].label).join("、")} 的项目</p>
        <RareButton type="button" tone="ghost" onClick={()=>setFilterStatus({notstarted:true,progress:true,done:true})}>显示全部状态</RareButton></div>)}

      {!busy&&visible.length>0&&(view==="board"?renderBoard():view==="table"?renderTable():
       <ProjectGantt key={ganttScale} projects={visible} scale={ganttScale} onScale={setGanttScale}
        onBarClick={p=>openDrawer("edit",p)} onPatch={(id,pg)=>void patch(id,pg)}/>)}
     </div>

     {colVisOpen&&<div className="pj-colvis">
      <div className="pj-cv-cap">属性可见性</div>
      <p className="pj-cv-sub">控制「表格」与侧边抽屉中这些属性行的显示（看板卡片始终全显）</p>
      {COLVIS_FIELDS.map(([k,ic,l])=>
       <RareButton type="button" tone="ghost" className="pj-cv-item" key={k} aria-pressed={colVis[k]} onClick={()=>setColVis(c=>({...c,[k]:!c[k]}))}>
        <span className="pj-ic" aria-hidden="true">{ic}</span><span>{l}</span><i className={"pj-cv-check"+(colVis[k]?" on":"")}>{colVis[k]?"✓":""}</i>
       </RareButton>)}
      <div className="pj-cv-foot">点击切换可见性</div>
     </div>}

     {drawer&&renderDrawer()}

     {/* 文档选择器用原生 <dialog> 顶层渲染，所以挂在抽屉里面也不会被遮罩压住 */}
     <DocumentPicker
      open={docPickerFor!=null}
      source={DOC_SOURCE}
      excludeIds={detail?.docs.map(d=>d.docId)??[]}
      onPick={docs=>{if(docPickerFor!=null)void attachDocs(docPickerFor,docs);}}
      onClose={()=>setDocPickerFor(null)}/>
 </>;

 function renderBoard(){
  return<div className="pj-board">{[...ST_KEYS].reverse().map(st=>
   <div className="pj-col" key={st} data-status={st} onDragOver={e=>e.preventDefault()} onDrop={dropCol(st)}>
    <div className="pj-col-head"><span className={"pj-dot pj-dot-"+(STATUS[st].tone==="success"?"d":STATUS[st].tone==="info"?"p":"n")}/><b>{STATUS[st].label}</b><span className="pj-col-count">{groups[st].length}</span></div>
    <div className="pj-col-body">
     {groups[st].map(p=>
      <div className={"pj-card pj-card-"+PRI_TONE[p.priority]} key={p.id} draggable tabIndex={0}
       role="button" aria-label={p.name+"，"+STATUS[p.status].label+"，优先级"+PRI_LABEL[p.priority]}
       onDragStart={e=>{dragId.current=p.id;e.dataTransfer.effectAllowed="move";}}
       onKeyDown={e=>{
        // 键盘等价于拖拽：← / → 换到相邻列，Enter 打开详情
        if(e.key==="Enter"||e.key===" "){e.preventDefault();openDrawer("edit",p);return;}
        const order=[...ST_KEYS].reverse();
        const i=order.indexOf(p.status);
        if(e.key==="ArrowLeft"||e.key==="ArrowRight"){
         e.preventDefault();
         const ni=Math.max(0,Math.min(order.length-1,i+(e.key==="ArrowRight"?1:-1)));
         const target=order[ni];if(!target||target===p.status)return;
         const body:Partial<ProjectWriteInput>={status:target};if(target==="done")body.progress=100;
         void patch(p.id,body,p.name);
         // 焦点跟随卡片进入新列
         requestAnimationFrame(()=>{
          const next=document.querySelector<HTMLElement>('.pj-col[data-status="'+target+'"] .pj-card[data-pid="'+p.id+'"]');
          next?.focus();
         });
        }
       }}
       onClick={()=>openDrawer("edit",p)} data-pid={p.id}>
       <RareButton type="button" tone="ghost" className="pj-card-peek" title="在侧边打开" aria-label="在侧边打开" onClick={ev=>{ev.stopPropagation();openDrawer("edit",p);}}>◫</RareButton>
       <div className="pj-card-title">{p.name}{p.favorite?<span className="pj-fav" aria-label="已收藏"> ★</span>:null}</div>
       <div className="pj-card-progress"><div className="pj-progress-bar"><i style={{width:p.progress+"%"}}/></div><b>{p.progress}%</b></div>
       <div className="pj-card-meta">
        {p.team&&<span className="pj-pill pj-pill-team">{p.team}</span>}
        <span className={"pj-pill pj-pr-"+PRI_TONE[p.priority]}>{PRI_LABEL[p.priority]}</span>
        <span className="pj-spacer"/>{p.ownerName&&<span className="pj-avatar" title={p.ownerName}>{p.ownerName[0]}</span>}
       </div>
      </div>)}
     {groups[st].length===0&&<div className="pj-col-empty">这一列还空着</div>}
     <RareButton type="button" tone="ghost" className="pj-col-add" onClick={()=>openDrawer("new")}>＋ 新建项目</RareButton>
    </div>
   </div>)}
  </div>;
 }

 function renderTable(){
  const th=(f:string,l:string)=>(<th key={f} className={sort.field===f?"sorted":""} onClick={()=>setSort(s=>({field:f,dir:s.field===f?(s.dir*-1 as 1|-1):1}))}>{l}{sort.field===f?(sort.dir>0?" ↑":" ↓"):""}</th>);
  const heads:React.ReactNode[]=[th("name","项目名称")];
  if(colVis.status)heads.push(th("status","状态"));
  if(colVis.owner)heads.push(th("ownerName","负责人"));
  if(colVis.priority)heads.push(th("priority","优先级"));
  if(colVis.start)heads.push(th("startDate","开始"));
  if(colVis.end)heads.push(th("endDate","结束"));
  if(colVis.team)heads.push(th("team","团队"));
  if(colVis.progress)heads.push(<th key="progress-col">进度</th>);
  heads.push(<th key="h-x"/>);
  return<table className="pj-table"><thead><tr>{heads}</tr></thead><tbody>{
   visible.map(p=>{
    const cells:React.ReactNode[]=[<td key="name" className="pj-td-name"><span className={"pj-prio-tag "+PRI_TONE[p.priority]}/>{p.name}</td>];
    if(colVis.status)cells.push(<td key="st"><RareSelect className="pj-sel" aria-label={"状态：" + p.name} value={p.status} onChange={e=>void patch(p.id,{status:e.target.value as ProjectStatus},p.name)}>{ST_KEYS.map(s=><option key={s} value={s}>{STATUS[s].label}</option>)}</RareSelect></td>);
    if(colVis.owner)cells.push(<td key="ow"><RareSelect searchable className="pj-sel" aria-label={"负责人：" + p.name} value={p.ownerId} onChange={e=>void patch(p.id,{ownerId:e.target.value},p.name)}><option value="">—</option>{users.map(u=><option key={u.id} value={u.id} disabled={!!u.disabled}>{u.displayName}</option>)}</RareSelect></td>);
    if(colVis.priority)cells.push(<td key="pr"><RareSelect className="pj-sel" aria-label={"优先级：" + p.name} value={p.priority} onChange={e=>void patch(p.id,{priority:e.target.value as ProjectPriority},p.name)}>{(["high","mid","low"]as ProjectPriority[]).map(pr=><option key={pr} value={pr}>{PRI_LABEL[pr]}</option>)}</RareSelect></td>);
    if(colVis.start)cells.push(<td key="sa" className="pj-mono">{fmtDate(p.startDate)}</td>);
    if(colVis.end)cells.push(<td key="en" className="pj-mono">{fmtDate(p.endDate)}</td>);
    if(colVis.team)cells.push(<td key="te"><RareSelect className="pj-sel" aria-label={"团队：" + p.name} value={p.team} onChange={e=>void patch(p.id,{team:e.target.value as ProjectTeam},p.name)}>{TEAMS.map(t=><option key={t} value={t}>{t||"—"}</option>)}</RareSelect></td>);
    if(colVis.progress)cells.push(<td key="pg"><div className="pj-progress-cell"><div className="pj-progress-bar"><i style={{width:p.progress+"%"}}/></div><b>{p.progress}%</b></div></td>);
    cells.push(<td key="x"><RareButton type="button" tone="danger" className="pj-del" title="删除" aria-label={"删除 " + p.name} onClick={e=>{e.stopPropagation();onDelete(p);}}>🗑</RareButton></td>);
    return<tr key={p.id} onClick={()=>openDrawer("edit",p)}>{cells}</tr>;})}
   {visible.length===0&&<tr><td colSpan={heads.length} className="empty">当前筛选下没有项目</td></tr>}
  </tbody></table>;
 }

 function renderDrawer(){
  if(!drawer)return null;
  const d=drawer.draft;
  const PersonRow=({label,glyph,show,children}:{label:string;glyph:string;show:boolean;children:React.ReactNode})=>
   show?<div className="pj-prop"><span className="pj-p-ic">{glyph}</span><span className="pj-p-label">{label}</span><span className="pj-p-val">{children}</span></div>:null;
  return<div className="pj-mask" onClick={()=>closeDrawer()}>
   <aside className="pj-drawer" ref={drawerRef} role="dialog" aria-modal="true" aria-label={drawer.mode==="new"?"新建项目":"编辑项目"} onClick={e=>e.stopPropagation()}>
    <div className="pj-dr-head">
     <RareButton type="button" tone="ghost" className="pj-dr-icon" title="更换图标" aria-label="更换图标" onClick={()=>setDraft({icon:ICONS[(ICONS.indexOf(d.icon)+1)%ICONS.length]})}>{d.icon}</RareButton>
     <RareInput className="pj-dr-title" value={d.name} placeholder="项目名称" aria-label="项目名称" maxLength={120} onChange={e=>setDraft({name:e.target.value})}/>
     <RareButton type="button" tone="ghost" className={"pj-dr-fav"+(d.favorite?" on":"")} title="收藏" aria-label="收藏" aria-pressed={d.favorite} onClick={()=>void toggleFav()}>{d.favorite?"★":"☆"}</RareButton>
     <RareButton type="button" tone="ghost" onClick={()=>closeDrawer()}>✕</RareButton>
    </div>
    <div className="pj-dr-scroll">
     <div className="pj-dr-props">
      <PersonRow label="状态" glyph="◔" show><RareSelect value={d.status} onChange={e=>setDraft({status:e.target.value as ProjectStatus})}>{ST_KEYS.map(s=><option key={s} value={s}>{STATUS[s].label}</option>)}</RareSelect></PersonRow>
      <PersonRow label="负责人" glyph="☺" show={colVis.owner}><RareSelect value={d.ownerId} onChange={e=>setDraft({ownerId:e.target.value})}><option value="">空白</option>{users.map(u=><option key={u.id} value={u.id}>{u.displayName}</option>)}</RareSelect></PersonRow>
      <PersonRow label="优先级" glyph="◎" show={colVis.priority}><RareSelect value={d.priority} onChange={e=>setDraft({priority:e.target.value as ProjectPriority})}>{(["high","mid","low"]as ProjectPriority[]).map(p=><option key={p} value={p}>{PRI_LABEL[p]}</option>)}</RareSelect></PersonRow>
      <PersonRow label="团队" glyph="▤" show={colVis.team}><RareSelect value={d.team} onChange={e=>setDraft({team:e.target.value as ProjectTeam})}>{TEAMS.map(t=><option key={t} value={t}>{t||"空白"}</option>)}</RareSelect></PersonRow>
      <PersonRow label="开始日期" glyph="▭" show={colVis.start}><RareInput type="date" className="pj-date" aria-label="开始日期" value={d.startDate??""} onChange={e=>setDraft({startDate:e.target.value||null})}/></PersonRow>
      <PersonRow label="结束日期" glyph="▭" show={colVis.end}><RareInput type="date" className="pj-date" aria-label="结束日期" value={d.endDate??""} onChange={e=>setDraft({endDate:e.target.value||null})}/></PersonRow>
      <div className="pj-prop"><span className="pj-p-ic">◍</span><span className="pj-p-label">进度</span>
       <RareInput type="range" min={0} max={100} step={5} className="pj-slider" aria-label="进度" value={d.progress} onChange={e=>setDraft({progress:+e.target.value})}/>
       <b className="pj-p-val pj-pct">{d.progress}%</b></div>
     </div>

     <section className="pj-sec">
      <div className="pj-sec-head"><h3>评论 {detail?.comments.length?`（${detail.comments.length} 条）`:""}</h3></div>
      {detail?.comments.map(c=><div className="pj-cmt" key={c.id}><span className="pj-avatar-sm">{c.who?.[0]}</span><div className="pj-cmt-body"><b>{c.who}</b> <small>{c.at}</small><p>{c.text}</p></div></div>)}
      {drawer.mode==="edit"&&<div className="pj-cmt-add">
       <RareInput placeholder="评论…（回车发送）" value={cmtText} disabled={!detail}
        onChange={e=>setCmtText(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing){const t=cmtText.trim();if(t&&drawer.id){void commentNow(drawer.id,t);}}}}/>
      </div>}
      {drawer.mode==="new"&&<p className="pj-sec-hint">保存项目后即可添加评论</p>}
     </section>

     <section className="pj-sec">
      <div className="pj-sec-head"><h3>关于此项目</h3></div>
      <RareTextarea className="pj-desc" value={d.description} placeholder="写点项目背景…" rows={4} onChange={e=>setDraft({description:e.target.value})}/>
     </section>

     <section className="pj-sec">
      <div className="pj-sec-head"><h3>待办 {detail?.todos.length?`（${detail.todos.filter(t=>t.done).length}/${detail.todos.length}）`:""}</h3></div>
      {detail?.todos.map(t=>{const id=drawer.id;return<div className={"pj-todo"+(t.done?" done":"")} key={t.id}>
       <RareInput type="checkbox" checked={t.done} aria-label={"完成 " + t.text} onChange={e=>{if(id)void todoToggle(id,t.id,e.target.checked);}}/>
       <span>{t.text}</span><RareButton type="button" tone="ghost" className="pj-todo-del" title="删除待办" aria-label={"删除待办 " + t.text} onClick={()=>{if(id)void todoRemove(id,t.id);}}>✕</RareButton></div>;})}
      {drawer.mode==="edit"&&<div className="pj-todo-add">
       <RareInput placeholder="添加待办，回车保存…" value={todoText} disabled={todoBusy||!detail}
        onChange={e=>setTodoText(e.target.value)}
        onKeyDown={e=>{if(e.key==="Enter"&&!e.nativeEvent.isComposing){const t=todoText.trim();if(t&&drawer.id)void todoAdd(drawer.id,t);}}}/>
      </div>}
      {drawer.mode==="new"&&<p className="pj-sec-hint">保存项目后即可添加待办</p>}
     </section>

     <section className="pj-sec">
      <div className="pj-sec-head"><h3>关联文档 {detail?.docs.length?`（${detail.docs.length}）`:""}</h3></div>
      {/* chip 主体点开文件预览，✕ 单独负责解除关联，两个动作不会互相误触。
          预览在新标签页打开：抽屉里的草稿和筛选条件不会被整页跳转冲掉；
          from=projects 供预览页把返回键指回本页（该页暂未识别参数时也无副作用）。 */}
      <div className="pj-docs">{detail?.docs.map(dc=>{const id=drawer.id;return<span className="pj-doc-chip" key={dc.docId}>
        <Link className="pj-doc-open" to={"/preview/"+encodeURIComponent(dc.docId)+"?from=projects"}
         target="_blank" rel="noopener noreferrer"
         title={"在新标签页预览 "+dc.name} aria-label={"预览 "+dc.name+"（新标签页）"}
         onClick={e=>e.stopPropagation()}>
         <FileTypeIcon name={dc.name} size={14}/><span className="pj-doc-name">{dc.name}</span>
        </Link>
        <RareButton type="button" tone="ghost" title="解除关联" aria-label={"解除关联 "+dc.name} onClick={()=>{if(id)void docRemove(id,dc.docId);}}>✕</RareButton></span>;})}
       {detail?.docs?.length===0&&<span className="pj-docs-empty">还没有关联文档</span>}
       {drawer.mode==="edit"&&<RareButton type="button" tone="ghost" className="pj-doc-add" onClick={()=>setDocPickerFor(drawer.id)}>＋ 关联文档</RareButton>}
      </div>
      {drawer.mode==="new"&&<p className="pj-sec-hint">保存项目后即可关联文档</p>}
     </section>
    </div>

    <div className="pj-dr-foot">
     <RareButton type="button" tone="ghost" onClick={()=>closeDrawer()}>取消</RareButton>
     <span className="pj-spacer"/>
     {dirty&&<span className="pj-dirty" title="有未保存的改动">未保存</span>}
     {drawer.mode==="edit"&&<RareButton type="button" tone="ghost" onClick={()=>void archiveMe()}>归档</RareButton>}
     {drawer.mode==="edit"&&<RareButton type="button" tone="ghost" loading={processing} onClick={()=>void removeMe()}>删除</RareButton>}
     <RareButton type="button" tone="primary" loading={processing} disabled={!d.name.trim()||(drawer.mode==="edit"&&!dirty)} onClick={()=>void saveDrawer()}>保存</RareButton>
    </div>
   </aside>
  </div>;
 }
}

/* ------------ 甘特（含拖条改起止日期）------------ */
function ProjectGantt({projects,scale,onScale,onBarClick,onPatch}:{
 projects:Project[];scale:0|1;onScale:(s:0|1)=>void;onBarClick:(p:Project)=>void;
 onPatch:(id:number,patch:Partial<ProjectWriteInput>)=>void;
}){
 const scrollRef=useRef<HTMLDivElement|null>(null);
 const gdrag=useRef<{id:number;side:"move"|"l"|"r";startX:number;startLeft:number;startW:number;moved:boolean}|null>(null);

 const timeline=useMemo(()=>{
  const cells:{label:string;w:number}[]=[];
  if(scale===0){for(let m=0;m<12;m++){const days=new Date(2025,m+1,0).getDate();cells.push({label:MONTH_L[m]??"",w:days/SPAN*100});}}
  else{for(let d=0;d<SPAN;d+=14){const dt=new Date(ORIGIN+d*DAY);cells.push({label:(dt.getMonth()+1)+"/"+dt.getDate(),w:14/SPAN*100});}}
  return cells;
 },[scale]);

 useEffect(()=>{
  function move(ev:MouseEvent){
   const g=gdrag.current;if(!g||!g.moved&&Math.abs(ev.clientX-g.startX)<5)return;
   const track=scrollRef.current?.querySelector(".pj-g-track") as HTMLElement|null;if(!track)return;
   const bar=track.querySelector('.pj-gbar[data-id="'+g.id+'"]')as HTMLElement|null;if(!bar)return;
   g.moved=true;
   const rect=track.getBoundingClientRect();const dxPct=((ev.clientX-g.startX)/rect.width)*100;
   if(g.side==="move"){let l=Math.max(-2,Math.min(100-g.startW,g.startLeft+dxPct));bar.style.left=l+"%";}
   else if(g.side==="l"){let l=Math.max(0,Math.min(g.startLeft+g.startW-1,g.startLeft+dxPct));bar.style.left=l+"%";bar.style.width=Math.max(g.startW-(l-g.startLeft),1.4)+"%";}
   else{bar.style.width=Math.max(g.startW+dxPct,1.4)+"%";}
   document.body.classList.add("pj-gdragging");
  }
  function up(){
   const g=gdrag.current;gdrag.current=null;document.body.classList.remove("pj-gdragging");
   const track=scrollRef.current?.querySelector(".pj-g-track") as HTMLElement|null;if(!track)return;
   const bar=track.querySelector('.pj-gbar[data-id="'+g?.id+'"]')as HTMLElement|null;if(!g||!g.moved||!bar)return;
   // 用 round 把像素对齐到「天」，不再用 +0.5 的偏置（原写法在右侧拖拽时会整体偏移一天）
   const leftPct=parseFloat(bar.style.left)||0;const wPct=parseFloat(bar.style.width)||1.4;
   const startDay=Math.round((leftPct/100)*SPAN);
   const spanD=Math.max(1,Math.round((wPct/100)*SPAN));
   const S=Math.max(0,Math.min(SPAN-1,startDay));
   const E2=Math.max(S,Math.min(SPAN-1,S+spanD-1));
   const ns=isoDate(new Date(ORIGIN+S*DAY));const ne=isoDate(new Date(ORIGIN+E2*DAY));
   const p0=projects.find(x=>x.id===g.id);if(!p0)return;
   let patch:Partial<ProjectWriteInput>;
   if(g.side==="r"){patch={endDate:ne};if(p0.startDate&&ne<p0.startDate)patch.startDate=ne;}
   else if(g.side==="l"){patch={startDate:ns};if(p0.endDate&&ns>p0.endDate)patch.endDate=ns;}
   else{
    // 整体平移：按天差平移，起止一起走，保持原工期不变
    const origStart=p0.startDate?dayIdx(Date.parse(p0.startDate)):startDay;
    const delta=S-origStart;
    patch={startDate:ns};
    if(p0.endDate){const oe=Math.max(0,Math.min(SPAN-1,dayIdx(Date.parse(p0.endDate))+delta));patch.endDate=isoDate(new Date(ORIGIN+oe*DAY));}
   }
   void onPatch(p0.id,patch);
  }
  window.addEventListener("mousemove",move);window.addEventListener("mouseup",up);
  return()=>{window.removeEventListener("mousemove",move);window.removeEventListener("mouseup",up);};
 },[projects,onPatch]);

 function down(id:number,side:"move"|"l"|"r"){return(ev:React.MouseEvent|React.PointerEvent)=>{ev.preventDefault();ev.stopPropagation();
  const track=scrollRef.current?.querySelector(".pj-g-track")as HTMLElement|null;const bar=track?.querySelector('.pj-gbar[data-id="'+id+'"]')as HTMLElement|null;if(!track||!bar)return;
  gdrag.current={id,side,startX:ev.clientX,startLeft:parseFloat(bar.style.left)||0,startW:parseFloat(bar.style.width)||1.4,moved:false};
 };}

 return<div className="pj-gantt">
  <div className="pj-g-tools">
   <RareButton type="button" tone="ghost" className={scale===0?"active":""} onClick={()=>onScale(0)}>月</RareButton>
   <RareButton type="button" tone="ghost" className={scale===1?"active":""} onClick={()=>onScale(1)}>周</RareButton>
  </div>
  <div className="pj-g-scroll" ref={scrollRef}>
   <div className="pj-g-headcells">
    <div className="pj-g-namecol">Aa 项目</div>
    <div className="pj-g-axis"><div className="pj-g-axis-track">{timeline.map((c,i)=><div className="pj-g-axis-cell" key={i} style={{width:c.w+"%"}}>{c.label}</div>)}</div></div>
   </div>
   {ST_KEYS.map(st=>{
    const items=projects.filter(p=>p.status===st&&!p.archived);if(!items.length)return null;
    return(
     <div key={st}>
      <div className="pj-g-group"><span className={"pj-dot pj-dot-"+(STATUS[st].tone==="success"?"d":STATUS[st].tone==="info"?"p":"n")}/><b>{STATUS[st].label}</b><span className="pj-g-gcount">{items.length}</span></div>
      {items.map(p=>{
       const s=p.startDate||p.endDate||"2025-01-01",e=p.endDate||p.startDate||"2025-01-01";
       const off=dayIdx(Date.parse(s));const len=Math.max(dayIdx(Date.parse(e))-off+1,1);
       const wPct=Math.max(len/SPAN*100,1.4);
       return(
        <div className="pj-g-row" key={p.id}>
         <div className="pj-g-name" onClick={()=>onBarClick(p)}>{p.name}</div>
         <div className="pj-g-track">
          {timeline.map((c,i)=><div className="pj-g-track-cell" key={i} style={{width:c.w+"%"}}/>)}
          <div className={"pj-gbar pj-gbar-"+p.status+(wPct<9?" hide":"")} data-id={p.id}
           style={{left:off/SPAN*100+"%",width:wPct+"%"}}
           onMouseDown={down(p.id,"move")} onDoubleClick={ev=>{ev.stopPropagation();onBarClick(p);}}>
           <span className="pj-g-resize pj-g-resize-l" onMouseDown={down(p.id,"l")} title="拖动改开始日期"/>
           <span className="pj-g-core" onClick={ev=>{ev.stopPropagation();onBarClick(p);}}>{p.name}</span>
           <span className="pj-g-resize pj-g-resize-r" onMouseDown={down(p.id,"r")} title="拖动改结束日期"/>
          </div>
         </div>
        </div>);})}
     </div>);})}
  </div>
 </div>;
}