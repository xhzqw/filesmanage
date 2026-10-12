import {RareButton,RareInput,RareSelect} from "../shared/ui/rare";
import {BrandLoader} from "../shared/ui/BrandLoader";
import {useEffect,useRef,useState} from "react";
import {useNavigate,useParams} from "react-router-dom";
import {fileApi} from "../features/documents/api";
import {errorCopy} from "../shared/errors";
import {reportSessionResponse} from "../shared/http";
import type {User} from "../entities/user/model";
import {AppShell} from "../shared/ui/AppShell";
import {parseDxf} from "../features/modelViewer/dxf";
import {decodeDxfBytes} from "../features/modelViewer/dxfEncoding";
import type {DrawingPickedSegment} from "../features/modelViewer/snap2d";
import {printCurrentSheet,type SheetSize} from "../features/modelViewer/printSheet";
import {openVectorPrint,type PlotScale} from "../features/modelViewer/vectorSheet";
import {openModelPrint} from "../features/modelViewer/modelPrintSheet";
import type {MshGeometry} from "../features/modelViewer/mshParser";
import {mountEngineeringScene,type ViewerControls,type ViewerMetrics} from "../features/modelViewer/viewerScene";
import "../features/modelViewer/viewer.css";

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
 return <ModelViewerStage id={id} user={user} onLogout={onLogout}/>;
}

// One CAD renderer for both the file workbench and the dedicated route.
export function EmbeddedModelViewer({fileId}:{fileId:string}){
 return <ModelViewerStage id={fileId} embedded/>;
}

