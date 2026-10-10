import {useEffect,useRef,useState,type FormEvent} from "react";
import {useNavigate,useParams} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {errorCopy} from "../shared/errors";
import {reportSessionResponse} from "../shared/http";
import type {FileItem} from "../entities/file/model";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {parseDxf} from "../features/modelViewer/dxf";
import type {MshGeometry} from "../features/modelViewer/mshParser";

type DerivativeInfo={
 found:boolean;
 format:string;
 class:string;
 engine:string;
 note:string;
 state?:string;
 outputKind?:string;
 outputSize?:number;
 outputSha256?:string;
 errorCode?:string;
};

// Meshes beyond this size are refused before download (MOD07): a tab that
// buffers hundreds of megabytes of geometry is not a usable error state.
const MAX_INLINE_MODEL_BYTES=256*1024*1024;

// Real 3D preview: fetches the (converted) mesh from the API and renders it
// with three.js. STEP/IGES are server-converted by the CAD worker; STL/OBJ/GLB
// are streamed natively.
export function ModelViewer({user,onLogout}:{user:User;onLogout:()=>void}){
 const{id=""}=useParams();
 const navigate=useNavigate();
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[info,setInfo]=useState<DerivativeInfo|null>(null);
 const[fileMeta,setFileMeta]=useState<{sha256:string;versionSeq:number}|null>(null);
 const holder=useRef<HTMLDivElement>(null);
 const[metrics,setMetrics]=useState<{triangles:number;vertices:number;size:[number,number,number];components:number}|null>(null);
 // Mesh formats carry no unit; only 3MF declares one in its model XML. The
 // viewer must never silently assume millimetres (MOD04).
 const[unit,setUnit]=useState("unknown");
 const[layers,setLayers]=useState<{name:string;visible:boolean}[]>([]);
 // Assembly parts recovered from a converted mesh (MC02/MOD02): the MSH keeps
 // shared node indices, so connected components are the solids.
 const[parts,setParts]=useState<{name:string;visible:boolean;size:[number,number,number];triangles:number}[]>([]);
 const[selectedPart,setSelectedPart]=useState(-1);
 const mshRoot=useRef<import("three").Group|null>(null);
 const dxfRoot=useRef<import("three").Group|null>(null);
 const started=useRef(false);
 const controls=useRef<ViewerControls|null>(null);
 const[view,setView]=useState({axes:false,grid:true,projection:"perspective" as "perspective"|"orthographic"});

 // React Router can keep this component mounted while /model/:id changes.
 // Drop the previous GPU scene and restart loading for the new document.
 useEffect(()=>{
  started.current=false;
  return ()=>{
   controls.current?.dispose();
   controls.current=null;
   mshRoot.current=null;
   dxfRoot.current=null;
  };
 },[id]);

 useEffect(()=>{
  let valid=true;
  setStatus("loading");setMessage("");setInfo(null);setFileMeta(null);
  setMetrics(null);setLayers([]);setParts([]);setSelectedPart(-1);
  setUnit("unknown");setView({axes:false,grid:true,projection:"perspective"});
  const run=async()=>{
   try{
    let data=await fileApi.derivativeStatus(id);
    if(!valid)return;
    let derivative=data as unknown as DerivativeInfo;
    // Deep-link support (SPEC §20.5): a /model/:id visit with no derivative yet
    // creates one, so the page works for every non-licensed format without a
    // prior preview-page visit.
    if(!derivative.found){
     try{
      await fileApi.requestDerivative(id);
     }catch{
      setStatus("unsupported");
      return;
     }
     if(!valid)return;
     data=await fileApi.derivativeStatus(id);
     if(!valid)return;
     derivative=data as unknown as DerivativeInfo;
    }
    setInfo(derivative);
    // The metadata panel (MOD03) shows the source digest and the real version,
    // which live on the file rather than the derivative.
    try{
     const meta=await fileApi.meta(id);
     if(valid)setFileMeta({sha256:meta.file.sha256,versionSeq:meta.file.currentVersionSeq});
    }catch{
     if(valid)setFileMeta(null);
    }
    if(!derivative.found||derivative.class==="licensed"||derivative.class==="unverified"){
     setStatus("unsupported");
     return;
    }
    if(derivative.state==="queued"||derivative.state==="running"){
     setStatus("converting");
     return;
    }
    if(derivative.state==="failed"){
     setStatus("failed");
     return;
    }
    setStatus("loading-model");
   }catch(error){
    if(valid){setStatus("failed");setMessage(errorCopy(error,"无法读取模型信息"));}
   }
  };
  void run();
  return()=>{valid=false;};
 },[id]);

 // Parsing can outlive navigation. Every asynchronous boundary checks the
 // effect's lifetime; a parsed but unmounted scene owns disposable geometry.
 useEffect(()=>{
  if(status!=="loading-model"||started.current)return;
  started.current=true;
  let valid=true;
  const abort=new AbortController();
  let pendingObject:import("three").Object3D|null=null;
  (async()=>{
    try{
     const THREE=await import("three");
     const {OrbitControls}=await import("three/examples/jsm/controls/OrbitControls.js");
     if(!valid)return;
     const res=await fetch("/api/files/"+id+"/derivative/bytes",{
      credentials:"same-origin",signal:abort.signal,
     });
    if(!res.ok){await reportSessionResponse(res,"/files/derivative/bytes");throw new Error("derivative fetch failed");}
    // MOD07: a mesh too large for a browser tab is refused up front with an
    // actionable error and a download entry instead of hanging the page.
    const declared=Number(res.headers.get("Content-Length")??"0");
    if(declared>MAX_INLINE_MODEL_BYTES){
     if(valid)setStatus("too-large");
     return;
    }
     const buffer=await readBoundedModel(res,abort.signal);
     if(!valid)return;
    const format=(info?.outputKind??info?.format??"stl").toLowerCase();
     setUnit(declaredUnit(buffer,format));
    let object:import("three").Object3D;
    if(format==="dxf"){
     const parsed=parseDxf(new TextDecoder().decode(buffer),THREE);
     object=parsed.object;
     dxfRoot.current=parsed.object;
     setLayers(parsed.layers);
    }else if(format==="msh"){
     const parsed=await parseMshInWorker(buffer,abort.signal,THREE);
     if(!valid)return;
     object=parsed.group;
     mshRoot.current=parsed.group;
     setParts(parsed.parts);
    }else{
     // Sibling resolution is only needed by the multi-resource formats; the
     // resolver itself is lazy so single-file formats pay nothing.
     const resolveUrl=await siblingResolver(id);
     const parse=await loadParser(format,THREE,resolveUrl);
     object=await parse(buffer);
    }
     pendingObject=object;
     if(!valid)return;
     let mountedControls:ViewerControls|null=null;
     mountedControls=mountScene(THREE,OrbitControls,holder.current!,object,setMetrics,()=>{
      // The loading effect is cleaned up as soon as status becomes ready.
      // Scene lifetime instead belongs to controls.current (until navigation).
      if(controls.current===mountedControls){
       setStatus("webgl-lost");
       setMessage("浏览器 WebGL 上下文已丢失（通常是 GPU 资源被系统回收）");
      }
     });
     controls.current=mountedControls;
     pendingObject=null;
     setStatus("ready");
    }catch(error){
     if(valid){
      if(error instanceof ModelSizeLimitError)setStatus("too-large");
      else {setStatus("failed");setMessage(errorCopy(error,"模型加载失败"));}
     }
    }finally{
     if(pendingObject)disposeModelResources(pendingObject);
    }
   })();
   return()=>{valid=false;abort.abort();};
  },[status,id,info?.outputKind,info?.format]);

 return <AppShell user={user} onLogout={onLogout} product="模型预览" actions={<button type="button" onClick={()=>navigate("/preview/"+id)}>返回文件</button>}>
  <div className="panels">
   <main className="work">
    <div className="breadcrumb">模型预览 · {info?.format?.toUpperCase()??""} · {info?.class==="converted"?"服务端已转换":info?.format?.toLowerCase()==="dxf"?"二维工程图":"浏览器原生渲染"}</div>
    {layers.length>0&&<div className="toolbar" role="group" aria-label="图层">
     {layers.map(layer=><label key={layer.name} className="sort-label">
      <input type="checkbox" checked={layer.visible} onChange={event=>{
       setLayers(layers.map(item=>item.name===layer.name?{...item,visible:event.target.checked}:item));
       // Toggle visibility straight on the drawing's layer group.
        dxfRoot.current?.children.forEach(child=>{
         if(child.userData.layer===layer.name)child.visible=event.target.checked;
        });
        controls.current?.invalidate();
      }}/>
      {layer.name}
     </label>)}
    </div>}
    {parts.length>0&&<div className="toolbar" role="group" aria-label="装配零件">
     {parts.map((part,index)=>(
      <label key={part.name} className="sort-label">
       <input type="checkbox" checked={part.visible} onChange={event=>{
        setParts(parts.map((item,i)=>i===index?{...item,visible:event.target.checked}:item));
        const child=mshRoot.current?.children[index];
        if(child)child.visible=event.target.checked;
        controls.current?.invalidate();
       }}/>
       <button type="button" className={selectedPart===index?"on":""} onClick={()=>{
        setSelectedPart(selectedPart===index?-1:index);
        // Selecting a part highlights it; everything else returns to the base
        // material so only one part is ever emphasised (MOD02).
        mshRoot.current?.children.forEach((child,i)=>{
         const mesh=child as import("three").Mesh;
         const material=mesh.material as import("three").MeshPhongMaterial|undefined;
         if(!material||!material.emissive)return;
         material.emissive.setHex(i===(selectedPart===index?-1:index)?0x1b4f8a:0x000000);
        });
        controls.current?.invalidate();
       }}>{part.name}</button>
       <span className="toolbar-hint">{part.size.map(v=>v.toFixed(2)).join("×")} · {part.triangles}△</span>
      </label>
     ))}
     <button type="button" onClick={()=>{
      setParts(parts.map(item=>({...item,visible:true})));
      setSelectedPart(-1);
      mshRoot.current?.children.forEach(child=>{
       child.visible=true;
       const material=(child as import("three").Mesh).material as import("three").MeshPhongMaterial|undefined;
        material?.emissive?.setHex(0x000000);
       });
       controls.current?.invalidate();
     }}>全部显示</button>
    </div>}
    {status==="unsupported"&&<p className="empty">{info?.note??"该格式当前不支持在线预览"}</p>}
    {status==="converting"&&<p className="empty">模型转换中（Worker 处理），请稍后刷新…</p>}
    {status==="failed"&&<p role="alert" className="notice error">{message||"预览失败"}</p>}
    {status==="webgl-lost"&&<p role="alert" className="notice error">{message||"预览失败"} · <a href={"/api/files/"+id+"/bytes"}>下载原件</a></p>}
    {status==="too-large"&&<p role="alert" className="notice error">模型过大，浏览器内联渲染已取消 · <a href={"/api/files/"+id+"/bytes"}>下载原件</a></p>}
    {status==="loading-model"&&<p className="empty">正在加载几何数据…</p>}
    {status==="ready"&&<div className="toolbar" role="group" aria-label="视图控制">
     <button type="button" onClick={()=>controls.current?.resetView()}>重置视角</button>
     <button type="button" className={view.axes?"on":""} aria-pressed={view.axes} onClick={()=>setView(v=>({...v,axes:controls.current?.toggleAxes()??v.axes}))}>坐标轴</button>
     <button type="button" className={view.grid?"on":""} aria-pressed={view.grid} onClick={()=>setView(v=>({...v,grid:controls.current?.toggleGrid()??v.grid}))}>网格</button>
     <button type="button" className={view.projection==="orthographic"?"on":""} aria-pressed={view.projection==="orthographic"} onClick={()=>setView(v=>({...v,projection:controls.current?.toggleProjection()??v.projection}))}>{view.projection==="orthographic"?"正交投影":"透视投影"}</button>
    </div>}
    <div className="viewer-stage" ref={holder}/>
    {metrics&&<div className="toolbar"><span className="toolbar-hint">三角形 {metrics.triangles} · 顶点 {metrics.vertices} · 拖拽旋转 / 滚轮缩放 / 右键平移 · 工具栏可重置视角、切换坐标轴 / 网格 / 投影</span></div>}
    {metrics&&<div className="toolbar viewer-meta" role="group" aria-label="模型元数据">
     <span className="toolbar-hint">来源格式 {info?.format?.toUpperCase()??"-"}{info?.class==="converted"?"（服务端转换）":""}</span>
     <span className="toolbar-hint">版本 v{fileMeta?.versionSeq??"-"}</span>
     <span className="toolbar-hint">源 SHA {fileMeta?.sha256?.slice(0,16)??"-"}…</span>
     <span className="toolbar-hint">单位 {unit==="unknown"?"未知单位（不按毫米计算）":unit}</span>
     <span className="toolbar-hint">尺寸（近似，三角化网格）{metrics.size.map(v=>v.toFixed(2)).join(" × ")}</span>
     <span className="toolbar-hint">组件数 {metrics.components}</span>
     {info?.outputSha256&&<span className="toolbar-hint">派生 SHA {info.outputSha256.slice(0,16)}…</span>}
     {info?.note&&<span className="toolbar-hint">警告 {info.note}</span>}
    </div>}
   </main>
  </div>
 </AppShell>;
}

