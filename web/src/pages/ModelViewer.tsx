import {useEffect,useRef,useState,type FormEvent} from "react";
import {useParams,Link} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {errorCopy} from "../shared/errors";
import type {FileItem} from "../entities/file/model";
import {parseDxf} from "../features/modelViewer/dxf";

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
export function ModelViewer(){
 const{id=""}=useParams();
 const[status,setStatus]=useState("loading");
 const[message,setMessage]=useState("");
 const[info,setInfo]=useState<DerivativeInfo|null>(null);
 const holder=useRef<HTMLDivElement>(null);
 const[stats,setStats]=useState<{triangles:number;vertices:number}|null>(null);
 const[layers,setLayers]=useState<{name:string;visible:boolean}[]>([]);
 const dxfRoot=useRef<import("three").Group|null>(null);

 useEffect(()=>{
  let valid=true;
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

 // One-shot mount: the ref guard keeps the scene alive when `status` flips to
 // ready; teardown runs only on real unmount so the canvas is never removed
 // by a dependency change.
 const started=useRef(false);
 const controls=useRef<ViewerControls|null>(null);
 const[view,setView]=useState({axes:false,grid:true,projection:"perspective" as "perspective"|"orthographic"});
 useEffect(()=>()=>{controls.current?.dispose();controls.current=null;},[]);
 useEffect(()=>{
  if(status!=="loading-model"||started.current)return;
  started.current=true;
  let valid=true;
  (async()=>{
   try{
    const THREE=await import("three");
    const {OrbitControls}=await import("three/examples/jsm/controls/OrbitControls.js");
    const res=await fetch("/api/files/"+id+"/derivative/bytes",{credentials:"same-origin"});
    if(!res.ok)throw new Error("derivative fetch failed");
    // MOD07: a mesh too large for a browser tab is refused up front with an
    // actionable error and a download entry instead of hanging the page.
    const declared=Number(res.headers.get("Content-Length")??"0");
    if(declared>MAX_INLINE_MODEL_BYTES){
     if(valid)setStatus("too-large");
     return;
    }
    const buffer=await res.arrayBuffer();
    if(!valid)return;
    const format=(info?.outputKind??info?.format??"stl").toLowerCase();
    let object:import("three").Object3D;
    if(format==="dxf"){
     const parsed=parseDxf(new TextDecoder().decode(buffer),THREE);
     object=parsed.object;
     dxfRoot.current=parsed.object;
     setLayers(parsed.layers);
    }else{
     // Sibling resolution is only needed by the multi-resource formats; the
     // resolver itself is lazy so single-file formats pay nothing.
     const resolveUrl=await siblingResolver(id);
     const parse=await loadParser(format,THREE,resolveUrl);
     object=await parse(buffer);
    }
    controls.current=mountScene(THREE,OrbitControls,holder.current!,object,setStats,()=>{
     if(valid){setStatus("webgl-lost");setMessage("浏览器 WebGL 上下文已丢失（通常是 GPU 资源被系统回收）");}
    });
    setStatus("ready");
   }catch(error){
    if(valid){setStatus("failed");setMessage(errorCopy(error,"模型加载失败"));}
   }
  })();
 },[status,id,info?.outputKind,info?.format]);

 return <div className="shell">
  <header className="header">
   <div className="brand"><span className="logo-placeholder" aria-label="官方 Logo 尚未导入">标志待入库</span>中晟生物科技 <span className="product">模型预览</span></div>
   <nav aria-label="主导航"><Link to={"/preview/"+id}>返回文件</Link><Link to="/doc">文档管理</Link></nav>
   <span className="account">{info?.format?.toUpperCase()??""}</span>
  </header>
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
      }}/>
      {layer.name}
     </label>)}
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
    {stats&&<div className="toolbar"><span className="toolbar-hint">三角形 {stats.triangles} · 顶点 {stats.vertices} · 拖拽旋转 / 滚轮缩放 / 右键平移 · 工具栏可重置视角、切换坐标轴 / 网格 / 投影</span></div>}
   </main>
  </div>
 </div>;
}

type MeshParser=(buffer:ArrayBuffer)=>Promise<import("three").Object3D>;
type MTLLoaderType=import("three/examples/jsm/loaders/MTLLoader.js").MTLLoader;

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
      if(!res.ok)continue;
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

// ViewerControls is the imperative surface the toolbar drives (SPEC §模型查看器
// MOD01/MOD07). mountScene returns it so the React layer stays declarative.
type ViewerControls={
 dispose:()=>void;
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
 setStats:(s:{triangles:number;vertices:number})=>void,
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
 renderer.setSize(holder.clientWidth,holder.clientHeight);
 renderer.setPixelRatio(window.devicePixelRatio);
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

 object.traverse(child=>{
  const mesh=child as import("three").Mesh;
  if(mesh.isMesh){
   mesh.material=new THREE.MeshPhongMaterial({color:0x2f7fd0,shininess:40,specular:0x22406b});
  }
 });
 scene.add(object);

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
 setStats({triangles,vertices});

 let raf=0;
 const animate=()=>{raf=requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);};
 animate();
 const onResize=()=>{
  const next=holder.clientWidth/Math.max(holder.clientHeight,1);
  persp.aspect=next;
  persp.updateProjectionMatrix();
  ortho.left=-frustum*next;
  ortho.right=frustum*next;
  ortho.updateProjectionMatrix();
  renderer.setSize(holder.clientWidth,holder.clientHeight);
 };
 window.addEventListener("resize",onResize);

 // MOD07: a lost WebGL context is surfaced as an actionable error instead of a
 // silently frozen canvas. preventDefault keeps the restore path available.
 const onLost=(event:Event)=>{
  event.preventDefault();
  if(onContextLost)onContextLost();
 };
 renderer.domElement.addEventListener("webglcontextlost",onLost);

 return {
  resetView:frame,
  toggleAxes:()=>{
   axes.visible=!axes.visible;
   return axes.visible;
  },
  toggleGrid:()=>{
   grid.visible=!grid.visible;
   return grid.visible;
  },
  toggleProjection:()=>{
   const next=camera===persp?ortho:persp;
   next.position.copy(camera.position);
   controls.dispose();
   camera=next;
   controls=new OrbitControls(camera,renderer.domElement);
   controls.enableDamping=true;
   controls.target.set(0,0,0);
   controls.update();
   return camera===ortho?"orthographic":"perspective";
  },
  dispose:()=>{
   cancelAnimationFrame(raf);
   window.removeEventListener("resize",onResize);
   renderer.domElement.removeEventListener("webglcontextlost",onLost);
   controls.dispose();
   // forceContextLoss releases the GPU context immediately rather than waiting
   // for the GC to finalise the canvas (MOD08).
   renderer.dispose();
   renderer.forceContextLoss();
   if(renderer.domElement.parentNode)renderer.domElement.parentNode.removeChild(renderer.domElement);
  },
 };
}
