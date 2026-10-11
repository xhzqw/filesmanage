import type * as Three from "three";
import {createDrawingSnapIndex,type DrawingSegment} from "./snap2d";

export type StandardView="iso"|"front"|"back"|"left"|"right"|"top"|"bottom";
export type ViewerMetrics={triangles:number;vertices:number;size:[number,number,number];components:number};
export type ViewerControls={
 dispose:()=>void;invalidate:()=>void;resetView:()=>void;
 setStandardView:(view:StandardView)=>void;
 focusObject:(object:Three.Object3D)=>void;
 toggleAxes:()=>boolean;toggleGrid:()=>boolean;toggleEdges:()=>boolean;
 toggleProjection:()=>"perspective"|"orthographic";
 toggleMeasure:()=>boolean;clearMeasurement:()=>void;
 exportPng:()=>string|null;
};

/** A Y-up solids viewport or an orthographic XY drawing sheet. */
export function mountEngineeringScene(
 THREE:typeof import("three"),
 OrbitControls:typeof import("three/examples/jsm/controls/OrbitControls.js").OrbitControls,
 holder:HTMLDivElement,object:Three.Object3D,drawing:boolean,
 setMetrics:(m:ViewerMetrics)=>void,onContextLost:()=>void,onMeasure:(m:number|null)=>void,
 onCameraDirection:(yaw:number,pitch:number)=>void=()=>{},
):ViewerControls{
 const scene=new THREE.Scene();
 scene.background=new THREE.Color(drawing?0xffffff:0xf0f5fa);
 const box=new THREE.Box3().setFromObject(object);
 if(box.isEmpty())box.set(new THREE.Vector3(-1,-1,-1),new THREE.Vector3(1,1,1));
 const size=box.getSize(new THREE.Vector3()),center=box.getCenter(new THREE.Vector3());
 object.position.sub(center);
 const diameter=Math.max(size.x,size.y,size.z,.00001),radius=diameter/2;
 scene.add(object);
 // Build the index in world coordinates *after* the model has been centered.
 // For a very large drawing, skip the index rather than freeze the UI while
 // allocating millions of snap entries; free-space measurement still works.
 const drawingSegments:DrawingSegment[]=[];
 if(drawing){
  object.updateMatrixWorld(true);
  object.traverse(node=>{
   if(!(node as Three.LineSegments).isLineSegments||drawingSegments.length>350000)return;
   const line=node as Three.LineSegments;
   const positions=line.geometry.getAttribute("position");
   if(!positions)return;
   const a=new THREE.Vector3(),b=new THREE.Vector3();
   for(let i=0;i+1<positions.count&&drawingSegments.length<=350000;i+=2){
    a.fromBufferAttribute(positions,i).applyMatrix4(line.matrixWorld);
    b.fromBufferAttribute(positions,i+1).applyMatrix4(line.matrixWorld);
    drawingSegments.push({x1:a.x,y1:a.y,x2:b.x,y2:b.y});
   }
  });
 }
 const drawingSnap=drawing&&drawingSegments.length<=350000?createDrawingSnapIndex(drawingSegments):null;
 if(!drawing){
  scene.add(new THREE.HemisphereLight(0xe9f4ff,0x90a6bb,2));
  const lights:[number,number,number,number,number][]=[
   [3,5,4,2.2,0xffffff],[-4,1,-3,1.05,0xc0deff],[1,3,-5,.7,0xffffff],
  ];
  for(const [x,y,z,power,color] of lights){
   const light=new THREE.DirectionalLight(color,power);light.position.set(x,y,z);scene.add(light);
  }
 }
 let triangles=0,vertices=0,components=0;
 const outlines:Three.LineSegments[]=[];
 object.traverse(node=>{
  const mesh=node as Three.Mesh;
  if(!mesh.isMesh||!mesh.geometry)return;
  const geometry=mesh.geometry as Three.BufferGeometry;
  const count=geometry.getAttribute("position")?.count??0;
  vertices+=count;triangles+=(geometry.index?.count??count)/3;
  // Bound edge extraction for large tessellations; don't replace source materials.
  if(!drawing&&count>0&&count<=240000){
   const edge=new THREE.LineSegments(new THREE.EdgesGeometry(geometry,28),
    new THREE.LineBasicMaterial({color:0x183c5c,transparent:true,opacity:.56,depthTest:true,depthWrite:false}));
   edge.renderOrder=2;mesh.add(edge);outlines.push(edge);
  }
 });
 for(const child of object.children){
  let meshPresent=false;
  child.traverse(n=>{if((n as Three.Mesh).isMesh)meshPresent=true;});
  if(meshPresent)components++;
 }
 if(components===0&&triangles>0)components=1;
 setMetrics({triangles:Math.round(triangles),vertices,size:[size.x,size.y,size.z],components});
 const aspect=()=>Math.max(holder.clientWidth,1)/Math.max(holder.clientHeight,1);
 const halfHeight=()=>Math.max(size.y*.62,size.x/Math.max(aspect(),.1)*.62,diameter*.1,.00001);
 const near=Math.max(radius/10000,.000001),far=Math.max(radius*250,1);
 const persp=new THREE.PerspectiveCamera(42,aspect(),near,far);
 const ortho=new THREE.OrthographicCamera(-halfHeight()*aspect(),halfHeight()*aspect(),halfHeight(),-halfHeight(),-far,far);
 let camera:Three.OrthographicCamera|Three.PerspectiveCamera=drawing?ortho:persp;
 const renderer=new THREE.WebGLRenderer({antialias:true,powerPreference:"high-performance"});
 renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));
 renderer.outputColorSpace=THREE.SRGBColorSpace;
 renderer.setSize(Math.max(holder.clientWidth,1),Math.max(holder.clientHeight,1));
 renderer.domElement.style.cssText="display:block;width:100%;height:100%;touch-action:none";
 renderer.domElement.setAttribute("aria-label",drawing?"工程图画布":"三维模型画布");
 holder.appendChild(renderer.domElement);
 const axes=new THREE.AxesHelper(radius*1.1);
 axes.position.set(-size.x/2,-size.y/2,-size.z/2);axes.visible=false;
 if(!drawing)scene.add(axes);
 const grid=new THREE.Group();
 if(drawing){grid.rotation.x=Math.PI/2;grid.position.z=-Math.max(radius*.002,.000001);}
 else grid.position.y=-size.y/2-Math.max(radius*.035,.000001);
 scene.add(grid);
 let gridVisible=!drawing,outlineVisible=true,stepLast=0;
 grid.visible=gridVisible;
 let controls=new OrbitControls(camera,renderer.domElement);
 let viewName:StandardView=drawing?"front":"iso";
 const distance=Math.max(radius*3.5,radius/Math.tan(21*Math.PI/180)*1.35);
 let raf=0,dirty=true,disposed=false,lost=false;
 const invalidate=()=>{dirty=true;if(!raf&&!document.hidden&&!disposed&&!lost)raf=requestAnimationFrame(draw);};
 let lastDirection="";
 const cameraDirection=()=>{
  if(drawing)return;
  const vector=camera.position.clone().sub(controls.target).normalize();
  const yaw=Math.atan2(vector.x,vector.z)*180/Math.PI;
  const pitch=Math.atan2(vector.y,Math.hypot(vector.x,vector.z))*180/Math.PI;
  const key=Math.round(yaw)+":"+Math.round(pitch);
  if(key!==lastDirection){lastDirection=key;onCameraDirection(yaw,pitch);}
 };
 const setupControls=()=>{
  controls.enableDamping=true;controls.dampingFactor=.09;
  controls.screenSpacePanning=true;controls.enableRotate=!drawing;
  controls.minDistance=Math.max(radius*.015,near*2);controls.maxDistance=radius*90;
  controls.minZoom=.015;controls.maxZoom=150;
  if(drawing)controls.mouseButtons.LEFT=THREE.MOUSE.PAN;
  controls.addEventListener("change",invalidate);
  controls.addEventListener("change",cameraDirection);
 };
 setupControls();
 const switchCamera=(next:Three.OrthographicCamera|Three.PerspectiveCamera)=>{
  if(camera===next)return;
  const target=controls.target.clone(),position=camera.position.clone();
  const distanceToTarget=Math.max(position.distanceTo(target),near);
  // Preserve visible model scale when changing projection. Copying camera
  // positions alone makes ortho/ perspective toggle appear to jump.
  if(next===ortho){
   const visibleHeight=2*distanceToTarget*Math.tan(THREE.MathUtils.degToRad(persp.fov/2));
   ortho.zoom=THREE.MathUtils.clamp(2*halfHeight()/visibleHeight,.015,150);
   ortho.updateProjectionMatrix();
  }else{
   const visibleHeight=2*halfHeight()/Math.max(ortho.zoom,.015);
   const distance=visibleHeight/(2*Math.tan(THREE.MathUtils.degToRad(persp.fov/2)));
   const direction=position.clone().sub(target).normalize();
   position.copy(target).addScaledVector(direction,distance);
  }
  controls.removeEventListener("change",invalidate);
  controls.removeEventListener("change",cameraDirection);
  controls.dispose();
  camera=next;camera.position.copy(position);
  controls=new OrbitControls(camera,renderer.domElement);
  setupControls();setMeasureNavigation();controls.target.copy(target);controls.update();
 };
 const setPose=(name:StandardView)=>{
  viewName=name;
  const direction:Record<StandardView,[number,number,number]>={
   iso:[1.5,1.25,1.5],front:[0,0,1],back:[0,0,-1],
   left:[-1,0,0],right:[1,0,0],top:[0,1,0],bottom:[0,-1,0],
  };
  const d=direction[name],v=new THREE.Vector3(...d).normalize();
  camera.up.set(0,(name==="top"||name==="bottom")?0:1,name==="top"?-1:name==="bottom"?1:0);
  // Keep the current zoom for changing views; fit remains an explicit action.
  const currentDistance=Math.max(camera.position.distanceTo(controls.target),near*2);
  camera.position.copy(controls.target).addScaledVector(v,currentDistance);
  controls.update();invalidate();
  cameraDirection();
 };
 const fit=()=>{
  controls.enableDamping=false;controls.update();controls.enableDamping=true;
  ortho.zoom=1;ortho.updateProjectionMatrix();
  controls.target.set(0,0,0);
  camera.position.set(0,0,distance);
  setPose(viewName);
 };
 const focusObject=(target:Three.Object3D)=>{
  target.updateWorldMatrix(true,true);
  const selected=new THREE.Box3().setFromObject(target);
  if(selected.isEmpty())return;
  const extent=selected.getSize(new THREE.Vector3());
  const center=selected.getCenter(new THREE.Vector3());
  const previous=controls.target.clone();
  const direction=camera.position.clone().sub(previous).normalize();
  controls.target.copy(center);
  if(camera===ortho){
   const height=Math.max(extent.y,extent.x/Math.max(aspect(),.1),extent.z*.2,diameter*.001);
   ortho.zoom=THREE.MathUtils.clamp(2*halfHeight()/(height*1.3),.015,150);
   ortho.updateProjectionMatrix();
   camera.position.copy(center).addScaledVector(direction,Math.max(distance*.5,near*10));
  }else{
   const span=Math.max(extent.x,extent.y,extent.z,diameter*.001);
   const required=span/(2*Math.tan(THREE.MathUtils.degToRad(persp.fov/2)))*1.5;
   camera.position.copy(center).addScaledVector(direction,Math.max(required,near*10));
  }
  controls.update();invalidate();
 };
 const resetView=()=>{
  switchCamera(drawing?ortho:persp);
  axes.visible=false;
  if(measuring){measuring=false;setMeasureNavigation();}
  clearMeasurement();
  viewName=drawing?"front":"iso";fit();
 };
 // Grid spacing follows zoom (1/2/5 decades) and has a fixed line budget.
 const niceStep=(n:number)=>{
  const b=Math.pow(10,Math.floor(Math.log10(Math.max(n,1e-12)))),r=n/b;
  return (r<=1?1:r<=2?2:r<=5?5:10)*b;
 };
 const updateGrid=()=>{
  if(!gridVisible)return;
  const unitPerPixel=camera===ortho
   ?2*halfHeight()/Math.max(ortho.zoom*holder.clientHeight,1)
   :2*Math.max(camera.position.distanceTo(controls.target),near)*Math.tan(21*Math.PI/180)/Math.max(holder.clientHeight,1);
  const step=niceStep(unitPerPixel*65);
  if(step===stepLast)return;
  stepLast=step;
  for(const item of [...grid.children]){
   grid.remove(item);
   const line=item as Three.GridHelper;
   line.geometry.dispose();
   if(Array.isArray(line.material))line.material.forEach(m=>m.dispose());else line.material.dispose();
  }
  const extent=Math.max(diameter*5,step*28);
  const add=(spacing:number,color:number,opacity:number)=>{
   const divisions=Math.min(100,Math.max(2,Math.ceil(extent/spacing/2)*2));
   const helper=new THREE.GridHelper(spacing*divisions,divisions,color,color);
   const material=helper.material as Three.LineBasicMaterial;
   material.transparent=true;material.opacity=opacity;material.depthWrite=false;
   grid.add(helper);
  };
  add(step,drawing?0xd7e0e8:0xaec1d3,drawing?.5:.62);
  add(step*5,drawing?0xb6c7d8:0x819eb8,drawing?.58:.76);
  invalidate();
 };
 const markers=new THREE.Group();scene.add(markers);
 const raycaster=new THREE.Raycaster(),cursor=new THREE.Vector2();
 const measurePlane=new THREE.Plane(new THREE.Vector3(0,0,1),0);
 const snapMarker=new THREE.Mesh(new THREE.RingGeometry(.65,1,20),
  new THREE.MeshBasicMaterial({color:0x087ca4,depthTest:false,depthWrite:false,side:THREE.DoubleSide}));
 snapMarker.visible=false;snapMarker.renderOrder=21;scene.add(snapMarker);
 let measuring=false,first:Three.Vector3|null=null,press:{x:number;y:number}|null=null;
 const positionOnDrawing=(event:PointerEvent)=>{
  const rect=renderer.domElement.getBoundingClientRect();
  cursor.set((event.clientX-rect.left)/Math.max(rect.width,1)*2-1,-(event.clientY-rect.top)/Math.max(rect.height,1)*2+1);
  raycaster.setFromCamera(cursor,camera);
  const position=raycaster.ray.intersectPlane(measurePlane,new THREE.Vector3());
  if(!position)return null;
  const unitPerPixel=2*halfHeight()/Math.max(ortho.zoom*holder.clientHeight,1);
  const snap=drawingSnap?.find(position.x,position.y,unitPerPixel*12);
  if(snap)position.set(snap.x,snap.y,0);
  return{position,snap,unitPerPixel};
 };
 const setMeasureNavigation=()=>{
  // Measuring must NOT disable camera navigation: left click picks a point,
  // left drag pans, right drag rotates in 3D, and the wheel still zooms.
  controls.mouseButtons.LEFT=measuring?THREE.MOUSE.PAN:(drawing?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE);
  controls.mouseButtons.RIGHT=measuring&&!drawing?THREE.MOUSE.ROTATE:THREE.MOUSE.PAN;
 };
 const clearMeasurement=()=>{
  for(const item of [...markers.children]){
   markers.remove(item);
   const mesh=item as Three.Mesh;
   mesh.geometry?.dispose();
   (mesh.material as Three.Material)?.dispose();
  }
  first=null;onMeasure(null);invalidate();
 };
 const onDown=(event:PointerEvent)=>{if(measuring&&event.button===0)press={x:event.clientX,y:event.clientY};};
 const onMove=(event:PointerEvent)=>{
  if(!drawing||!measuring||!drawingSnap)return;
  const candidate=positionOnDrawing(event);
  snapMarker.visible=Boolean(candidate?.snap);
  if(candidate?.snap){
   snapMarker.position.copy(candidate.position);
   snapMarker.position.z=.00001;
   snapMarker.scale.setScalar(candidate.unitPerPixel*7);
  }
  invalidate();
 };
 const onUp=(event:PointerEvent)=>{
  if(!measuring||!press||event.button!==0)return;
  const start=press;press=null;
  if(Math.hypot(event.clientX-start.x,event.clientY-start.y)>4)return;
  const rect=renderer.domElement.getBoundingClientRect();
  cursor.set((event.clientX-rect.left)/Math.max(rect.width,1)*2-1,-(event.clientY-rect.top)/Math.max(rect.height,1)*2+1);
  raycaster.setFromCamera(cursor,camera);
  const point=drawing?positionOnDrawing(event)?.position:
   raycaster.intersectObject(object,true).find(hit=>(hit.object as Three.Mesh).isMesh)?.point;
  if(!point)return;
  const mark=new THREE.Mesh(new THREE.SphereGeometry(Math.max(radius*.012,.000001),8,8),
   new THREE.MeshBasicMaterial({color:0xd46a18,depthTest:false}));
  mark.position.copy(point);mark.renderOrder=20;
  if(!first)clearMeasurement();
  markers.add(mark);
  if(first){
   const length=first.distanceTo(point);
   const line=new THREE.Line(new THREE.BufferGeometry().setFromPoints([first,point]),
    new THREE.LineBasicMaterial({color:0xd46a18,depthTest:false,depthWrite:false}));
   line.renderOrder=20;markers.add(line);
   first=null;onMeasure(length);
  }else first=point.clone();
  invalidate();
 };
 renderer.domElement.addEventListener("pointerdown",onDown);
 renderer.domElement.addEventListener("pointerup",onUp);
 renderer.domElement.addEventListener("pointermove",onMove);
 const onLeave=()=>{if(snapMarker.visible){snapMarker.visible=false;invalidate();}};
 renderer.domElement.addEventListener("pointerleave",onLeave);
 const draw=()=>{
  raf=0;if(disposed||lost||document.hidden)return;
  const moving=controls.update();
  updateGrid();
  if(dirty||moving)renderer.render(scene,camera);
  dirty=false;
  if(moving)invalidate();
 };
 const resize=()=>{
  if(disposed)return;
  persp.aspect=aspect();persp.updateProjectionMatrix();
  const h=halfHeight();
  ortho.left=-h*aspect();ortho.right=h*aspect();ortho.top=h;ortho.bottom=-h;
  ortho.updateProjectionMatrix();
  renderer.setSize(Math.max(holder.clientWidth,1),Math.max(holder.clientHeight,1));
  stepLast=0;invalidate();
 };
 const observer=new ResizeObserver(resize);observer.observe(holder);
 const visibility=()=>{if(document.hidden){cancelAnimationFrame(raf);raf=0;}else invalidate();};
 document.addEventListener("visibilitychange",visibility);
 const onLost=(event:Event)=>{event.preventDefault();lost=true;cancelAnimationFrame(raf);raf=0;onContextLost();};
 renderer.domElement.addEventListener("webglcontextlost",onLost);
 resetView();updateGrid();invalidate();
 return{
  invalidate,resetView,focusObject,
  exportPng:()=>{
   if(disposed||lost)return null;
   // Render and read in the same task: WebGL's default drawing buffer is
   // cleared between frames. This exports only the currently visible view,
   // not a vector/scale-accurate CAD plot.
   try{
    renderer.render(scene,camera);
    return renderer.domElement.toDataURL("image/png");
   }catch{return null;}
  },
  setStandardView:(name)=>{if(drawing)return;if(name!=="iso")switchCamera(ortho);setPose(name);},
  toggleAxes:()=>{axes.visible=!axes.visible;invalidate();return axes.visible;},
  toggleGrid:()=>{gridVisible=!gridVisible;grid.visible=gridVisible;if(gridVisible)updateGrid();invalidate();return gridVisible;},
  toggleEdges:()=>{outlineVisible=!outlineVisible;outlines.forEach(edge=>{edge.visible=outlineVisible;});invalidate();return outlineVisible;},
  toggleProjection:()=>{if(!drawing)switchCamera(camera===persp?ortho:persp);invalidate();return camera===ortho?"orthographic":"perspective";},
  toggleMeasure:()=>{measuring=!measuring;setMeasureNavigation();if(!measuring){snapMarker.visible=false;clearMeasurement();}return measuring;},
  clearMeasurement,
  dispose:()=>{
   if(disposed)return;disposed=true;cancelAnimationFrame(raf);observer.disconnect();
   document.removeEventListener("visibilitychange",visibility);
   renderer.domElement.removeEventListener("webglcontextlost",onLost);
   renderer.domElement.removeEventListener("pointerdown",onDown);
   renderer.domElement.removeEventListener("pointerup",onUp);
   renderer.domElement.removeEventListener("pointermove",onMove);
   renderer.domElement.removeEventListener("pointerleave",onLeave);
   controls.removeEventListener("change",invalidate);
   controls.removeEventListener("change",cameraDirection);
   controls.dispose();
   clearMeasurement();
   snapMarker.geometry.dispose();
   (snapMarker.material as Three.Material).dispose();
   for(const item of grid.children){
    const helper=item as Three.GridHelper;helper.geometry.dispose();
    if(Array.isArray(helper.material))helper.material.forEach(m=>m.dispose());else helper.material.dispose();
   }
   axes.geometry.dispose();
   const am=axes.material;if(Array.isArray(am))am.forEach(m=>m.dispose());else am.dispose();
   for(const edge of outlines){edge.parent?.remove(edge);edge.geometry.dispose();(edge.material as Three.Material).dispose();}
   // Object3D removal alone does not release source geometry, materials or
   // CanvasTexture glyphs. Shared resources are disposed exactly once.
   const geometries=new Set<Three.BufferGeometry>();
   const materials=new Set<Three.Material>();
   const textures=new Set<Three.Texture>();
   object.traverse(node=>{
    const mesh=node as Three.Mesh;
    if(mesh.geometry?.isBufferGeometry)geometries.add(mesh.geometry);
    const raw=(mesh.material??null) as Three.Material|Three.Material[]|null;
    if(raw)for(const mat of Array.isArray(raw)?raw:[raw])if(mat.isMaterial)materials.add(mat);
   });
   for(const mat of materials){
    for(const value of Object.values(mat as unknown as Record<string,unknown>)){
     if(value&&typeof value==="object"&&"isTexture" in value&&value.isTexture===true)textures.add(value as Three.Texture);
    }
   }
   geometries.forEach(geometry=>geometry.dispose());
   textures.forEach(texture=>texture.dispose());
   materials.forEach(mat=>mat.dispose());
   renderer.dispose();renderer.forceContextLoss();renderer.domElement.remove();
  },
 };
}
