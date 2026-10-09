import{useEffect,useRef,useState}from "react";
import{Navigate,Route,Routes}from "react-router-dom";
import{authApi}from "../features/auth/api";
import{subscribeSessionIssues}from "../shared/http";
import "./authFeedback.css";
import{CommandSpotlight}from "../features/collaboration/CommandSpotlight";
import{useSession}from "./session";
import{Login}from "../pages/Login";
import{Documents}from "../pages/Documents";
import{FirstSignIn}from "../pages/FirstSignIn";
import{Preview}from "../pages/Preview";
import{Trash}from "../pages/Trash";
import{Org}from "../pages/Org";
import{Approvals}from "../pages/Approvals";
import{OfficeEditor}from "../pages/OfficeEditor";
import{ModelViewer}from "../pages/ModelViewer";
import{SearchPage,WorkspacePage}from "./AppShell";
export function App(){
 const user=useSession(s=>s.user),loading=useSession(s=>s.loading),setUser=useSession(s=>s.setUser),setLoading=useSession(s=>s.setLoading);
 const [logoutError,setLogoutError]=useState("");
 const logoutPending=useRef(false);
 useEffect(()=>{let valid=true;authApi.me().then(u=>{if(valid)setUser(u)}).catch(()=>{if(valid)setUser(null)}).finally(()=>{if(valid)setLoading(false)});return()=>{valid=false}},[setLoading,setUser]);
 useEffect(()=>subscribeSessionIssues(issue=>{
  if(issue==="expired"){setUser(null);setLogoutError("");}
  else useSession.setState(state=>({user:state.user?{...state.user,mustChangePassword:true}:null}));
 }),[setUser]);
 async function logout(){
  if(logoutPending.current)return;
  logoutPending.current=true;
  setLogoutError("");
  try{await authApi.logout();setUser(null);}
  catch{setLogoutError("退出未完成，服务器未确认会话已注销。请检查网络后重试。");}
  finally{logoutPending.current=false;}
 }
 const feedback=logoutError?<div className="auth-feedback" role="alert"><span>{logoutError}</span><button type="button" onClick={()=>void logout()}>重试退出</button></div>:null;
 if(loading)return <main className="login-bg">正在检查会话…</main>;
 if(user?.mustChangePassword)return <>{feedback}<Routes><Route path="/first-sign-in" element={<FirstSignIn onSuccess={setUser} onExit={logout}/>}/><Route path="*" element={<Navigate to="/first-sign-in" replace/>}/></Routes></>;
 return <>{feedback}<Routes><Route path="/login" element={user?<Navigate to="/doc" replace/>:<Login onSuccess={setUser}/>}/>
 <Route path="/doc" element={user?<Documents user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/preview/:id" element={user?<Preview user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/trash" element={user?<Trash user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/org" element={user?<Org user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/approvals" element={user?<Approvals user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/office/:id" element={user?<OfficeEditor user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/model/:id" element={user?<ModelViewer user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/workspace" element={user?<WorkspacePage user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/search" element={user?<SearchPage user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/stats" element={user?<WorkspacePage user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="*" element={<Navigate to={user?"/doc":"/login"} replace/>}/></Routes>
  {user?<CommandSpotlight/>:null}</>;
}
