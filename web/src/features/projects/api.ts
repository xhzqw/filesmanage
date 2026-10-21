// project-api.ts
// 「项目」模块前端 API 契约。风格与 features/**/api.ts 对齐：
//   request<T>(path, {method, body}) → 自动加 /api 前缀、JSON、Reply 解包、ApiError。
// 后端实现请按 BACKEND-API.md 保持一致。

import {request} from "../../shared/http";

// ---------------------------------------------------------------------------
// 类型
// ---------------------------------------------------------------------------
export type ProjectStatus="notstarted"|"progress"|"done";
export type ProjectPriority="high"|"mid"|"low";
export type ProjectTeam=
 "销售部"|"产品设计"|"人力资源"|"供应链"|"工程部"|"文件管理"|"";

export interface ProjectComment{
 id:string;                  // comment id
 who:string;                 // 评论人 displayName（前端展示用；写回无需）
 whoId:string;               // 评论人 user id
 text:string;
 at:string;                  // 展示用时间文案
 createdAt:number;           // 毫秒时间戳，排序用
}
export interface ProjectTodo{
 id:string;
 text:string;
 done:boolean;
}
export interface ProjectDoc{
 docId:string;               // 受控文件 id（关联受控文件）
 name:string;                // 展示名
 kind:"gdrive"|"pdf"|"figma"|"file";
}
export interface Project{
 id:number;
 name:string;
 icon:string;                // '◇' | '◈' | '▦' | '✦' | '◎'
 description:string;
 status:ProjectStatus;
 ownerId:string;
 ownerName:string;           // 负责人 displayName（后端 join 返回）
 team:ProjectTeam;
 priority:ProjectPriority;
 startDate:string|null;      // YYYY-MM-DD
 endDate:string|null;        // YYYY-MM-DD
 progress:number;            // 0-100
 favorite:boolean;
 archived:boolean;
 comments:ProjectComment[];
 todos:ProjectTodo[];
 docs:ProjectDoc[];
 createdBy:string;
 createdAt:number;
 updatedAt:number;
}

export interface ProjectPage{
 items:Project[];
 nextCursor:string|null;
 asOf:string;
}

// 属性可见性键：与 UI 的属性行一一对应（owner=负责人、start=开始日期、end=结束日期）
export type ProjectColKey="status"|"owner"|"priority"|"team"|"start"|"end"|"progress";
export type ProjectColVis=Record<ProjectColKey,boolean>;

export interface ProjectViewConfig{
 // 属性可见性：false → 表格里隐藏该列 / 抽屉里隐藏该属性行
 colVis:ProjectColVis;
 sort:{field:string;dir:1|-1};
 filters:{status:Record<ProjectStatus,boolean>};
 scope:"all"|"mine";
 view:"board"|"table"|"gantt";
 columnConfig?:{widths?:Record<string,number>;order?:string[];ganttScale?:0|1;ganttStart?:string;ganttEnd?:string};
}

// ---------------------------------------------------------------------------
// 新增/编辑输入（创建一次全量 POST；其后 PATCH 单字段或整段）
// ---------------------------------------------------------------------------
export type ProjectWriteInput=
 Pick<Project,"name"|"icon"|"description"|"status"|"ownerId"|"team"|"priority"|"startDate"|"endDate"|"progress">;

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------
export const projectApi={

 // 项目列表（不区分视图状态；view state 单独读写）
 list:(signal?:AbortSignal)=>request<ProjectPage>(
  "/projects",{signal}),

 // 单个项目全量
 get:(id:number,signal?:AbortSignal)=>request<{project:Project}>(
  "/projects/"+id,{signal}),

 // 新建
 create:(input:ProjectWriteInput)=>request<{project:Project}>(
  "/projects",{method:"POST",body:JSON.stringify(input)}),

 // 修改（PATCH 部分字段，后端浅合并）
 update:(id:number,patch:Partial<ProjectWriteInput>&{favorite?:boolean})=>
  request<{project:Project}>("/projects/"+id,
   {method:"PATCH",body:JSON.stringify(patch)}),

 // 覆盖 start/end（甘特拖条一次提交）
 setDates:(id:number,startDate:string,endDate:string)=>
  request<{project:Project}>("/projects/"+id,
   {method:"PATCH",body:JSON.stringify({startDate,endDate})}),

 // 删除 / 归档
 remove:(id:number)=>request<{ok:true}>(
  "/projects/"+id,{method:"DELETE"}),
 archive:(id:number)=>
  request<{ok:true}>("/projects/"+id,
   {method:"PATCH",body:JSON.stringify({archived:true})}),

 // 评论
 addComment:(id:number,text:string)=>
  request<{comment:ProjectComment}>("/projects/"+id+"/comments",
   {method:"POST",body:JSON.stringify({text})}),

 // 待办
 setTodo:(id:number,todoId:string,done:boolean)=>
  request<{ok:true}>("/projects/"+id+"/todos/"+todoId,
   {method:"PATCH",body:JSON.stringify({done})}),
 addTodo:(id:number,text:string)=>
  request<{ok:true}>("/projects/"+id+"/todos",
   {method:"POST",body:JSON.stringify({text})}),
 removeTodo:(id:number,todoId:string)=>
  request<{ok:true}>("/projects/"+id+"/todos/"+todoId,
   {method:"DELETE"}),

 // 关联文档
 addDoc:(id:number,doc:Pick<ProjectDoc,"docId"|"name"|"kind">)=>
  request<{ok:true}>("/projects/"+id+"/docs",
   {method:"POST",body:JSON.stringify(doc)}),
 // 批量关联：选择器一次挑多份时只发一个请求，避免逐个 POST 产生半成功状态
 addDocs:(id:number,docs:Pick<ProjectDoc,"docId"|"name"|"kind">[])=>
  request<{ok:true;added:number}>("/projects/"+id+"/docs/batch",
   {method:"POST",body:JSON.stringify({docs})}),
 removeDoc:(id:number,docId:string)=>
  request<{ok:true}>("/projects/"+id+"/docs/"+encodeURIComponent(docId),
   {method:"DELETE"}),

 // 收藏
 toggleFavorite:(id:number,favorite:boolean)=>
  request<{project:Project}>("/projects/"+id,
   {method:"PATCH",body:JSON.stringify({favorite})}),

 // 视图状态（列显隐/排序/筛选/scope/当前视图/甘特配置）
 getView:(cursor?:"")=>request<{config:ProjectViewConfig}>(
  "/projects/view-state",{method:"GET"}),
 putView:(config:ProjectViewConfig)=>request<{ok:true}>(
  "/projects/view-state",{method:"PUT",body:JSON.stringify(config)}),
};