type MeshParser=(buffer:ArrayBuffer)=>Promise<import("three").Object3D>;
type MTLLoaderType=import("three/examples/jsm/loaders/MTLLoader.js").MTLLoader;

class ModelSizeLimitError extends Error{}

// HTTP Content-Length is optional and untrusted. Refuse an oversized *stream*
// before its bytes can accumulate in RAM, even for chunked transfer responses.
// Cancellation also releases a reader when the user navigates away.
async function readBoundedModel(response:Response,signal:AbortSignal):Promise<ArrayBuffer>{
 if(!response.body){
  const data=await response.arrayBuffer();
  if(data.byteLength>MAX_INLINE_MODEL_BYTES)throw new ModelSizeLimitError();
  return data;
 }
 const reader=response.body.getReader();
 const chunks:Uint8Array[]=[];
 let size=0;
 try{
  for(;;){
   if(signal.aborted)throw new DOMException("Aborted","AbortError");
   const {value,done}=await reader.read();
   if(done)break;
   if(!value)continue;
   size+=value.byteLength;
   if(size>MAX_INLINE_MODEL_BYTES)throw new ModelSizeLimitError();
   chunks.push(value);
  }
 }finally{
  reader.releaseLock();
  if(size>MAX_INLINE_MODEL_BYTES||signal.aborted)void response.body.cancel().catch(()=>{});
 }
 const result=new Uint8Array(size);
 let offset=0;
 for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
 return result.buffer;
}

