import {request} from "../../shared/http";
import {newIdempotencyKey} from "../../shared/ids";
export type DHFNode={sourceLine:number;stageNo:number;depth:number;title:string;parentPath:string[];isGroup:boolean};
export type DHFTemplate={name:string;sha256:string;nodes:DHFNode[]};
export type DHFProject={id:string;title:string;ownerId:string;reviewerId:string;templateSha256:string;revision:number;acceptedStages:number;createdAt:string};
export type DHFStage={stageNo:number;name:string;state:"locked"|"open"|"accepted";revision:number;acceptedBy?:string;acceptedAt?:string;baselineSha256?:string};
export type DHFItem={sourceLine:number;stageNo:number;parentPath:string[];title:string;state:"unclassified"|"missing"|"submitted"|"accepted"|"returned"|"not_applicable_pending"|"not_applicable";applicabilityReason:string;fileId?:string;fileVersionId?:string;fileSha256?:string;submittedBy?:string;submittedAt?:string;reviewedBy?:string;reviewedAt?:string;reviewReason:string;revision:number};
export type DHFEvent={id:number;stageNo:number;sourceLine:number;action:string;actorId:string;eventSha256:string;previousSha256:string;occurredAt:string};
export type DHFDetail={project:DHFProject;stages:DHFStage[];items:DHFItem[];events:DHFEvent[]};
export type DHFFileVersion={id:string;seq:number;sha256:string};
export type DHFProofEvent={id:number;stageNo:number;sourceLine:number;action:string;actorId:string;payloadText:string;previousSha256:string;eventSha256:string;occurredAt:string};
export type DHFProofPage={projectId:string;templateSha256:string;chainVersion:string;anchorSha256:string;segmentVerified:boolean;startsAtGenesis:boolean;hasMore:boolean;nextAfter:number;events:DHFProofEvent[]};
const base="/workbench/dhf";
export const dhfApi={
 template:()=>request<DHFTemplate>(base+"/template"),
 projects:()=>request<DHFProject[]>(base+"/projects"),
 detail:(id:string)=>request<DHFDetail>(base+"/projects/"+encodeURIComponent(id)),
 audit:(id:string,after=0)=>request<DHFProofPage>(base+"/projects/"+encodeURIComponent(id)+"/audit?after="+after+"&limit=100"),
 versions:(id:string)=>request<DHFFileVersion[]>(base+"/files/"+encodeURIComponent(id)+"/versions"),
 create:(title:string,reviewerId:string)=>request<DHFDetail>(base+"/projects",{method:"POST",headers:{"Idempotency-Key":newIdempotencyKey()},body:JSON.stringify({title,reviewerId})}),
 item:(id:string,line:number,revision:number,body:{action:string;reason?:string;fileId?:string;fileVersionId?:string})=>request<DHFDetail>(base+"/projects/"+encodeURIComponent(id)+"/items/"+line+"/action",{method:"POST",headers:{"Idempotency-Key":newIdempotencyKey(),"If-Match":'"rev-'+revision+'"'},body:JSON.stringify(body)}),
 stage:(id:string,stage:number,reason:string)=>request<DHFDetail>(base+"/projects/"+encodeURIComponent(id)+"/stages/"+stage+"/accept",{method:"POST",headers:{"Idempotency-Key":newIdempotencyKey()},body:JSON.stringify({reason})}),
};
