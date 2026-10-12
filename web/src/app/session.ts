import {create} from "zustand";
import type {User} from "../entities/user/model";
type State={user:User|null;loading:boolean;setUser:(u:User|null)=>void;setLoading:(b:boolean)=>void};
// Session heartbeats, another-device logins and reconnects may all re-read
// /api/me. Replacing an unchanged User object needlessly re-renders the
// entire authenticated route tree (and can reset transient UI focus).
function unchangedUser(previous:User|null,next:User|null):boolean{
 if(previous===next)return true;
 if(!previous||!next)return false;
 const keys=Object.keys(previous) as (keyof User)[];
 return keys.length===Object.keys(next).length&&keys.every(key=>previous[key]===next[key]);
}
export const useSession=create<State>(set=>({
 user:null,loading:true,
 setUser:user=>set(state=>unchangedUser(state.user,user)?state:{user}),
 setLoading:loading=>set(state=>state.loading===loading?state:{loading})
}));
