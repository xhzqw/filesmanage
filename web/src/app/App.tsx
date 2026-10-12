import {RareButton} from "../shared/ui/rare";
import{lazy,Suspense,useEffect,useRef,useState}from "react";
import{Navigate,Route,Routes}from "react-router-dom";
import{authApi}from "../features/auth/api";
import{subscribeSessionIssues}from "../shared/http";
import{connectSessionEvents}from "./liveConnection";
import "./authFeedback.css";
import{CommandSpotlight}from "../features/collaboration/CommandSpotlight";
import{NotificationCenter}from "../features/workflow/NotificationCenter";
import{ShellAccessories}from "../shared/ui/ShellAccessories";
import{ToastViewport}from "../shared/ui/ToastViewport";
import{BrandLoader}from "../shared/ui/BrandLoader";
import{MotionFeedback}from "../shared/ui/MotionFeedback";
import{toast}from "../shared/ui/feedback";
import{useUploadStore}from "../features/documents/uploadStore";
import{useSession}from "./session";
import{Login}from "../pages/Login";
import{Documents}from "../pages/Documents";
import{Preview}from "../pages/Preview";
import{Trash}from "../pages/Trash";
import{Org}from "../pages/Org";
import{Approvals}from "../pages/Approvals";
import{Lifecycle}from "../pages/Lifecycle";
import{OfficeEditor}from "../pages/OfficeEditor";
import{SessionDevices}from "../pages/SessionDevices";
import{SearchPage,WorkspacePage}from "./AppShell";
const ModelViewer=lazy(()=>import("../pages/ModelViewer").then(m=>({default:m.ModelViewer})));
export function App(){
 const user=useSession(s=>s.user),loading=useSession(s=>s.loading),setUser=useSession(s=>s.setUser),setLoading=useSession(s=>s.setLoading);
 const [logoutError,setLogoutError]=useState("");
 const logoutPending=useRef(false);
 useEffect(()=>{useUploadStore.getState().bindUser(user?.id??"");toast.bindOwner(user?.id??"");},[user?.id]);
 useEffect(()=>{let valid=true;authApi.me().then(u=>{if(valid)setUser(u)}).catch(()=>{if(valid)setUser(null)}).finally(()=>{if(valid)setLoading(false)});return()=>{valid=false}},[setLoading,setUser]);
 useEffect(()=>subscribeSessionIssues(issue=>{
  if(issue==="expired"){setUser(null);setLogoutError("");}
  else void authApi.me().then(setUser).catch(()=>{});
 }),[setUser]);
 useEffect(()=>{
  if(!user)return;
  return connectSessionEvents(setUser,user.id);
 },[user?.id,setUser]);
 async function logout(){
  if(logoutPending.current)return;
  logoutPending.current=true;
  setLogoutError("");
  try{await authApi.logout();setUser(null);}
  catch{setLogoutError("退出未完成，服务器未确认会话已注销。请检查网络后重试。");}
  finally{logoutPending.current=false;}
 }
 const feedback=logoutError?<div className="auth-feedback" role="alert"><span>{logoutError}</span><RareButton type="button" onClick={()=>void logout()}>重试退出</RareButton></div>:null;
 if(loading)return <main className="brand-loading-screen" aria-busy="true"><BrandLoader size="lg" label="正在检查会话"/><span>正在检查会话…</span></main>;
 return <><MotionFeedback/>{feedback}<ToastViewport/><ShellAccessories.Provider value={user?<NotificationCenter key={user.id}/>:null}><Routes><Route path="/login" element={user?<Navigate to="/doc" replace/>:<Login onSuccess={setUser}/>}/>
  <Route path="/doc" element={user?<Documents user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
  <Route path="/account/sessions" element={user?<SessionDevices user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/preview/:id" element={user?<Preview user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/trash" element={user?<Trash user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/org" element={user?<Org user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/lifecycle" element={user?<Lifecycle user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/approvals" element={user?<Approvals user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/office/:id" element={user?<OfficeEditor user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/model/:id" element={user?<Suspense fallback={<main className="brand-loading-screen" aria-busy="true"><BrandLoader size="lg" label="正在加载 CAD 模型预览"/><span>正在加载 CAD 模型预览…</span></main>}><ModelViewer user={user} onLogout={logout}/></Suspense>:<Navigate to="/login" replace/>}/>
 <Route path="/workspace" element={user?<WorkspacePage user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/search" element={user?<SearchPage user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="/stats" element={user?<WorkspacePage user={user} onLogout={logout}/>:<Navigate to="/login" replace/>}/>
 <Route path="*" element={<Navigate to={user?"/doc":"/login"} replace/>}/></Routes></ShellAccessories.Provider>
  {user?<CommandSpotlight/>:null}</>;
}
