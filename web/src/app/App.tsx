import{useEffect}from "react";
import{Navigate,Route,Routes}from "react-router-dom";
import{authApi}from "../features/auth/api";
import{useSession}from "./session";
import{Login}from "../pages/Login";
import{Documents}from "../pages/Documents";
import{FirstSignIn}from "../pages/FirstSignIn";
import{Preview}from "../pages/Preview";
import{Trash}from "../pages/Trash";
import{Org}from "../pages/Org";
import{Approvals}from "../pages/Approvals";
export function App(){
 const user=useSession(s=>s.user),loading=useSession(s=>s.loading),setUser=useSession(s=>s.setUser),setLoading=useSession(s=>s.setLoading);
 useEffect(()=>{let valid=true;authApi.me().then(u=>{if(valid)setUser(u)}).catch(()=>{if(valid)setUser(null)}).finally(()=>{if(valid)setLoading(false)});return()=>{valid=false}},[setLoading,setUser]);
 async function logout(){try{await authApi.logout()}finally{setUser(null)}}
 if(loading)return <main className="login-bg">正在检查会话…</main>;
 if(user?.mustChangePassword)return <Routes><Route path="/first-sign-in" element={<FirstSignIn onSuccess={setUser} onExit={logout}/>}/><Route path="*" element={<Navigate to="/first-sign-in" replace/>}/></Routes>;
 return <Routes><Route path="/login" element={user?<Navigate to="/doc" replace/>:<Login onSuccess={setUser}/>}/>
 <Route path="/doc" element={user?<Documents user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/preview/:id" element={user?<Preview/>:<Navigate to="/login" replace/>}/>
 <Route path="/trash" element={user?<Trash user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/org" element={user?<Org user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/approvals" element={user?<Approvals user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="*" element={<Navigate to={user?"/doc":"/login"} replace/>}/></Routes>;
}
