import { motion, useReducedMotion } from "motion/react";

// spec 6.1: 2px laser highlight rail for the explorer's selected node. The spring is the whole
// point — on arrow-key or folder switches the bar must launch like a laser pointer and settle on
// the target within milliseconds; the industrial feel lives in that snappy stop, not in the travel.
// Reduced motion collapses the spring to an instant jump so the indicator never animates.
// The rail is vertical only: the app has no top tab strip to hang a horizontal variant on, and an
// unused orientation prop would be dead API surface.
export type SpringActiveRailProps = {
  offset: number;
  visible?: boolean;
};

export function SpringActiveRail({ offset, visible = true }: SpringActiveRailProps) {
  const reduce = useReducedMotion();
  if (!visible) return null;
  return (
    <motion.div
      className="spring-rail"
      aria-hidden="true"
      initial={false}
      animate={{ top: offset }}
      transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 480, damping: 32 }}
    />
  );
}