function ModelViewerStage({id,user,onLogout,embedded=false}:{id:string;user?:User;onLogout?:()=>void;embedded?:boolean}){
 const navigate=useNavigate();
 const[status,setStatus]=useState("loading");
 const[retryEpoch,setRetryEpoch]=useState(0);
 const[loadPhase,setLoadPhase]=useState<"initial"|"fetching"|"downloading"|"parsing"|"scene">("initial");
 const[downloadProgress,setDownloadProgress]=useState<number|null>(null);
 const[conversionSeconds,setConversionSeconds]=useState(0);
 const[message,setMessage]=useState("");
 const[info,setInfo]=useState<DerivativeInfo|null>(null);
 const[fileMeta,setFileMeta]=useState<{sha256:string;versionSeq:number;name:string}|null>(null);
 const holder=useRef<HTMLDivElement>(null);
 const[metrics,setMetrics]=useState<ViewerMetrics|null>(null);
 // Mesh formats carry no unit; only 3MF declares one in its model XML. The
 // viewer must never silently assume millimetres (MOD04).
 const[unit,setUnit]=useState("unknown");
 const[measure,setMeasure]=useState<number|null>(null);
 const[selectedLine,setSelectedLine]=useState<DrawingPickedSegment|null>(null);
 const[darkDrawing,setDarkDrawing]=useState(true);
 const[showLengths,setShowLengths]=useState(true);
 const[skipped,setSkipped]=useState<string[]>([]);
 const[showCompatibility,setShowCompatibility]=useState(false);
 const[layers,setLayers]=useState<{name:string;visible:boolean}[]>([]);
 const[layouts,setLayouts]=useState<string[]>([]);
 const[activeLayout,setActiveLayout]=useState("Model");
 const[paperViewports,setPaperViewports]=useState({total:0,projected:0});
 const[plotScale,setPlotScale]=useState<PlotScale>(1);
 const[modelPaper,setModelPaper]=useState<SheetSize>("A3");
 const[plotColorMode,setPlotColorMode]=useState<"monochrome"|"source">("monochrome");
 const[plotError,setPlotError]=useState("");
 // Assembly parts recovered from a converted mesh (MC02/MOD02): the MSH keeps
 // shared node indices, so connected components are the solids.
 const[parts,setParts]=useState<{name:string;visible:boolean;size:[number,number,number];triangles:number}[]>([]);
 const[selectedPart,setSelectedPart]=useState(-1);
 const mshRoot=useRef<import("three").Group|null>(null);
 const dxfRoot=useRef<import("three").Group|null>(null);
 const drawingSession=useRef<((layout:string)=>void)|null>(null);
 const started=useRef(false);
 const controls=useRef<ViewerControls|null>(null);
 const[view,setView]=useState({axes:false,grid:true,edges:true,measure:false,projection:"perspective" as "perspective"|"orthographic"});
 const[cube,setCube]=useState({yaw:45,pitch:26});
 const drawing=(info?.outputKind??info?.format??"").toLowerCase()==="dxf";

 async function authorizePaperOutput(render:(popup:Window,versionSeq:number)=>void){
  const sha=fileMeta?.sha256;
  if(!sha){setMessage("文件信息尚未加载，无法核对打印版本");return;}
  const popup=window.open("","_blank");
  if(!popup){setMessage("浏览器阻止了打印预览弹窗，请允许弹出窗口");return;}
  popup.document.write('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><body style="font:14px system-ui;padding:2em">正在验证图纸打印权限…</body>');
  popup.document.close();
  try{
   const authorization=await fileApi.preparePrint(id,sha);
   if(authorization.sha256!==sha)throw new Error("文件版本已更新，请刷新后重试");
   if(popup.closed)throw new Error("打印窗口已关闭");
   render(popup,authorization.versionSeq);
   setMessage("");setPlotError("");
  }catch(error){
   if(!popup.closed)popup.close();
   const reason=errorCopy(error,"无打印权限或图纸版本已更新，请刷新后重试");
   setMessage(reason);setPlotError(reason);
  }
 }

 // React Router can keep this component mounted while /model/:id changes.
 // Drop the previous GPU scene and restart loading for the new document.
 useEffect(()=>{
  started.current=false;
  return ()=>{
   controls.current?.dispose();
   controls.current=null;
   mshRoot.current=null;
   dxfRoot.current=null;
   drawingSession.current=null;
  };
 },[id]);

 useEffect(()=>{
  let valid=true;
  started.current=false;
  controls.current?.dispose();controls.current=null;
  mshRoot.current=null;dxfRoot.current=null;drawingSession.current=null;
  setStatus("loading");setMessage("");setInfo(null);setFileMeta(null);
  setLoadPhase("initial");setDownloadProgress(null);setConversionSeconds(0);
  setMetrics(null);setLayers([]);setLayouts([]);setActiveLayout("Model");
  setPaperViewports({total:0,projected:0});
  setPlotScale(1);setPlotError("");
  setModelPaper("A3");setPlotColorMode("monochrome");
  setParts([]);setSelectedPart(-1);
  setUnit("unknown");setMeasure(null);setSkipped([]);setShowCompatibility(false);
  setSelectedLine(null);setDarkDrawing(true);setShowLengths(true);
  setView({axes:false,grid:true,edges:true,measure:false,projection:"perspective"});
  setCube({yaw:45,pitch:26});
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
     }catch(error){
      if(valid){setMessage(errorCopy(error,"模型转换请求失败"));setStatus("failed");}
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
      if(valid)setFileMeta({sha256:meta.file.sha256,versionSeq:meta.file.currentVersionSeq,name:meta.file.name});
     }catch{
      // A directly shared file may grant preview+print without folder LIST.
      // Print authorization must not accidentally depend on that separate ACL.
      try{
       const preview=await fileApi.preview(id);
       if(valid)setFileMeta({sha256:preview.sha256,versionSeq:0,name:preview.name});
      }catch{if(valid)setFileMeta(null);}
    }
    if(derivative.class==="licensed"||derivative.class==="unverified"){
     setStatus("unsupported");
     return;
    }
    // The worker may not expose its new job on the first status read.
    if(!derivative.found||derivative.state==="queued"||derivative.state==="running"){
     setStatus("converting");
     return;
    }
    if(derivative.state==="failed"){
     setMessage(derivative.errorCode?"模型转换失败："+derivative.errorCode:"模型转换失败");
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
 },[id,retryEpoch]);

 // Continue waiting in the same canvas while the CAD worker converts.
 // Stale polls cannot update an unmounted viewer or a different file.
 useEffect(()=>{
  if(status!=="converting")return;
  let active=true;
  let timer:ReturnType<typeof setTimeout>|undefined;
  const poll=async()=>{
   try{
    const next=await fileApi.derivativeStatus(id);
    if(!active)return;
    setInfo(next);
    if(next.state==="failed"){
     setMessage(next.errorCode?"模型转换失败："+next.errorCode:"模型转换失败");
     setStatus("failed");
    }else if(next.found&&["ready","completed","succeeded"].includes(next.state??"")){
     setStatus("loading-model");
    }else{
     timer=setTimeout(()=>void poll(),document.visibilityState==="hidden"?4500:1800);
    }
   }catch(error){
    if(active){setMessage(errorCopy(error,"无法查询转换状态"));setStatus("failed");}
   }
  };
  timer=setTimeout(()=>void poll(),1200);
  return()=>{active=false;if(timer!==undefined)clearTimeout(timer);};
 },[id,status]);

 // Show measured elapsed time, not a fabricated conversion percentage.
 useEffect(()=>{
  if(status!=="converting")return;
  const since=Date.now();
  setConversionSeconds(0);
  const timer=window.setInterval(()=>setConversionSeconds(Math.floor((Date.now()-since)/1000)),1000);
  return()=>window.clearInterval(timer);
 },[id,status]);

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
     setLoadPhase("fetching");
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
     if(valid)setLoadPhase("downloading");
     const buffer=await readBoundedModel(res,abort.signal,(loaded,total)=>{
      if(!valid)return;
      setDownloadProgress(total===null?null:Math.min(100,Math.floor(loaded/total*100)));
     });
     if(!valid)return;
     setLoadPhase("parsing");
    const format=(info?.outputKind??info?.format??"stl").toLowerCase();
     setUnit(declaredUnit(buffer,format));
    let object:import("three").Object3D;
    let drawingUnit="";
    if(format==="dxf"){
     const source=decodeDxfBytes(buffer);
     const parsed=parseDxf(source,THREE);
     object=parsed.object;
     dxfRoot.current=parsed.object;
     setLayers(parsed.layers);
     setSkipped(parsed.skipped);
     setUnit(parsed.unit);
     drawingUnit=parsed.unit;
     setLayouts(parsed.layouts);
     setActiveLayout(parsed.layout);
     setPaperViewports(parsed.viewports);
     // Each layout has different paper-space coordinates, geometry and bounds.
     // Dispose the previous renderer and remount a freshly scoped drawing;
     // do not use visibility-only switching (it retains the wrong fit/units).
     drawingSession.current=(name)=>{
      const next=parseDxf(source,THREE,name);
      controls.current?.dispose();
      controls.current=null;
      dxfRoot.current=next.object;
      let mounted:ViewerControls|null=null;
      mounted=mountEngineeringScene(THREE,OrbitControls,holder.current!,next.object,true,
       setMetrics,()=>{
        if(controls.current===mounted){
         setStatus("webgl-lost");
         setMessage("WebGL 上下文已丢失");
        }
       },setMeasure,()=>{},setSelectedLine,next.unit);
      controls.current=mounted;
      setLayers(next.layers);setSkipped(next.skipped);setShowCompatibility(false);
      setPaperViewports(next.viewports);
      setActiveLayout(next.layout);setMeasure(null);
      setPlotError("");
      setSelectedLine(null);setDarkDrawing(true);setShowLengths(true);
      setView({axes:false,grid:true,edges:false,measure:false,projection:"orthographic"});
     };
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
     setLoadPhase("scene");
     let mountedControls:ViewerControls|null=null;
     mountedControls=mountEngineeringScene(THREE,OrbitControls,holder.current!,object,format==="dxf",setMetrics,()=>{
      // The loading effect is cleaned up as soon as status becomes ready.
      // Scene lifetime instead belongs to controls.current (until navigation).
      if(controls.current===mountedControls){
       setStatus("webgl-lost");
       setMessage("浏览器 WebGL 上下文已丢失（通常是 GPU 资源被系统回收）");
      }
     },setMeasure,(yaw,pitch)=>setCube({yaw,pitch}),setSelectedLine,drawingUnit);
     controls.current=mountedControls;
     // The inline engineering preview opens with grid and coordinate axes.
     if(embedded&&format!=="dxf")mountedControls.toggleAxes();
     setView({axes:embedded&&format!=="dxf",grid:true,edges:format!=="dxf",measure:false,
      projection:format==="dxf"?"orthographic":"perspective"});
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

 const content=<main className={embedded?"cad-page cad-embedded":"work cad-page"}>
    {(!embedded||(drawing&&layouts.length>1))&&<div className="breadcrumb cad-title">
     <strong>{drawing?"二维工程图":"三维模型"}</strong>
     <span>{info?.format?.toUpperCase()??""}{info?.class==="converted"?" · 已转换":""}</span>
     {drawing&&status==="ready"&&layouts.length>1&&<div className="cad-layout-tabs" role="tablist" aria-label="图纸布局">
      {layouts.map(name=><RareButton type="button" key={name} role="tab" aria-selected={activeLayout===name}
       className={activeLayout===name?"on":""}
       onClick={()=>{if(activeLayout!==name)drawingSession.current?.(name);}}>
       {name==="Model"?"模型空间":name}
      </RareButton>)}
     </div>}
    </div>}
    <div className="cad-workbench">
     <section className="cad-viewport" aria-label={drawing?"工程图查看区域":"三维模型查看区域"}>
      <div className="viewer-stage" ref={holder}/>
      {status!=="ready"&&<div className="cad-status" role={status==="failed"||status==="webgl-lost"?"alert":"status"}>
       {(status==="loading"||status==="converting"||status==="loading-model")?
        <div className="cad-loading-body" aria-busy="true">
         <BrandLoader size="lg" decorative/>
         <strong>{status==="loading"?"正在准备模型":status==="converting"?
          (info?.state==="queued"?"正在排队转换":info?.state==="running"?"正在转换模型":"正在准备转换"):
          loadPhase==="fetching"?"正在获取几何数据":loadPhase==="downloading"?"正在下载模型":
          loadPhase==="parsing"?"正在解析几何结构":loadPhase==="scene"?"正在建立三维场景":"正在载入模型"}</strong>
         <div className="cad-loading-progress" role="progressbar" aria-label={status==="loading-model"&&loadPhase==="downloading"&&downloadProgress!==null?"模型下载进度":"模型加载进度"}
          aria-valuemin={0} aria-valuemax={100} aria-valuenow={status==="loading-model"&&loadPhase==="downloading"&&downloadProgress!==null?downloadProgress:undefined}>
          <span className={"cad-loading-progress-fill"+(status==="loading-model"&&loadPhase==="downloading"&&downloadProgress!==null?" is-measured":"")}
           style={status==="loading-model"&&loadPhase==="downloading"&&downloadProgress!==null?{transform:"scaleX("+downloadProgress/100+")"}:undefined}/>
         </div>
         {status==="loading-model"&&loadPhase==="downloading"&&downloadProgress!==null?
          <span className="cad-loading-caption">{downloadProgress}%</span>:
          status==="converting"&&conversionSeconds>=3?<span className="cad-loading-caption">已等待 {conversionSeconds} 秒</span>:null}
        </div>:
        <><strong>{status==="unsupported"?(info?.note??"该格式当前不支持在线预览"):
          status==="too-large"?"模型过大，已停止浏览器预览":
          status==="webgl-lost"?(message||"WebGL 上下文丢失"):(message||"预览失败")}</strong>
         {(status==="failed"||status==="webgl-lost")&&<RareButton type="button" onClick={()=>setRetryEpoch(value=>value+1)}>重试</RareButton>}
         {status==="too-large"&&<span>请下载后使用桌面 CAD 软件打开</span>}</>}
      </div>}
      {status==="ready"&&<div className="cad-toolbar" role="group" aria-label="工程视图工具">
       <RareButton type="button" title="将当前图形居中并适合画布" onClick={()=>{
        controls.current?.resetView();
        setView(v=>({...v,axes:false,measure:false,projection:drawing?"orthographic":"perspective"}));
       }}>适合窗口</RareButton>
       {drawing&&<div className="cad-toolgroup" role="group" aria-label="二维审图显示">
        <RareButton type="button" className={darkDrawing?"on":""} aria-pressed={darkDrawing}
         onClick={()=>setDarkDrawing(controls.current?.toggleDrawingTheme()??darkDrawing)}>
         {darkDrawing?"深色审图":"白纸模式"}</RareButton>
        <RareButton type="button" className={showLengths?"on":""} aria-pressed={showLengths}
         onClick={()=>setShowLengths(controls.current?.toggleLengthLabels()??showLengths)}>
         线长</RareButton>
       </div>}
       {!drawing&&<div className="cad-toolgroup" role="group" aria-label="标准视角">
        {(["iso","front","back","left","right","top","bottom"] as const).map((name,index)=>
         <RareButton key={name} type="button" onClick={()=>{
          controls.current?.setStandardView(name);
          setView(v=>({...v,projection:name==="iso"?v.projection:"orthographic"}));
         }}>{["等轴","前","后","左","右","俯","仰"][index]}</RareButton>)}
        </div>}
        {!drawing&&<RareButton type="button" disabled={!fileMeta||!metrics}
         title="生成主视、俯视、右视和等轴测的正交参考视图，浏览器打印" onClick={()=>{
          void authorizePaperOutput((popup,versionSeq)=>{
           const images=controls.current?.captureEngineeringViews();
           if(!images||!metrics||!fileMeta)throw new Error("模型未准备好，无法生成工程视图");
           openModelPrint({name:fileMeta.name,versionSeq,sha256:fileMeta.sha256,
            unit,format:info?.format??"模型",paper:modelPaper,metrics,views:images},popup);
          });
         }}>工程视图打印</RareButton>}
        <div className="cad-toolgroup" role="group" aria-label="辅助显示">
        <RareButton type="button" className={view.grid?"on":""} aria-pressed={view.grid}
         onClick={()=>setView(v=>({...v,grid:controls.current?.toggleGrid()??v.grid}))}>网格</RareButton>
        {!drawing&&<>
         <RareButton type="button" className={view.edges?"on":""} aria-pressed={view.edges}
          onClick={()=>setView(v=>({...v,edges:controls.current?.toggleEdges()??v.edges}))}>轮廓</RareButton>
         <RareButton type="button" className={view.axes?"on":""} aria-pressed={view.axes}
          onClick={()=>setView(v=>({...v,axes:controls.current?.toggleAxes()??v.axes}))}>坐标轴</RareButton>
         <RareButton type="button" className={view.projection==="orthographic"?"on":""}
          onClick={()=>setView(v=>({...v,projection:controls.current?.toggleProjection()??v.projection}))}>{view.projection==="orthographic"?"正交":"透视"}</RareButton>
        </>}
       </div>
       <RareButton type="button" title={drawing?"依次点击两个点测量距离":"点击两个模型点测量距离"} className={view.measure?"on":""} aria-pressed={view.measure}
        onClick={()=>setView(v=>({...v,measure:controls.current?.toggleMeasure()??v.measure}))}>测距</RareButton>
       {drawing&&<RareButton type="button" onClick={()=>{
        const image=controls.current?.exportPng();
        if(!image)return;
        const anchor=document.createElement("a");
        anchor.href=image;
        anchor.download="drawing-"+id.replace(/[^a-zA-Z0-9_-]/g,"").slice(0,60)+"-"+
         activeLayout.replace(/[^\p{L}\p{N}_-]/gu,"_").slice(0,50)+".png";
        anchor.click();
       }} title="导出当前图纸 PNG">PNG</RareButton>}
        {drawing&&activeLayout!=="Model"&&(["A4","A3"] as const).map((paper:SheetSize)=>
         <RareButton key={paper} type="button" disabled={!fileMeta} title="适合纸张打印当前图像，非CAD精确比例出图" onClick={()=>{
          const snapshot=controls.current?.exportPng();
          if(!snapshot)return;
          void authorizePaperOutput(popup=>{if(!printCurrentSheet(snapshot,paper,activeLayout,popup))
           throw new Error("打印窗口已关闭");});
         }}>{paper}打印</RareButton>)}
       {drawing&&message.startsWith("浏览器阻止了打印")&&
        <span className="cad-print-error" role="alert">{message}</span>}
      </div>}
      {status==="ready"&&!drawing&&<div className="cad-viewcube" role="group" aria-label="方向导航立方体">
       <div className="cad-viewcube-body" style={{transform:"rotateX("+cube.pitch+"deg) rotateY("+(-cube.yaw)+"deg)"}}>
        {(["front","back","left","right","top","bottom"] as const).map((direction,index)=>
         <RareButton type="button" key={direction} className={"cad-cubeface cad-cubeface-"+direction}
          aria-label={["前视图","后视图","左视图","右视图","俯视图","仰视图"][index]}
          onClick={()=>{
           controls.current?.setStandardView(direction);
           setView(v=>({...v,projection:"orthographic"}));
          }}>{["前","后","左","右","上","下"][index]}</RareButton>)}
       </div>
      </div>}
     </section>
     {status==="ready"&&<aside className="cad-inspector" aria-label="工程文件属性">
      {drawing&&<section className="cad-inspector-section cad-dimension-panel">
       <h3>几何审图 <span>XY</span></h3>
       <div className="cad-dimension-value" title="点击线段查看长度；曲线离散段不代表完整弧长">
        {selectedLine?selectedLine.length.toLocaleString("zh-CN",{maximumFractionDigits:4})+" "+(unit==="unknown"?"单位未声明":unit):"选择线段"}
       </div>
       {selectedLine&&<div className="cad-coordinate-pair" title="原图坐标 X, Y">
        <span>A ({selectedLine.x1.toPrecision(5)}, {selectedLine.y1.toPrecision(5)})</span>
        <span>B ({selectedLine.x2.toPrecision(5)}, {selectedLine.y2.toPrecision(5)})</span>
       </div>}
       {selectedLine&&<RareButton type="button" onClick={()=>{setSelectedLine(null);controls.current?.clearLineSelection();}}>清除</RareButton>}
      </section>}
      {drawing&&activeLayout!=="Model"&&<section className="cad-inspector-section cad-print">
       <h3>比例出图</h3>
       <label className="cad-print-scale">
        <span>打印比例</span>
        <RareSelect aria-label="打印比例" value={String(plotScale)} onChange={event=>{
         setPlotScale(Number(event.target.value) as PlotScale);setPlotError("");
        }}>
         <option value="1">1:1</option>
         <option value="2">1:2</option>
         <option value="5">1:5</option>
          <option value="10">1:10</option>
          <option value="20">1:20</option>
          <option value="50">1:50</option>
         </RareSelect>
        </label>
        <label className="cad-print-scale"><span>出图颜色</span>
         <RareSelect aria-label="出图颜色" value={plotColorMode} onChange={event=>setPlotColorMode(event.target.value as "monochrome"|"source")}>
          <option value="monochrome">黑白高对比</option><option value="source">原图颜色</option>
         </RareSelect>
        </label>
        <div className="cad-quick-actions">
          {(["A4","A3","A2","A1"] as const).map(sheet=><RareButton key={sheet} type="button"
          disabled={unit!=="mm"||!fileMeta} onClick={()=>{
           const root=dxfRoot.current;
           if(!root)return;
            void authorizePaperOutput(popup=>openVectorPrint(root,{sheet,scale:plotScale,unit,layout:activeLayout,colorMode:plotColorMode},popup));
         }} title={sheet+" 矢量打印；打印时使用 100% 实际大小"}>{sheet} 矢量</RareButton>)}
       </div>
       {unit!=="mm"&&<p className="cad-notice">仅支持毫米 DXF</p>}
       {plotError&&<p className="cad-notice" role="alert">{plotError}</p>}
      </section>}
       {!drawing&&<section className="cad-inspector-section cad-print">
        <h3>工程视图打印</h3>
        <label className="cad-print-scale"><span>纸张</span>
         <RareSelect aria-label="工程视图纸张" value={modelPaper} onChange={event=>setModelPaper(event.target.value as SheetSize)}>
          <option value="A4">A4 横向</option><option value="A3">A3 横向</option>
          <option value="A2">A2 横向</option><option value="A1">A1 横向</option>
         </RareSelect>
        </label>
        <p className="cad-notice">四视图为网格参考投影，非加工制造图纸。</p>
       </section>}
      {layers.length>0&&<section className="cad-inspector-section">
       <h3>图层 <span>{layers.filter(item=>item.visible).length}/{layers.length}</span></h3>
       <div className="cad-quick-actions" role="group" aria-label="批量显示图层">
        <RareButton type="button" onClick={()=>{
         setLayers(current=>current.map(item=>({...item,visible:true})));
         dxfRoot.current?.children.forEach(child=>{child.visible=true;});
         controls.current?.invalidate();
        }}>全部显示</RareButton>
        <RareButton type="button" onClick={()=>{
         setLayers(current=>current.map(item=>({...item,visible:false})));
         dxfRoot.current?.children.forEach(child=>{child.visible=false;});
         controls.current?.invalidate();
        }}>全部隐藏</RareButton>
       </div>
       <div className="cad-layer-list" role="group" aria-label="图层可见性">
        {layers.map(layer=><label className="cad-layer" key={layer.name}>
         <RareInput type="checkbox" checked={layer.visible} onChange={event=>{
          setLayers(current=>current.map(item=>item.name===layer.name?{...item,visible:event.target.checked}:item));
          dxfRoot.current?.children.forEach(child=>{if(child.userData.layer===layer.name)child.visible=event.target.checked;});
          controls.current?.invalidate();
         }}/>
         <span title={layer.name}>{layer.name}</span>
        </label>)}
       </div>
      </section>}
      {parts.length>0&&<section className="cad-inspector-section">
       <h3>装配零件 <span>{parts.filter(item=>item.visible).length}/{parts.length}</span></h3>
       <div className="cad-layer-list" role="group" aria-label="装配零件可见性">
        {parts.map((part,index)=><div className="cad-part" key={part.name}>
         <RareInput type="checkbox" checked={part.visible} aria-label={part.name+"可见"} onChange={event=>{
          setParts(current=>current.map((item,i)=>i===index?{...item,visible:event.target.checked}:item));
          const child=mshRoot.current?.children[index];if(child)child.visible=event.target.checked;
          controls.current?.invalidate();
         }}/>
         <RareButton type="button" className={selectedPart===index?"on":""} onClick={()=>{
          const next=selectedPart===index?-1:index;setSelectedPart(next);
          mshRoot.current?.children.forEach((child,i)=>{
           const mat=(child as import("three").Mesh).material as import("three").MeshPhongMaterial|undefined;
           mat?.emissive?.setHex(i===next?0x1b4f8a:0x000000);
          });
          controls.current?.invalidate();
         }}>{part.name}</RareButton>
         <RareButton type="button" onClick={()=>{const child=mshRoot.current?.children[index];if(child)controls.current?.focusObject(child);}}>定位</RareButton>
        </div>)}
       </div>
       <RareButton type="button" onClick={()=>{
        setParts(current=>current.map(item=>({...item,visible:true})));setSelectedPart(-1);
        mshRoot.current?.children.forEach(child=>{
         child.visible=true;
         const mat=(child as import("three").Mesh).material as import("three").MeshPhongMaterial|undefined;
         mat?.emissive?.setHex(0x000000);
        });
        controls.current?.invalidate();
       }}>全部显示</RareButton>
      </section>}
      {view.measure&&<section className="cad-inspector-section">
       <h3>测量</h3>
       <strong className="cad-measure">{measure===null?"请选择两个点":measure.toLocaleString("zh-CN",{maximumFractionDigits:4})+" "+(unit==="unknown"?(drawing?"绘图单位":"模型单位"):unit)}</strong>
       <RareButton type="button" title={drawing?"按二维坐标计算；曲线捕捉基于离散线段":"三维网格近似距离"} onClick={()=>controls.current?.clearMeasurement()}>清除</RareButton>
      </section>}
      {metrics&&<section className="cad-inspector-section cad-properties">
       <h3>文件属性</h3>
        <div><span>版本</span><strong>{fileMeta?.versionSeq?"v"+fileMeta.versionSeq:"-"}</strong></div>
      <div><span>单位</span><strong>{unit==="unknown"?"未声明":unit}</strong></div>
      {drawing&&paperViewports.total>0&&<div><span>纸空间视口</span>
       <strong>{paperViewports.projected}/{paperViewports.total} 已投影</strong></div>}
       <div><span>尺寸</span><strong>{(drawing?metrics.size.slice(0,2):metrics.size).map(v=>Number(v.toPrecision(5))).join(" × ")}</strong></div>
       {!drawing&&<div><span>三角面</span><strong>{metrics.triangles.toLocaleString()}</strong></div>}
       {!drawing&&<div><span>网格组</span><strong title="网格组数量不等于原始 CAD 装配零件数量">{metrics.components}</strong></div>}
       <div><span>格式</span><strong>{info?.format?.toUpperCase()??"-"}</strong></div>
       <div><span>源校验</span><strong title={fileMeta?.sha256}>{fileMeta?.sha256?.slice(0,10)??"-"}…</strong></div>
       {(info?.note||skipped.length>0)&&<>
        <RareButton type="button" aria-expanded={showCompatibility} onClick={()=>setShowCompatibility(value=>!value)}>
         兼容提示{skipped.length>0?" ("+skipped.length+")":""} {showCompatibility?"收起":"展开"}
        </RareButton>
        {showCompatibility&&<div className="cad-compat-details" role="status">
         {info?.note&&<p>{info.note}</p>}
         {skipped.map((note,index)=><p key={index}>{note}</p>)}
        </div>}
       </>}
      </section>}
     </aside>}
    </div>
   </main>;
 if(embedded)return content;
 return <AppShell user={user!} onLogout={onLogout!} product={drawing?"图纸预览":"模型预览"} actions={<RareButton type="button" onClick={()=>navigate("/preview/"+id)}>返回文件</RareButton>}>
  <div className="panels">{content}</div>
 </AppShell>;
}

type MeshParser=(buffer:ArrayBuffer)=>Promise<import("three").Object3D>;
type MTLLoaderType=import("three/examples/jsm/loaders/MTLLoader.js").MTLLoader;

class ModelSizeLimitError extends Error{}

// HTTP Content-Length is optional and untrusted. Refuse an oversized *stream*
// before its bytes can accumulate in RAM, even for chunked transfer responses.
// Cancellation also releases a reader when the user navigates away.
async function readBoundedModel(response:Response,signal:AbortSignal,onProgress?:(bytes:number,total:number|null)=>void):Promise<ArrayBuffer>{
 const length=Number(response.headers.get("Content-Length"));
 const total=Number.isSafeInteger(length)&&length>0&&length<=MAX_INLINE_MODEL_BYTES?length:null;
 if(!response.body){
  const data=await response.arrayBuffer();
  if(data.byteLength>MAX_INLINE_MODEL_BYTES)throw new ModelSizeLimitError();
  onProgress?.(data.byteLength,total);
  return data;
 }
 const reader=response.body.getReader();
 const chunks:Uint8Array[]=[];
 let size=0,lastReported=-1;
 try{
  for(;;){
   if(signal.aborted)throw new DOMException("Aborted","AbortError");
   const {value,done}=await reader.read();
   if(done)break;
   if(!value)continue;
   size+=value.byteLength;
   if(size>MAX_INLINE_MODEL_BYTES)throw new ModelSizeLimitError();
   chunks.push(value);
   const percent=total===null?-1:Math.min(100,Math.floor(size/total*100));
   if(percent!==lastReported){lastReported=percent;onProgress?.(size,total);}
  }
 }finally{
  reader.releaseLock();
  if(size>MAX_INLINE_MODEL_BYTES||signal.aborted)void response.body.cancel().catch(()=>{});
 }
 onProgress?.(size,total);
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