// Object3D.remove() never frees GPU buffers. Dispose each shared geometry,
// material and texture exactly once, including material texture maps.
function disposeModelResources(root:import("three").Object3D):void{
 const geometries=new Set<import("three").BufferGeometry>();
 const materials=new Set<import("three").Material>();
 const textures=new Set<import("three").Texture>();
 root.traverse(node=>{
  const mesh=node as import("three").Mesh;
  if(mesh.geometry?.isBufferGeometry)geometries.add(mesh.geometry);
  if(mesh.material){
   for(const material of Array.isArray(mesh.material)?mesh.material:[mesh.material]){
    if(material?.isMaterial)materials.add(material);
   }
  }
 });
 for(const material of materials){
  for(const value of Object.values(material as unknown as Record<string,unknown>)){
   if(value&&typeof value==="object"&&"isTexture" in value&&value.isTexture===true){
    textures.add(value as import("three").Texture);
   }
  }
 }
 for(const geometry of geometries)geometry.dispose();
 for(const texture of textures)texture.dispose();
 for(const material of materials)material.dispose();
}

// declaredUnit reports the only unit the system can honestly state: 3MF
// declares it in its model XML, every other mesh format (STL/OBJ/glTF/PLY)
// carries none, so the viewer says "unknown" instead of assuming millimetres
// (MOD04/MOD05).
function declaredUnit(buffer:ArrayBuffer,format:string):string{
 if(format!=="3mf")return "unknown";
 const head=new TextDecoder().decode(buffer.slice(0,4096));
 const match=/unit="([^"]+)"/.exec(head);
 return match?match[1]??"unknown":"unknown";
}

