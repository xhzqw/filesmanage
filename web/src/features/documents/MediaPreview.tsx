import {RareButton} from "../../shared/ui/rare";
import {useState} from "react";
import {fileApi} from "./api";
import "./mediaPreview.css";

type Kind="image"|"video"|"audio";

// Browsers issue their own Range requests against this authenticated URL.
// Never fetch large files into JS blobs or data URLs: doing so defeats
// seeking/backpressure and multiplies memory usage for large MP4 files.
export function MediaPreview({fileId,sha256,name,kind,mime}:{fileId:string;sha256:string;name:string;kind:Kind;mime:string}){
 const [error,setError]=useState(false);
 const [zoom,setZoom]=useState(1);
 const [naturalSize,setNaturalSize]=useState<{width:number;height:number}|null>(null);
 const [fit,setFit]=useState(true);
 const src=fileApi.mediaUrl(fileId,sha256);
 const failed=<div role="alert" className="media-failure">
  <strong>无法在浏览器中显示此文件</strong>
  <p>{kind==="video"?"文件可能使用了浏览器不支持的视频或音频编码（例如部分 HEVC 视频），也可能没有权限读取媒体流。":"文件可能已损坏、格式不受浏览器支持，或预览权限已发生变化。"}</p>
  <a href={"/api/files/"+encodeURIComponent(fileId)+"/bytes"} download={name}>尝试下载原文件</a>
 </div>;

 if(kind==="image"){
  return <section className="media-preview" aria-label="图片预览">
   <div className="media-tools preview-reader-dock" role="group" aria-label="图片查看工具">
    {naturalSize&&<span className="media-tools-dimensions">{naturalSize.width} × {naturalSize.height}</span>}
    <RareButton type="button" disabled={error} aria-pressed={fit} onClick={()=>{setFit(true);setZoom(1);}}>适应窗口</RareButton>
    <RareButton type="button" disabled={error} aria-pressed={!fit&&zoom===1} onClick={()=>{setFit(false);setZoom(1);}}>原始尺寸</RareButton>
    <RareButton type="button" disabled={error} aria-label="缩小" onClick={()=>{setFit(false);setZoom(value=>Math.max(0.25,Math.round((value-0.25)*100)/100));}}>−</RareButton>
    <span aria-live="polite">{fit?"自适应":Math.round(zoom*100)+"%"}</span>
    <RareButton type="button" disabled={error} aria-label="放大" onClick={()=>{setFit(false);setZoom(value=>Math.min(4,Math.round((value+0.25)*100)/100));}}>＋</RareButton>
   </div>
   {error?failed:<div className="media-image-stage">
    <img src={src} alt={name} onError={()=>setError(true)}
     onLoad={event=>setNaturalSize({width:event.currentTarget.naturalWidth,height:event.currentTarget.naturalHeight})}
     className={fit?"media-image-fit":"media-image-actual"}
     style={fit?undefined:{width:naturalSize?naturalSize.width*zoom:undefined}}
    />
   </div>}
  </section>;
 }
 if(kind==="video"){
  return <section className="media-preview" aria-label="视频预览">
   {error?failed:<div className="media-video-stage"><video src={src} controls playsInline preload="metadata" onError={()=>setError(true)} aria-label={name}/></div>}
  </section>;
 }
 return <section className="media-preview" aria-label="音频预览">
  {error?failed:<div className="media-audio-stage"><audio src={src} controls preload="metadata" onError={()=>setError(true)} aria-label={name}/></div>}
 </section>;
}
