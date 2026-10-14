import { useEffect, useRef, useState, type ComponentProps } from "react";
import { useReducedMotion } from "motion/react";
import { cn } from "./utils";
import "./rare.css";

export type AnimatedCounterProps = Omit<ComponentProps<"span">, "children"> & {
  value: number;
  duration?: number; // duration in seconds, default 0.8
  formatter?: (val: number) => string;
};

export function AnimatedCounter({
  value,
  duration = 0.8,
  formatter,
  className,
  ...props
}: AnimatedCounterProps) {
  const reducedMotion = useReducedMotion();
  const [displayValue, setDisplayValue] = useState(value);
  const prevValueRef = useRef(value);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reducedMotion) {
      setDisplayValue(value);
      prevValueRef.current = value;
      return;
    }

    const startVal = prevValueRef.current;
    const endVal = value;
    if (startVal === endVal) return;

    const startTime = performance.now();
    const durationMs = duration * 1000;

    function tick(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / durationMs, 1);
      // Ease out cubic: 1 - Math.pow(1 - progress, 3)
      const ease = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(startVal + (endVal - startVal) * ease);
      setDisplayValue(current);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        prevValueRef.current = endVal;
        setDisplayValue(endVal);
      }
    }

    rafRef.current = requestAnimationFrame(tick);

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [value, duration, reducedMotion]);

  const text = formatter ? formatter(displayValue) : displayValue.toLocaleString();

  return (
    <span
      className={cn("rare-counter", className)}
      aria-live="polite"
      {...props}
    >
      {text}
    </span>
  );
}
