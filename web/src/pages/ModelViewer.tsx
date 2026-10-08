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
 const teardown=useRef<null|(()=>void)>(null);
 useEffect(()=>()=>{if(teardown.current)teardown.current();},[]);
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
     const parse=await loadParser(format,THREE);
     object=await parse(buffer);
    }
    teardown.current=mountScene(THREE,OrbitControls,holder.current!,object,setStats);
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
    {status==="loading-model"&&<p className="empty">正在加载几何数据…</p>}
    <div className="viewer-stage" ref={holder}/>
    {stats&&<div className="toolbar"><span className="toolbar-hint">三角形 {stats.triangles} · 顶点 {stats.vertices} · 拖拽旋转 / 滚轮缩放 / 右键平移</span></div>}
   </main>
  </div>
 </div>;
}

type MeshParser=(buffer:ArrayBuffer)=>Promise<import("three").Object3D>;

async function loadParser(format:string,THREE:typeof import("three")):Promise<MeshParser>{
 switch(format.toLowerCase()){
  case "ply":{
   const {PLYLoader}=await import("three/examples/jsm/loaders/PLYLoader.js");
   const loader=new PLYLoader();
   const THREE=await import("three");
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
   const loader=new OBJLoader();
   return async (buffer:ArrayBuffer)=>loader.parse(new TextDecoder().decode(buffer));
  }
  case "glb":
  case "gltf":{
   const {GLTFLoader}=await import("three/examples/jsm/loaders/GLTFLoader.js");
   const loader=new GLTFLoader();
   return async (buffer:ArrayBuffer)=>(await loader.parseAsync(buffer,"")).scene;
  }
  default:{
   const {STLLoader}=await import("three/examples/jsm/loaders/STLLoader.js");
   const loader=new STLLoader();
   const THREE=await import("three");
   return async (buffer:ArrayBuffer)=>{
    // STLLoader yields a geometry; wrap it so the scene code can treat every
    // format as an Object3D.
    const geometry=loader.parse(buffer);
    return new THREE.Mesh(geometry,new THREE.MeshPhongMaterial({color:0x2f7fd0}));
   };
  }
 }
}

function mountScene(
 THREE:typeof import("three"),
 OrbitControls:typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls,
 holder:HTMLDivElement,
 object:import("three").Object3D,
 setStats:(s:{triangles:number;vertices:number})=>void,
):()=>void{
 const scene=new THREE.Scene();
 scene.background=new THREE.Color(0xf4f9fe);
 const camera=new THREE.PerspectiveCamera(45,holder.clientWidth/Math.max(holder.clientHeight,1),0.1,100000);
 const renderer=new THREE.WebGLRenderer({antialias:true});
 renderer.setSize(holder.clientWidth,holder.clientHeight);
 renderer.setPixelRatio(window.devicePixelRatio);
 holder.appendChild(renderer.domElement);
 const controls=new OrbitControls(camera,renderer.domElement);
 controls.enableDamping=true;

 scene.add(new THREE.AmbientLight(0xffffff,0.6));
 const key=new THREE.DirectionalLight(0xffffff,1.1);
 key.position.set(1,1,1);
 scene.add(key);
 const fill=new THREE.DirectionalLight(0xcfe4ff,0.5);
 fill.position.set(-1,-0.5,-1);
 scene.add(fill);
 scene.add(new THREE.GridHelper(100,20,0x9fc2e8,0xdfe9f4));

 object.traverse(child=>{
  const mesh=child as import("three").Mesh;
  if(mesh.isMesh){
   mesh.material=new THREE.MeshPhongMaterial({color:0x2f7fd0,shininess:40,specular:0x22406b});
  }
 });
 scene.add(object);
 const box=new THREE.Box3().setFromObject(object);
 const size=box.getSize(new THREE.Vector3());
 const center=box.getCenter(new THREE.Vector3());
 object.position.sub(center);
 const radius=Math.max(size.x,size.y,size.z)/2;
 camera.position.set(radius*2.2,radius*1.8,radius*2.2);
 controls.target.set(0,0,0);
 controls.update();
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

 let frame=0;
 const animate=()=>{frame=requestAnimationFrame(animate);controls.update();renderer.render(scene,camera);};
 animate();
 const onResize=()=>{
  camera.aspect=holder.clientWidth/Math.max(holder.clientHeight,1);
  camera.updateProjectionMatrix();
  renderer.setSize(holder.clientWidth,holder.clientHeight);
 };
 window.addEventListener("resize",onResize);
 return()=>{
  cancelAnimationFrame(frame);
  window.removeEventListener("resize",onResize);
  controls.dispose();
  renderer.dispose();
  if(renderer.domElement.parentNode)renderer.domElement.parentNode.removeChild(renderer.domElement);
 };
}
