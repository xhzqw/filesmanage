/* Adapted from the interaction contract of Rare UI Notification bell.
 * Source and attribution: https://www.rareui.com/components/notificationbell
 * Upstream license: MIT with Commons Clause and attribution; retain credit.
 * The business-system adapter uses native buttons and theme tokens rather
 * than a Radix Slot/Tailwind dependency. It never animates under reduced motion.
 */
import {useEffect,useRef,type ButtonHTMLAttributes} from "react";
import {AnimatePresence,animate,motion,useMotionValue,useReducedMotion,type AnimationPlaybackControls} from "motion/react";
import "./notificationBell.css";

export type NotificationBellProps=Omit<ButtonHTMLAttributes<HTMLButtonElement>,"children"> & {
  count:number;
  max?:number;
  variant?:"count"|"dot";
};

export function NotificationBell({count,max=99,variant="count",className="",...props}:NotificationBellProps){
  const total=Number.isFinite(count)?Math.max(0,Math.floor(count)):0;
  const limit=Number.isFinite(max)?Math.max(1,Math.floor(max)):99;
  const reduced=useReducedMotion();
  const previous=useRef(total);
  const rotation=useMotionValue(0);
  const ringing=useRef<AnimationPlaybackControls|null>(null);
  useEffect(()=>{
    const delta=total-previous.current;
    previous.current=total;
    if(delta<=0||reduced)return;
    ringing.current?.stop();
    const strength=Math.min(1.45,0.85+delta*.1);
    ringing.current=animate(rotation,[0,-14*strength,11*strength,-6*strength,3*strength,0],{duration:.66,ease:"easeOut"});
    return()=>ringing.current?.stop();
  },[total,reduced,rotation]);
  return <button {...props} type="button" className={"rare-notification-bell"+(className?" "+className:"")}
    data-slot="notification-bell" data-unread={total>0} aria-label={props["aria-label"]??`消息通知，未读 ${total} 条`}>
    <motion.svg aria-hidden="true" style={{rotate:rotation,transformOrigin:"50% 14%"}}
      viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9ZM10 21h4"/>
    </motion.svg>
    <AnimatePresence initial={false}>
      {total>0&&<motion.span key="badge" className="rare-notification-bell-badge" aria-hidden="true"
        initial={reduced?false:{scale:.5,opacity:0}} animate={{scale:1,opacity:1}}
        exit={reduced?{opacity:0}:{scale:.5,opacity:0}}
        transition={reduced?{duration:0}:{type:"spring",stiffness:500,damping:28}}>
        {variant==="dot"?null:<motion.span key={total>limit?`plus-${limit}`:total} className="rare-notification-bell-number"
          initial={reduced?false:{y:5,opacity:0}} animate={{y:0,opacity:1}}
          transition={reduced?{duration:0}:{duration:.18}}>{total>limit?`${limit}+`:total}</motion.span>}
      </motion.span>}
    </AnimatePresence>
  </button>;
}
