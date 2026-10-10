import {forwardRef,type ButtonHTMLAttributes,type InputHTMLAttributes,type SelectHTMLAttributes,type TextareaHTMLAttributes} from "react";
import "./controls.css";

// Preserve native DOM semantics and native size/input types. Contextual layout
// owns width; Rare owns semantic intent, density, feedback and focus states.
export type RareDensity="compact"|"standard";
export type RareButtonTone="primary"|"neutral"|"danger"|"ghost";
export type RareButtonProps=ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?:RareButtonTone;
  density?:RareDensity;
  loading?:boolean;
};
export const RareButton=forwardRef<HTMLButtonElement,RareButtonProps>(function RareButton(
  {className="",tone,density,loading=false,disabled,...props},ref){
  // Migration adapter only: new code MUST pass tone explicitly for actions
  // that differ from neutral. Old class names are still rendered as-is.
  const detected=tone??(/\bprimary\b|\bprimary-btn\b/.test(className)?"primary":/\bdanger\b/.test(className)?"danger":/\bghost\b|\bsecondary-action\b|\baction-link\b/.test(className)?"ghost":"neutral");
  return <button {...props} ref={ref} disabled={disabled||loading}
    aria-busy={loading||props["aria-busy"]||undefined}
    data-rare-control="button" data-rare-tone={detected}
    data-rare-intent={tone} data-density={density??"compact"}
    data-rare-loading={loading||undefined}
    className={"rare-button"+(className?" "+className:"")}/>;
});
RareButton.displayName="RareButton";

type FormState={density?:RareDensity;invalid?:boolean};
export type RareInputProps=InputHTMLAttributes<HTMLInputElement>&FormState;
export const RareInput=forwardRef<HTMLInputElement,RareInputProps>(function RareInput(
  {className="",density="compact",invalid,...props},ref){
  return <input {...props} ref={ref}
    aria-invalid={invalid??props["aria-invalid"]}
    data-density={density} data-rare-control="input"
    className={"rare-input"+(className?" "+className:"")}/>;
});
RareInput.displayName="RareInput";

export type RareSelectProps=SelectHTMLAttributes<HTMLSelectElement>&FormState;
export const RareSelect=forwardRef<HTMLSelectElement,RareSelectProps>(function RareSelect(
  {className="",density="compact",invalid,...props},ref){
  return <select {...props} ref={ref}
    aria-invalid={invalid??props["aria-invalid"]}
    data-density={density} data-rare-control="select"
    className={"rare-select"+(className?" "+className:"")}/>;
});
RareSelect.displayName="RareSelect";

export type RareTextareaProps=TextareaHTMLAttributes<HTMLTextAreaElement>&FormState;
export const RareTextarea=forwardRef<HTMLTextAreaElement,RareTextareaProps>(function RareTextarea(
  {className="",density="compact",invalid,...props},ref){
  return <textarea {...props} ref={ref}
    aria-invalid={invalid??props["aria-invalid"]}
    data-density={density} data-rare-control="textarea"
    className={"rare-textarea"+(className?" "+className:"")}/>;
});
RareTextarea.displayName="RareTextarea";
