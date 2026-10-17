import {useEffect,useState} from "react";
import {Link} from "react-router-dom";
import type {User} from "../entities/user/model";
import type {FileItem} from "../entities/file/model";
import {AppShell} from "../shared/ui/AppShell";
import {RareButton,RareInput,RareSelect,RareTextarea,RareNotice} from "../shared/ui/rare";
import {organizationApi} from "../features/organization/api";
import {collaborationApi} from "../features/collaboration/api";
import {dhfApi,type DHFDetail,type DHFProject,type DHFItem,type DHFFileVersion} from "../features/dhf/api";
import "./dhfWorkbench.css";

const labels:Record<DHFItem["state"],string>={unclassified:"待判定",missing:"待提交",submitted:"待验收",accepted:"已验收",returned:"退回整改",not_applicable:"不适用"};
const stageLabels={locked:"未开放",open:"进行中",accepted:"已通过"};
const date=(s?:string)=>s?new Date(s).toLocaleString("zh-CN",{hour12:false}):"—";
const errText=(e:unknown)=>e instanceof Error?e.message:"请求失败";
export function DHFWorkbench({user,onLogout}:{user:User;onLogout:()=>void}){
 const[projects,setProjects]=useState<DHFProject[]>([]),[detail,setDetail]=useState<DHFDetail|null>(null);
 const[stage,setStage]=useState(1),[line,setLine]=useState(0),[filter,setFilter]=useState("all"),[query,setQuery]=useState("");
 const[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState("");
 const[creating,setCreating]=useState(false),[title,setTitle]=useState(""),[reviewer,setReviewer]=useState(""),[users,setUsers]=useState<User[]>([]);
 const[reason,setReason]=useState(""),[fileQuery,setFileQuery]=useState(""),[files,setFiles]=useState<FileItem[]>([]);
 const[picked,setPicked]=useState<FileItem|null>(null),[versions,setVersions]=useState<DHFFileVersion[]>([]),[version,setVersion]=useState("");
 const[history,setHistory]=useState(false);
 useEffect(()=>{let live=true;dhfApi.projects().then(v=>{if(live)setProjects(v)}).catch(e=>{if(live)setError(errText(e))}).finally(()=>{if(live)setLoading(false)});return()=>{live=false}},[]);
 useEffect(()=>{if(!creating)return;let live=true;organizationApi.users().then(v=>{if(live)setUsers(v)}).catch(e=>{if(live)setError(errText(e))});return()=>{live=false}},[creating]);
 useEffect(()=>{const q=fileQuery.trim();if(q.length<2){setFiles([]);return}let live=true;const timer=window.setTimeout(()=>{collaborationApi.search({q,sort:"updated_desc",limit:25}).then(v=>{if(live)setFiles(v.items)}).catch(()=>{if(live)setFiles([])})},220);return()=>{live=false;window.clearTimeout(timer)}},[fileQuery]);
 async function open(id:string){setLoading(true);setError("");try{const d=await dhfApi.detail(id);setDetail(d);setStage(d.stages.find(s=>s.state==="open")?.stageNo??9);setLine(0)}catch(e){setError(errText(e))}finally{setLoading(false)}}
 async function create(){setBusy(true);setError("");try{const d=await dhfApi.create(title.trim(),reviewer);setProjects(p=>[d.project,...p]);setDetail(d);setStage(1);setLine(0);setCreating(false);setTitle("");setReviewer("")}catch(e){setError(errText(e))}finally{setBusy(false)}}
 async function act(action:string){if(!detail||!item)return;setBusy(true);setError("");try{const d=await dhfApi.item(detail.project.id,item.sourceLine,item.revision,{action,reason,...(action==="submit"&&picked?{fileId:picked.id,fileVersionId:version}:{})});setDetail(d);setReason("");setFileQuery("");setPicked(null);setVersions([]);setVersion("")}catch(e){setError(errText(e))}finally{setBusy(false)}}
 async function acceptStage(){if(!detail)return;setBusy(true);setError("");try{const d=await dhfApi.stage(detail.project.id,stage,reason);setDetail(d);setProjects(p=>p.map(x=>x.id===d.project.id?d.project:x));setStage(Math.min(stage+1,9));setLine(0);setReason("")}catch(e){setError(errText(e))}finally{setBusy(false)}}
 async function pickFile(f:FileItem){setPicked(f);setVersion("");setVersions([]);try{setVersions(await dhfApi.versions(f.id))}catch(e){setError(errText(e))}}
 const active=detail?.stages.find(s=>s.stageNo===stage),all=detail?.items.filter(i=>i.stageNo===stage)??[];
 const completed=all.filter(i=>i.state==="accepted"||i.state==="not_applicable").length;
 const shown=all.filter(i=>(filter==="all"||i.state===filter)&&[i.title,...i.parentPath].join(" ").toLowerCase().includes(query.trim().toLowerCase()));
 const item=detail?.items.find(i=>i.sourceLine===line);
 const owner=detail?.project.ownerId===user.id&&active?.state==="open";
 const checker=detail?.project.reviewerId===user.id&&active?.state==="open";
 const logs=detail?.events.filter(e=>e.stageNo===stage&&(line===0||e.sourceLine===line||e.sourceLine===0))??[];
 return <AppShell user={user} onLogout={onLogout}><div className="panels"><main className="work dhf-work">
 <div className="dhf-toolbar"><Link to="/workbench">← 任务工作台</Link><strong>DHF · 九阶段文件验收</strong><RareButton type="button" tone="ghost" onClick={()=>void Promise.all([dhfApi.projects(),detail?dhfApi.detail(detail.project.id):Promise.resolve(null)]).then(([p,d])=>{setProjects(p);if(d)setDetail(d)}).catch(e=>setError(errText(e)))}>刷新</RareButton></div>
 {error&&<RareNotice tone="danger">{error}</RareNotice>}
 <div className="dhf-grid"><aside className="dhf-sidebar"><div className="dhf-section-title"><strong>项目</strong>{user.isAdmin&&<RareButton type="button" tone="ghost" onClick={()=>setCreating(v=>!v)}>{creating?"取消":"新建"}</RareButton>}</div>
 {creating&&<div className="dhf-form"><label>项目名称<RareInput value={title} onChange={e=>setTitle(e.target.value)}/></label><label>独立验收人<RareSelect value={reviewer} onChange={e=>setReviewer(e.target.value)}><option value="">请选择</option>{users.filter(u=>!u.disabled&&u.id!==user.id).map(u=><option key={u.id} value={u.id}>{u.displayName}</option>)}</RareSelect></label><RareButton tone="primary" type="button" disabled={busy||!reviewer||title.trim().length<2} onClick={()=>void create()}>创建项目</RareButton></div>}
 {projects.map(p=><RareButton key={p.id} type="button" className={"dhf-project"+(detail?.project.id===p.id?" active":"")} onClick={()=>void open(p.id)}><strong>{p.title}</strong><small>{p.acceptedStages}/9 阶段通过</small></RareButton>)}
 <div className="dhf-section-title"><strong>九阶段</strong></div>{detail?.stages.map(s=>{const subset=detail.items.filter(i=>i.stageNo===s.stageNo);const done=subset.filter(i=>i.state==="accepted"||i.state==="not_applicable").length;return <RareButton key={s.stageNo} type="button" className={"dhf-stage"+(stage===s.stageNo?" active":"")} onClick={()=>{setStage(s.stageNo);setLine(0);setReason("")}}><span className="dhf-number">{String(s.stageNo).padStart(2,"0")}</span><span><strong>{s.name.replace(/^\d+、/,"")}</strong><small>{stageLabels[s.state]} · {done}/{subset.length}</small></span><span className={"dhf-dot "+s.state}/></RareButton>})}</aside>
 <section className="dhf-content">{detail&&active?<><div className="dhf-summary"><div><small>阶段 {stage}/9</small><h2>{active.name.replace(/^\d+、/,"")}</h2><small>固定来源 · {detail.project.templateSha256.slice(0,16)}…</small></div><span className={"dhf-pill "+active.state}>{stageLabels[active.state]}</span></div>
 <div className="dhf-meter"><div style={{width:(all.length?100*completed/all.length:0)+"%"}}/></div>
 <div className="dhf-totals"><span><strong>{all.length}</strong>交付项目</span><span><strong>{completed}</strong>已处置</span><span><strong>{all.length-completed}</strong>待完成</span><span><strong>{all.filter(i=>i.state==="returned").length}</strong>退回</span></div>
 <div className="dhf-filter"><RareInput type="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索文件 / 专业分类"/><RareSelect value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">全部状态</option>{Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}</RareSelect></div>
 <div className="dhf-table-wrap"><table className="dhf-table"><thead><tr><th>文件交付清单</th><th>状态</th><th>原始行</th></tr></thead><tbody>{shown.map(i=><tr key={i.sourceLine} className={line===i.sourceLine?"selected":""} onClick={()=>{setLine(i.sourceLine);setReason("");setFileQuery("");setPicked(null);setVersions([]);setVersion("")}}><td><strong>{i.title}</strong><small>{i.parentPath.slice(1).join(" / ")||"阶段直接交付"}</small></td><td><span className={"dhf-status "+i.state}>{labels[i.state]}</span></td><td>{i.sourceLine}</td></tr>)}</tbody></table>{shown.length===0&&<p className="dhf-empty">没有符合条件的条目</p>}</div>
 <div className="dhf-gate"><span>{active.state==="accepted"?"阶段已经冻结":all.length-completed>0?`还有 ${all.length-completed} 项未满足条件`:"本阶段已达到文件清单放行条件"}</span>{checker&&<RareButton type="button" tone="primary" disabled={busy||all.length===0||all.length!==completed||reason.trim().length<8} onClick={()=>void acceptStage()}>完成阶段验收</RareButton>}</div>
 {checker&&all.length===completed&&<RareTextarea rows={2} value={reason} onChange={e=>setReason(e.target.value)} placeholder="阶段验收结论（至少8字）"/>}
 </>:<p className="dhf-empty">{loading?"正在载入…":"从左侧选择项目进入阶段验收"}</p>}</section>
 <aside className="dhf-detail"><div className="dhf-section-title"><strong>验收详情</strong>{item&&<span className={"dhf-status "+item.state}>{labels[item.state]}</span>}</div>
 {item?<div className="dhf-detail-scroll"><h3>{item.title}</h3><p className="dhf-hierarchy">{item.parentPath.join(" / ")}</p>
 <dl className="dhf-facts"><div><dt>原始行号</dt><dd>{item.sourceLine}</dd></div><div><dt>记录修订</dt><dd>R{item.revision}</dd></div><div><dt>交付人</dt><dd>{item.submittedBy||"—"}</dd></div><div><dt>交付时间</dt><dd>{date(item.submittedAt)}</dd></div><div><dt>验收人</dt><dd>{item.reviewedBy||"—"}</dd></div><div><dt>验收时间</dt><dd>{date(item.reviewedAt)}</dd></div></dl>
 {item.fileId&&<div className="dhf-evidence"><strong>冻结的文件版本</strong><Link to={"/preview/"+encodeURIComponent(item.fileId)}>打开文件当前预览 ↗</Link><code>{item.fileVersionId}</code><small>内容 SHA-256</small><code>{item.fileSha256}</code><small>验收时以固定版本为准，不采用预览中的当前最新版。</small></div>}
 {(item.reviewReason||item.applicabilityReason)&&<div className="dhf-note"><strong>审查记录</strong><p>{item.reviewReason||item.applicabilityReason}</p></div>}
 {owner&&(item.state==="unclassified"||item.state==="missing"||item.state==="returned")&&<div className="dhf-form"><strong>文件处理</strong>{item.state==="unclassified"&&<RareButton type="button" tone="neutral" disabled={busy} onClick={()=>void act("required")}>列为应交付文件</RareButton>}<RareTextarea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="若不适用，必须说明具体依据（至少8字）"/><RareButton type="button" tone="neutral" disabled={busy||reason.trim().length<8} onClick={()=>void act("not_applicable")}>记录不适用</RareButton>
 {(item.state==="missing"||item.state==="returned")&&<><label>查找现有文件<RareInput type="search" value={fileQuery} onChange={e=>{setFileQuery(e.target.value);setPicked(null);setVersions([]);setVersion("")}} placeholder="至少输入2字"/></label>{files.length>0&&<div className="dhf-file-picker">{files.map(f=><RareButton type="button" key={f.id} className={picked?.id===f.id?"active":""} onClick={()=>void pickFile(f)}>{f.name}</RareButton>)}</div>}{picked&&<label>选择指定文件历史版本<RareSelect value={version} onChange={e=>setVersion(e.target.value)}><option value="">请选择明确版本</option>{versions.map(v=><option key={v.id} value={v.id}>第{v.seq}版 · {v.sha256.slice(0,12)}</option>)}</RareSelect></label>}<RareButton type="button" tone="primary" disabled={busy||!picked||!version} onClick={()=>void act("submit")}>提交版本验收</RareButton></>}
 </div>}
 {checker&&item.state==="submitted"&&<div className="dhf-form"><strong>独立验收</strong><RareTextarea rows={3} value={reason} onChange={e=>setReason(e.target.value)} placeholder="审核意见 / 退回依据"/><div className="dhf-actions"><RareButton type="button" tone="neutral" disabled={busy||reason.trim().length<8} onClick={()=>void act("return")}>退回修改</RareButton><RareButton type="button" tone="primary" disabled={busy} onClick={()=>void act("accept")}>验收通过</RareButton></div></div>}
 </div>:<p className="dhf-empty">选中一份交付文件查看详情</p>}
 {detail&&<div className="dhf-history"><RareButton type="button" onClick={()=>setHistory(v=>!v)}>{history?"收起":"展开"}审计时间线 · {logs.length}条</RareButton>{history&&<div className="dhf-history-body">{logs.map(e=><div key={e.id}><strong>{e.action}</strong><small>{date(e.occurredAt)} · {e.actorId}</small><code>{e.eventSha256.slice(0,24)}…</code></div>)}</div>}</div>}</aside>
 </div></main></div></AppShell>;
}
