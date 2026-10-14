import {forwardRef,type ButtonHTMLAttributes,type InputHTMLAttributes,type TextareaHTMLAttributes} from "react";
import {BrandLoader} from "../BrandLoader";
import "./controls.css";
export {RareSelect} from "./RareSelect";

// Preserve native DOM semantics and native size/input types. Contextual layout
// owns width; Rare owns semantic intent, density, feedback and focus states.
export type RareDensity="compact"|"standard";
export type RareButtonTone="primary"|"neutral"|"danger"|"ghost";
export type RareButtonProps=ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?:RareButtonTone;
  emphasis?:"solid"|"soft";
  density?:RareDensity;
  loading?:boolean;
};
export const RareButton=forwardRef<HTMLButtonElement,RareButtonProps>(function RareButton(
  {className="",tone,emphasis,density,loading:loadingProp,disabled,...props},ref){
  const loading=Boolean(loadingProp);
  // Migration adapter only: new code MUST pass tone explicitly for actions
  // that differ from neutral. Old class names are still rendered as-is.
  const detected=tone??(/\bprimary\b|\bprimary-btn\b/.test(className)?"primary":/\bdanger\b/.test(className)?"danger":/\bghost\b|\bsecondary-action\b|\baction-link\b/.test(className)?"ghost":"neutral");
  return <button {...props} ref={ref} disabled={disabled||loading}
    aria-label={loading?(props["aria-label"]??(typeof props.children==="string"?props.children+"，加载中":"加载中")):props["aria-label"]}
    aria-busy={loading||props["aria-busy"]||undefined}
    data-rare-control="button" data-rare-tone={detected}
    data-rare-intent={tone} data-rare-emphasis={emphasis} data-density={density??"compact"}
    data-rare-loading={loading||undefined} data-rare-loadable={loadingProp!==undefined||undefined}
    className={"rare-button"+(className?" "+className:"")}>
    {loadingProp!==undefined?<><span className="rare-button-content" aria-hidden={loading||undefined}
      data-rare-hidden={loading||undefined}>{props.children}</span>
      {loading&&<span className="rare-button-pending" aria-hidden="true"><BrandLoader size="xs" decorative/></span>}</>:props.children}
   </button>;
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

export type RareTextareaProps=TextareaHTMLAttributes<HTMLTextAreaElement>&FormState;
export const RareTextarea=forwardRef<HTMLTextAreaElement,RareTextareaProps>(function RareTextarea(
  {className="",density="compact",invalid,...props},ref){
  return <textarea {...props} ref={ref}
    aria-invalid={invalid??props["aria-invalid"]}
    data-density={density} data-rare-control="textarea"
    className={"rare-textarea"+(className?" "+className:"")}/>;
});
RareTextarea.displayName="RareTextarea";
