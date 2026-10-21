import {request} from "../../shared/http";
import type {Customer,CustomerWrite,CustomerRegistration,CustomerEvent} from "./model";
import type {FileItem} from "../../entities/file/model";
const id=(value:string)=>encodeURIComponent(value);
export const customerApi={
 searchFiles:(q:string,signal?:AbortSignal)=>request<{items:FileItem[]}>("/search?"+new URLSearchParams({q,sort:"updated_desc",limit:"15"}),{signal}),
 list:(q:string,category:string,status:string,cursor="",limit=50,signal?:AbortSignal)=>request<{items:Customer[];nextCursor:string}>("/customers?"+new URLSearchParams({q,category,status,cursor,limit:String(limit)}),{cache:"no-store",signal}),
 get:(customerId:string)=>request<Customer>("/customers/"+id(customerId),{cache:"no-store"}),
 create:(draft:CustomerWrite)=>request<Customer>("/customers",{method:"POST",body:JSON.stringify(draft)}),
 update:(customerId:string,draft:CustomerWrite)=>request<Customer>("/customers/"+id(customerId),{method:"PATCH",body:JSON.stringify(draft)}),
 events:(customerId:string)=>request<{items:CustomerEvent[]}>("/customers/"+id(customerId)+"/events",{cache:"no-store"}),
 submit:(customerId:string,reviewerId:string)=>request<CustomerRegistration>("/customers/"+id(customerId)+"/registrations",{method:"POST",body:JSON.stringify({reviewerId})}),
 registrations:(scope:"inbox"|"mine")=>request<{items:CustomerRegistration[]}>("/workbench/customer-registrations?scope="+scope,{cache:"no-store"}),
 registration:(caseId:string)=>request<CustomerRegistration>("/workbench/customer-registrations/"+id(caseId),{cache:"no-store"}),
 decide:(caseId:string,revision:number,decision:"approved"|"rejected",reason:string)=>request<CustomerRegistration>(
  "/workbench/customer-registrations/"+id(caseId)+"/decide",{
   method:"POST",headers:{"If-Match":'"rev-'+revision+'"'},body:JSON.stringify({decision,reason})
  }),
};
