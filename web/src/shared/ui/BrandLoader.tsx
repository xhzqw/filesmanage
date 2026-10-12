import "./brand-loader.css";
import {brandLoaderPaths} from "./brandLoaderPaths";

/** Reuses the approved transparent brand favicon as the precise silhouette.
 *  The highlights orbit *inside* the official mark rather than redrawing it.
 *  No canvas/JS animation loop, network library or extra animation dependency.
 */
export type BrandLoaderSize="xs"|"sm"|"md"|"lg";
export function BrandLoader({size="md",label="正在加载",decorative=false,className=""}:{
 size?:BrandLoaderSize;label?:string;decorative?:boolean;className?:string;
}){
 return <span
  className={"brand-loader"+(className?" "+className:"")}
  data-loader-size={size} data-loader-decoration={decorative||undefined}
  role={decorative?undefined:"status"} aria-label={decorative?undefined:label}
  aria-hidden={decorative?true:undefined}>
  <img className="brand-loader-ink" src="/assets/brand/favicon-48.png" alt="" draggable={false}/>
  <span className="brand-loader-mask" aria-hidden="true">
   <span className="brand-loader-glow"/>
   <span className="brand-loader-spark"/>
  </span>
  <svg className="brand-loader-paths" viewBox="0 0 48 48" aria-hidden="true">
   {brandLoaderPaths.map((path,index)=><g key={index}>
    <path className="brand-loader-track" d={path}/>
    <path className="brand-loader-trail" d={path} pathLength={100}
     style={{animationDelay:`-${index*.7}s`}}/>
   </g>)}
  </svg>
 </span>;
}
