import {Link} from "react-router-dom";
import type {DHFRelatedWork} from "../features/dhf/api";
import {RareNotice} from "../shared/ui/rare";

const stateLabels:Record<string,string>={draft:"待派发",assigned:"待接收",accepted:"已接收",
 in_progress:"进行中",submitted:"已提交交付",accepted_delivery:"交付已验收",
 returned:"退回修订",declined:"拒绝",closed:"已关闭",cancelled:"已取消"};
export function DHFRelatedWorkPanel({items,stageNo,sourceLine,loading,error,truncated}:{
 items:DHFRelatedWork[];stageNo?:number;sourceLine?:number;loading:boolean;error:string;truncated:boolean;
}){
 const visible=items.filter(x=>(!stageNo||x.stageNo===stageNo)&&(!sourceLine||x.sourceLine===sourceLine));
 const verified=visible.filter(x=>x.exactDeliveryMatch).length;
 return <section className="dhf-related" aria-label="DHF关联受控文件工作">
  <div className="dhf-related-top"><strong>{sourceLine?"同文件相关工作":"项目关联受控文件工作"}</strong>
   <small>{visible.length} 项可见 · {verified} 项找到一致冻结交付稿</small></div>
  <p className="dhf-related-scope">仅显示你本人发起、当前仍可查看关联文件的 CDW 工作。关联同一文件不等于该版本已经通过 DHF 独立验收。</p>
  {error&&<RareNotice tone="warning">{error}</RareNotice>}
  {loading&&<p className="dhf-related-loading">正在读取关联工作…</p>}
  {!loading&&visible.length===0&&!error&&<p className="dhf-related-empty">当前范围没有可查看的发起工作。你可以在工作首页发起受控文件工作，再按 DHF 要求独立提交固定版本。</p>}
  <div className="dhf-related-list">{visible.map(w=><div className="dhf-related-row" key={w.sourceLine+":"+w.taskId}>
   <div className="dhf-related-copy"><small>阶段 {w.stageNo} · 原始行 {w.sourceLine}</small>
    <strong title={w.title}>{w.title}</strong>
    <span>{stateLabels[w.state]??"状态待核验"} · 负责人：{w.assigneeName||"待确定"}</span>
    <span className={w.exactDeliveryMatch?"dhf-related-match":"dhf-related-unmatched"}>{w.exactDeliveryMatch?"冻结交付稿 SHA-256 与 DHF 固定版本一致":"仅同文件关联，尚无一致冻结交付稿证据"}</span>
   </div><Link to={"/workbench?view=initiated&initiated="+encodeURIComponent(w.taskId)}>查看工作 →</Link>
  </div>)}</div>
  {truncated&&<p className="dhf-related-limit">关联工作结果达到数量上限，当前不是全部记录；请到 CDW 工作台继续查看。</p>}
 </section>;
}
