import {request} from "../../shared/http";
import type {User} from "../../entities/user/model";
export const authApi={
 me:()=>request<User>("/me"),
 login:(login:string,password:string)=>request<User>("/login",{method:"POST",body:JSON.stringify({login,password})}),
 logout:()=>request<unknown>("/logout",{method:"POST"})
};