// Multi-resource models (OBJ+MTL+textures, glTF+.bin+textures) reference their
// companions by relative name. In this system every companion is a separate
// file in the same folder, so relative references are resolved through the API
// against the sibling set. Absolute http(s) URLs are refused and redirected to
// a same-origin miss: the viewer must never become a fetch surface for
// attacker-controlled hosts (MC17).
async function siblingResolver(fileId:string){
 const meta=await fileApi.meta(fileId);
 const siblings=new Map<string,string>();
 let cursor="";
 for(let guard=0;guard<50;guard++){
  const page=await fileApi.list(meta.file.folderId,"name_asc",cursor,200);
  for(const item of page.items)siblings.set(item.name,item.id);
  if(!page.nextCursor)break;
  cursor=page.nextCursor;
 }
 return(url:string)=>{
  if(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(url)){
   // data:/blob: are self-contained and stay; http(s) and protocol-relative
   // URLs are refused with a same-origin miss.
   return /^(?:data|blob):/i.test(url)?url:"/api/files/__external_refused__/bytes";
  }
  const base=decodeURIComponent((url.split("/").pop()??"").split("?")[0]??"");
  const id=siblings.get(base);
  return id?"/api/files/"+id+"/bytes":url;
 };
}

async function loadParser(
 format:string,
 THREE:typeof import("three"),
 resolveUrl:(url:string)=>string,
):Promise<MeshParser>{
 switch(format.toLowerCase()){
  case "ply":{
   const {PLYLoader}=await import("three/examples/jsm/loaders/PLYLoader.js");
   const loader=new PLYLoader();
   return async (buffer:ArrayBuffer)=>{
    // PLYLoader yields a geometry; wrap it so every format is an Object3D.
    const geometry=loader.parse(buffer);
    geometry.computeVertexNormals();
    return new THREE.Mesh(geometry,new THREE.MeshPhongMaterial({color:0x2f7fd0}));
   };
  }
  case "3mf":{
   const {ThreeMFLoader}=await import("three/examples/jsm/loaders/3MFLoader.js");
   const loader=new ThreeMFLoader();
   return async (buffer:ArrayBuffer)=>loader.parse(buffer);
  }
  case "obj":{
   const {OBJLoader}=await import("three/examples/jsm/loaders/OBJLoader.js");
   const {MTLLoader}=await import("three/examples/jsm/loaders/MTLLoader.js");
   const {LoadingManager}=await import("three");
   return async (buffer:ArrayBuffer)=>{
    const text=new TextDecoder().decode(buffer);
    // mtllib references are separate files in the same folder; each is fetched
    // through the sibling resolver and parsed so OBJ materials and their
    // textures resolve (MC06).
    const refs=[...text.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)].map(m=>(m[1]??"").trim());
    let materials:Awaited<ReturnType<MTLLoaderType["parse"]>>|null=null;
    if(refs.length){
     const manager=new LoadingManager();
     manager.setURLModifier(resolveUrl);
     const mtlLoader=new MTLLoader(manager);
     for(const ref of refs){
      const url=resolveUrl(ref);
      if(!url.startsWith("/api/files/"))continue;
      const res=await fetch(url,{credentials:"same-origin"});
      if(!res.ok){await reportSessionResponse(res,url);continue;}
      // parse() returns the MaterialCreator that owns the parsed materials.
      materials=mtlLoader.parse(await res.text(),"");
     }
     materials?.preload();
    }
    const loader=new OBJLoader();
    if(materials)loader.setMaterials(materials);
    return loader.parse(text);
   };
  }
  case "glb":
  case "gltf":{
   const {GLTFLoader}=await import("three/examples/jsm/loaders/GLTFLoader.js");
   const {LoadingManager}=await import("three");
   return async (buffer:ArrayBuffer)=>{
    // External .bin/textures are sibling files; the manager's URL modifier maps
    // them onto the API and refuses absolute URLs (MC07 + MC17).
    const manager=new LoadingManager();
    manager.setURLModifier(resolveUrl);
    const loader=new GLTFLoader(manager);
    return (await loader.parseAsync(buffer,"")).scene;
   };
  }
  default:{
   const {STLLoader}=await import("three/examples/jsm/loaders/STLLoader.js");
   const loader=new STLLoader();
   return async (buffer:ArrayBuffer)=>{
    // STLLoader yields a geometry; wrap it so the scene code can treat every
    // format as an Object3D.
    const geometry=loader.parse(buffer);
    return new THREE.Mesh(geometry,new THREE.MeshPhongMaterial({color:0x2f7fd0}));
   };
  }
 }
}

