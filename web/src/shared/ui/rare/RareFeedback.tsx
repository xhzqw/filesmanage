import {type HTMLAttributes,type ReactNode} from "react";
import "./feedback.css";

export type RareFeedbackTone="neutral"|"info"|"success"|"warning"|"danger";

export type RareBadgeProps=Omit<HTMLAttributes<HTMLSpanElement>,"children"> & {
  tone?:RareFeedbackTone;
  dot?:boolean;
  children:ReactNode;
};
/** Inline data/status label: visual tone is never the only status cue. */
export function RareBadge({tone="neutral",dot=false,className="",children,...props}:RareBadgeProps){
  return <span {...props} className={"rare-badge"+(className?" "+className:"")}
    data-rare-badge-tone={tone}>
    {dot&&<span className="rare-badge-dot" aria-hidden="true"/>}
    {children}
  </span>;
}

export type RareNoticeProps=Omit<HTMLAttributes<HTMLParagraphElement>,"children"> & {
  tone?:"info"|"success"|"warning"|"danger";
  children:ReactNode;
};
/** Inline feedback. Errors have alert semantics; updates use polite status. */
export function RareNotice({tone="info",className="",children,role,...props}:RareNoticeProps){
  return <p {...props} className={"rare-notice"+(className?" "+className:"")}
    data-rare-notice-tone={tone} role={role??(tone==="danger"?"alert":"status")}>
    {children}
  </p>;
}
