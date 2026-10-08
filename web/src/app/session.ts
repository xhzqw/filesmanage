import {create} from "zustand";
import type {User} from "../entities/user/model";
type State={user:User|null;loading:boolean;setUser:(u:User|null)=>void;setLoading:(b:boolean)=>void};
export const useSession=create<State>(set=>({
 user:null,loading:true,setUser:user=>set({user}),setLoading:loading=>set({loading})
}));