// The Worker runs the expensive MSH 2.2 component graph and normal expansion.
// The UI thread only constructs THREE objects from transferred typed buffers.
type MshPart={name:string;visible:boolean;size:[number,number,number];triangles:number};

async function parseMshInWorker(
 buffer:ArrayBuffer,signal:AbortSignal,THREE:typeof import("three"),
):Promise<{group:import("three").Group;parts:MshPart[]}>{
 if(signal.aborted)throw new DOMException("Aborted","AbortError");
 const worker=new Worker(new URL("../features/modelViewer/mshWorker.ts",import.meta.url),{type:"module"});
 type Reply={ok:boolean;data?:MshGeometry;tooLarge?:boolean;error?:string};
 const result=await new Promise<MshGeometry>((resolve,reject)=>{
  const close=()=>{
   signal.removeEventListener("abort",onAbort);
   worker.terminate();
  };
  const onAbort=()=>{close();reject(new DOMException("Aborted","AbortError"));};
  signal.addEventListener("abort",onAbort,{once:true});
  worker.onerror=()=>{close();reject(Error("MSH 解析线程运行失败"));};
  worker.onmessage=(event:MessageEvent<Reply>)=>{
   close();
   if(!event.data.ok||!event.data.data){
    reject(event.data.tooLarge?new ModelSizeLimitError():Error(event.data.error??"网格解析失败"));
    return;
   }
   resolve(event.data.data);
  };
  worker.postMessage({buffer},[buffer]);
 });
 if(signal.aborted)throw new DOMException("Aborted","AbortError");
 const group=new THREE.Group();
 const parts:MshPart[]=[];
 try{
  for(let index=0;index<result.parts.length;index++){
   const part=result.parts[index]!;
   const geometry=new THREE.BufferGeometry();
   geometry.setAttribute("position",new THREE.BufferAttribute(part.positions,3));
   geometry.setAttribute("normal",new THREE.BufferAttribute(part.normals,3));
   const bounds=part.bounds;
   geometry.boundingBox=new THREE.Box3(
    new THREE.Vector3(bounds[0],bounds[1],bounds[2]),
    new THREE.Vector3(bounds[3],bounds[4],bounds[5]),
   );
   const mesh=new THREE.Mesh(geometry,new THREE.MeshPhongMaterial({
    color:0x2f7fd0,shininess:40,specular:0x22406b,
   }));
   mesh.name="组件 "+(index+1);
   group.add(mesh);
   parts.push({name:mesh.name,visible:true,triangles:part.triangles,
    size:[bounds[3]-bounds[0],bounds[4]-bounds[1],bounds[5]-bounds[2]]});
  }
 }catch(error){disposeModelResources(group);throw error;}
 return{group,parts};
}

