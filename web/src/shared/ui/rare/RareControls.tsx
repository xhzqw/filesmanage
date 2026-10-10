import {forwardRef,type ButtonHTMLAttributes,type InputHTMLAttributes,type SelectHTMLAttributes,type TextareaHTMLAttributes} from "react";
import "./controls.css";

// Native elements are retained deliberately: browser forms, name/value submission,
// file inputs, keyboard activation and data-grid focus stay fully interoperable.
// Rare is the common industrial interaction layer, never a replacement DOM widget.
export type RareButtonProps=ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?:"primary"|"neutral"|"danger"|"ghost";
  density?:"compact"|"standard";
};
export const RareButton=forwardRef<HTMLButtonElement,RareButtonProps>(function RareButton(
  {className="",tone,density,...props},ref){
  const detected=tone??(/\bprimary\b|\bprimary-btn\b/.test(className)?"primary":/\bdanger\b/.test(className)?"danger":/\bghost\b|\bsecondary-action\b|\baction-link\b/.test(className)?"ghost":"neutral");
  return <button {...props} ref={ref} data-rare-control="button" data-rare-tone={detected}
    data-rare-intent={tone} data-density={density??"compact"}
    className={"rare-button"+(className?" "+className:"")}/>;
});
RareButton.displayName="RareButton";

export const RareInput=forwardRef<HTMLInputElement,InputHTMLAttributes<HTMLInputElement>>(function RareInput(
  {className="",...props},ref){
  return <input {...props} ref={ref} data-rare-control="input" className={"rare-input"+(className?" "+className:"")}/>;
});
RareInput.displayName="RareInput";

export const RareSelect=forwardRef<HTMLSelectElement,SelectHTMLAttributes<HTMLSelectElement>>(function RareSelect(
  {className="",...props},ref){
  return <select {...props} ref={ref} data-rare-control="select" className={"rare-select"+(className?" "+className:"")}/>;
});
RareSelect.displayName="RareSelect";

export const RareTextarea=forwardRef<HTMLTextAreaElement,TextareaHTMLAttributes<HTMLTextAreaElement>>(function RareTextarea(
  {className="",...props},ref){
  return <textarea {...props} ref={ref} data-rare-control="textarea" className={"rare-textarea"+(className?" "+className:"")}/>;
});
RareTextarea.displayName="RareTextarea";
