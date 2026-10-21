export type CustomerCategory="wholesale"|"retail"|"mixed"|"medical"|"other";
export const categories:Record<CustomerCategory,string>={
 wholesale:"经销批发",retail:"零售",mixed:"批零兼营",medical:"医疗机构",other:"其他需求单位"
};
export type CustomerCertificate={
 id:string;kind:string;number:string;issuedOn:string;expiresOn:string;fileId:string;note:string;
};
export type CustomerProfile={
 contact:string;phone:string;address:string;legalRepresentative:string;
 businessScope:string;businessMethod:string;bankName:string;bankAccount:string;
 taxNumber:string;email:string;notes:string;certificates:CustomerCertificate[];
};
export type Customer={
 id:string;code:string;name:string;category:CustomerCategory;creditCode:string;
 status:"active"|"disabled";profile:CustomerProfile;revision:number;
 createdBy:string;updatedBy:string;createdAt:string;updatedAt:string;
};
export type CustomerWrite=Pick<Customer,"name"|"category"|"creditCode"|"status"|"profile">&{expectedRevision:number};
export type CustomerEvent={id:string;revision:number;action:string;actorId:string;before?:Customer;after?:Customer|CustomerRegistration;reason:string;createdAt:string};
export type CustomerRegistration={
 id:string;customerId:string;customerName:string;customerCode:string;snapshotRevision:number;
 snapshot:Customer;requesterId:string;reviewerId:string;state:"pending"|"approved"|"rejected";
 revision:number;reason:string;decidedBy:string;createdAt:string;decidedAt:string;
};
export const emptyProfile=():CustomerProfile=>({
 contact:"",phone:"",address:"",legalRepresentative:"",businessScope:"",businessMethod:"",
 bankName:"",bankAccount:"",taxNumber:"",email:"",notes:"",certificates:[]
});
export const newCustomer=():CustomerWrite=>({name:"",category:"wholesale",creditCode:"",status:"active",profile:emptyProfile(),expectedRevision:0});
export const fromCustomer=(c:Customer):CustomerWrite=>({
 name:c.name,category:c.category,creditCode:c.creditCode,status:c.status,
 profile:{...c.profile,certificates:(c.profile.certificates??[]).map(x=>({...x}))},expectedRevision:c.revision
});