// ViewerControls is the imperative surface the toolbar drives (SPEC §模型查看器
// MOD01/MOD07). mountScene returns it so the React layer stays declarative.
type ViewerControls={
 dispose:()=>void;
 invalidate:()=>void;
 resetView:()=>void;
 toggleAxes:()=>boolean;
 toggleGrid:()=>boolean;
 toggleProjection:()=>"perspective"|"orthographic";
};

function mountScene(
 THREE:typeof import("three"),
 OrbitControls:typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls,
 holder:HTMLDivElement,
 object:import("three").Object3D,
 setMetrics:(m:{triangles:number;vertices:number;size:[number,number,number];components:number})=>void,
 onContextLost?:()=>void,
):ViewerControls{
 const scene=new THREE.Scene();
 scene.background=new THREE.Color(0xf4f9fe);
 const aspect=holder.clientWidth/Math.max(holder.clientHeight,1);
 const persp=new THREE.PerspectiveCamera(45,aspect,0.1,100000);
 // Frame the model once: the box centre becomes the orbit target and the
 // radius drives both the perspective distance and the orthographic frustum.
 const box=new THREE.Box3().setFromObject(object);
 const size=box.getSize(new THREE.Vector3());
 const center=box.getCenter(new THREE.Vector3());
 object.position.sub(center);
 const radius=Math.max(size.x,size.y,size.z,0.001)/2;
 const frustum=radius*2.6;
 const ortho=new THREE.OrthographicCamera(
  -frustum*aspect,frustum*aspect,frustum,-frustum,-radius*50,radius*50,
 );
 let camera:import("three").PerspectiveCamera|import("three").OrthographicCamera=persp;
 const renderer=new THREE.WebGLRenderer({antialias:true});
 // A 3×–4× density screen can multiply GPU render-target memory by 9–16.
 // Clamp the canvas to 2×, preserving sharpness without unbounded allocation.
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
 renderer.setSize(holder.clientWidth,holder.clientHeight);
 holder.appendChild(renderer.domElement);
 // Annotated so the projection swap can rebind controls to either camera type.
 let controls:typeof OrbitControls.prototype=new OrbitControls(camera,renderer.domElement);
 controls.enableDamping=true;

 scene.add(new THREE.AmbientLight(0xffffff,0.6));
 const key=new THREE.DirectionalLight(0xffffff,1.1);
 key.position.set(1,1,1);
 scene.add(key);
 const fill=new THREE.DirectionalLight(0xcfe4ff,0.5);
 fill.position.set(-1,-0.5,-1);
 scene.add(fill);
 const grid=new THREE.GridHelper(Math.max(radius*4,10),20,0x9fc2e8,0xdfe9f4);
 scene.add(grid);
 const axes=new THREE.AxesHelper(radius*1.6);
 axes.visible=false;
 scene.add(axes);

 // Preserve source materials (including OBJ/3MF/glTF texture maps), rather
 // than replacing them with an allocated blue material on every mesh.
 scene.add(object);

 let invalidate=()=>{};
 const frame=()=>{
  // Damping residue from a drag would be re-applied on the next update() and
  // pull the camera away from the reset pose, so flush it first: one update
  // with damping off applies the leftover delta and zeroes it.
  controls.enableDamping=false;
  controls.update();
  controls.enableDamping=true;
  camera.position.set(radius*2.2,radius*1.8,radius*2.2);
  controls.target.set(0,0,0);
  controls.update();
  invalidate();
 };
 frame();
 let triangles=0,vertices=0;
 object.traverse(child=>{
  const mesh=child as import("three").Mesh;
  if(mesh.isMesh&&mesh.geometry){
   const g=mesh.geometry as import("three").BufferGeometry;
   if(g.index)triangles+=g.index.count/3;
   else if(g.attributes.position)triangles+=g.attributes.position.count/3;
   if(g.attributes.position)vertices+=g.attributes.position.count;
  }
 });
 // Components: direct children that carry geometry anywhere below them. A
 // converted STEP is one merged mesh (honest count of 1); a multi-part
 // glTF/3MF reports its parts even when the loader nests them in groups.
 let components=0;
 for(const child of object.children){
  let carries=false;
  child.traverse(node=>{
   if((node as import("three").Mesh).isMesh)carries=true;
  });
  if(carries)components++;
 }
 if(components===0&&triangles>0)components=1;
 setMetrics({triangles,vertices,size:[size.x,size.y,size.z],components});

 // Render only when the model/camera changes. A constantly running WebGL
 // loop burns GPU even on an idle document tab. OrbitControls emits a change
 // while dragging or damping, allowing frames until movement settles.
 let raf=0,needsFrame=true,disposed=false,contextLost=false;
 const requestFrame=()=>{
  if(!raf&&!disposed&&!contextLost&&!document.hidden)raf=requestAnimationFrame(draw);
 };
 const draw=()=>{
  raf=0;
  if(disposed||contextLost||document.hidden)return;
  const moving=controls.update();
  if(needsFrame||moving)renderer.render(scene,camera);
  needsFrame=false;
  if(moving)requestFrame();
 };
 invalidate=()=>{needsFrame=true;requestFrame();};
 controls.addEventListener("change",invalidate);
 invalidate();
 const onResize=()=>{
  if(disposed)return;
  const next=holder.clientWidth/Math.max(holder.clientHeight,1);
  persp.aspect=next;
  persp.updateProjectionMatrix();
  ortho.left=-frustum*next;
  ortho.right=frustum*next;
  ortho.updateProjectionMatrix();
  renderer.setSize(holder.clientWidth,holder.clientHeight);
  invalidate();
 };
 window.addEventListener("resize",onResize);
 const resizeObserver=new ResizeObserver(onResize);
 resizeObserver.observe(holder);
 const onVisibilityChange=()=>{
  if(document.hidden){cancelAnimationFrame(raf);raf=0;}
  else invalidate();
 };
 document.addEventListener("visibilitychange",onVisibilityChange);

 // MOD07: a lost WebGL context is surfaced as an actionable error instead of a
 // silently frozen canvas. preventDefault keeps the restore path available.
 const onLost=(event:Event)=>{
  event.preventDefault();
  contextLost=true;
  cancelAnimationFrame(raf);
  raf=0;
  if(onContextLost)onContextLost();
 };
 renderer.domElement.addEventListener("webglcontextlost",onLost);

 return {
  invalidate,
  resetView:frame,
  toggleAxes:()=>{
   axes.visible=!axes.visible;
   invalidate();
   return axes.visible;
  },
  toggleGrid:()=>{
   grid.visible=!grid.visible;
   invalidate();
   return grid.visible;
  },
  toggleProjection:()=>{
   const next=camera===persp?ortho:persp;
   next.position.copy(camera.position);
   controls.removeEventListener("change",invalidate);
   controls.dispose();
   camera=next;
   controls=new OrbitControls(camera,renderer.domElement);
   controls.enableDamping=true;
   controls.target.set(0,0,0);
   controls.addEventListener("change",invalidate);
   controls.update();
   invalidate();
   return camera===ortho?"orthographic":"perspective";
  },
  dispose:()=>{
   if(disposed)return;
   disposed=true;
   cancelAnimationFrame(raf);
   window.removeEventListener("resize",onResize);
   resizeObserver.disconnect();
   document.removeEventListener("visibilitychange",onVisibilityChange);
   renderer.domElement.removeEventListener("webglcontextlost",onLost);
   controls.removeEventListener("change",invalidate);
   controls.dispose();
   disposeModelResources(object);
   disposeModelResources(grid);
   disposeModelResources(axes);
   scene.remove(object,grid,axes);
   // forceContextLoss releases the GPU context immediately rather than waiting
   // for the GC to finalise the canvas (MOD08).
   renderer.dispose();
   renderer.forceContextLoss();
   if(renderer.domElement.parentNode)renderer.domElement.parentNode.removeChild(renderer.domElement);
  },
 };
}
