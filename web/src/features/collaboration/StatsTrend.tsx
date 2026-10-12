import {useId} from "react";
import {formatBytes} from "./api";

type Month={month:string;count:number;bytes:number};
type Metric="count"|"bytes";

export function StatsTrend({series,metric}:{series:Month[];metric:Metric}){
 const gradientId=useId().replace(/:/g,"");
 const width=420,height=152,top=18,bottom=126,left=12,right=408;
 const max=Math.max(1,...series.map(item=>item[metric]));
 const points=series.map((item,index)=>{
  const x=series.length===1?width/2:left+(right-left)*index/(series.length-1);
  const y=bottom-(bottom-top)*item[metric]/max;
  return {x,y,item};
 });
 const curve=points.map((point,index)=>(index?"L":"M")+point.x.toFixed(2)+" "+point.y.toFixed(2)).join(" ");
 const area=points.length>0?"M"+points[0].x+" "+bottom+" "+curve.slice(1)+" L"+points[points.length-1].x+" "+bottom+" Z":"";
 return <div className="stats-trend-chart">
  <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img" aria-label={metric==="bytes"?"月度新增容量走势":"月度新增文件数量走势"}>
   <defs><linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stopColor="var(--brand-blue)" stopOpacity=".20"/>
    <stop offset="100%" stopColor="var(--brand-blue)" stopOpacity="0"/>
   </linearGradient></defs>
   <path d={`M${left} ${bottom}H${right}`} fill="none" stroke="var(--border-hairline)" strokeWidth="1"/>
   {points.length>1&&<path d={area} fill={`url(#${gradientId})`}/>}
   <path d={curve} fill="none" stroke="var(--brand-blue)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
   {points.map(({x,y,item},index)=><g key={item.month}>
    <circle cx={x} cy={y} r={3.3} fill="var(--surface-panel)" stroke="var(--brand-blue)" strokeWidth="2" vectorEffect="non-scaling-stroke">
     <title>{item.month+" · "+(metric==="bytes"?formatBytes(item.bytes):item.count.toLocaleString("zh-CN")+" 个")}</title>
    </circle>
    {(series.length<=6||index===0||index===series.length-1||index%2===0)&&<text x={x} y="146" textAnchor="middle" fontSize="10" fill="var(--text-tertiary)">{item.month.slice(5)}</text>}
   </g>)}
  </svg>
  <span className="stats-trend-value">{metric==="bytes"?formatBytes(series.reduce((total,item)=>total+item.bytes,0)):series.reduce((total,item)=>total+item.count,0).toLocaleString("zh-CN")+" 个"} <small>图示期间累计</small></span>
 </div>;
}
