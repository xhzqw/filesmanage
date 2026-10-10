import {RareButton} from "./RareControls";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";

// spec 6.3: 26x64px hard-edged hold-to-confirm for destructive commits (recycle bin purge, sensitive
// drawing removal, version rollback), replacing the "click twice" confirm. The gesture is
// deliberately user-paced — the fill is driven by the pointer-down duration, not by decorative
// motion — so releasing at any moment cancels outright. A disabled button cannot start.
export type MicroHoldToDeleteProps = {
  label?: string;
  tone?: "danger" | "brand";
  duration?: number;
  disabled?: boolean;
  onConfirm: () => void;
  title?: string;
};

export function MicroHoldToDelete({
  label = "删除",
  tone = "danger",
  duration = 800,
  disabled = false,
  onConfirm,
  title,
}: MicroHoldToDeleteProps) {
  const [progress, setProgress] = useState(0);
  const [armed, setArmed] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const rafRef = useRef<number | null>(null);
  const startedAtRef = useRef(0);
  const holdingRef = useRef(false);
  const hadPhysicalPressRef = useRef(false);
  const physicalResetTimerRef = useRef<number | null>(null);
  // Assistive-tech virtual clicks cannot express a hold. Require two distinct
  // activations at least duration apart, never a one-click destructive commit.
  const [confirmStage, setConfirmStage] = useState(false);
  const firstClickAtRef = useRef(0);
  const confirmResetTimerRef = useRef<number | null>(null);

  function cancel() {
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    holdingRef.current = false;
    btnRef.current?.setAttribute("data-armed", "false");
    setArmed(false);
    setProgress(0);
    if (physicalResetTimerRef.current !== null) {
      window.clearTimeout(physicalResetTimerRef.current);
    }
    physicalResetTimerRef.current = window.setTimeout(() => {
      hadPhysicalPressRef.current = false;
      physicalResetTimerRef.current = null;
    }, 120);
  }

  function start() {
    if (disabled || holdingRef.current) return;
    if (physicalResetTimerRef.current !== null) {
      window.clearTimeout(physicalResetTimerRef.current);
      physicalResetTimerRef.current = null;
    }
    hadPhysicalPressRef.current = true;
    holdingRef.current = true;
    startedAtRef.current = performance.now();
    btnRef.current?.setAttribute("data-armed", "true");
    setArmed(true);
    function tick(now: number) {
      const p = Math.min(Math.max((now - startedAtRef.current) / duration, 0), 1);
      setProgress(p);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      // filled: commit once, then reset — the parent closes its own dialog
      setConfirmStage(false);
      if (confirmResetTimerRef.current !== null) window.clearTimeout(confirmResetTimerRef.current);
      rafRef.current = null;
      holdingRef.current = false;
      setArmed(false);
      setProgress(0);
      onConfirm();
    }
    rafRef.current = requestAnimationFrame(tick);
  }

  function onKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (e.key !== "Enter" && e.key !== " ") return;
    // auto-repeat would restart the ramp mid-hold; one physical press = one hold
    if (holdingRef.current) return;
    e.preventDefault();
    start();
  }

  function handleClick() {
    if (disabled || holdingRef.current || hadPhysicalPressRef.current) return;
    const now = performance.now();
    if (!confirmStage || now - firstClickAtRef.current > 5000) {
      firstClickAtRef.current = now;
      setConfirmStage(true);
      if (confirmResetTimerRef.current !== null) window.clearTimeout(confirmResetTimerRef.current);
      confirmResetTimerRef.current = window.setTimeout(() => setConfirmStage(false), 5000);
      return;
    }
    // Neither a synthetic click nor an assistive-tech activation can bypass
    // the deliberate confirmation interval. Rapid double-clicks are ignored.
    if (now - firstClickAtRef.current < duration) return;
    if (confirmResetTimerRef.current !== null) window.clearTimeout(confirmResetTimerRef.current);
    setConfirmStage(false);
    onConfirm();
  }

  // unmount mid-hold must not leave a loop running against a dead button
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (physicalResetTimerRef.current !== null) window.clearTimeout(physicalResetTimerRef.current);
      if (confirmResetTimerRef.current !== null) window.clearTimeout(confirmResetTimerRef.current);
    };
  }, []);

  const countdown = ((duration - progress * duration) / 1000).toFixed(1);

  return (
    <RareButton
      ref={btnRef}
      type="button"
      className="micro-hold"
      data-tone={tone}
      data-armed={armed ? "true" : "false"}
      /* --hold drives the label colour-mix in theme.css, so the countdown only
         turns white across the part of the button the fill already covers. */
      style={{ ["--hold"]: progress } as CSSProperties}
      disabled={disabled}
      title={title ?? ("长按 " + duration + "ms 确认")}
      aria-label={confirmStage ? "再次激活以确认"+label : label+"：按住"+duration+"毫秒确认，辅助技术可分两次激活"}
      aria-description={confirmStage ? "请再次激活确认；两次操作至少间隔"+duration+"毫秒" : undefined}
      onPointerDown={start}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onBlur={cancel}
      onKeyDown={onKeyDown}
      onKeyUp={cancel}
      onClick={handleClick}
    >
      <span className="micro-hold-fill" style={{ width: progress + "%" }} aria-hidden="true" />
      <span className="micro-hold-label" aria-live="polite">{armed ? countdown : confirmStage ? "再次确认" : label}</span>
    </RareButton>
  );
}
