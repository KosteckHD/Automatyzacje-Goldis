"use client";

import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { useCallback, useEffect, useRef } from "react";

type CountUpProps = {
  to: number;
  from?: number;
  duration?: number;
  className?: string;
};

/** React Bits CountUp adapted to pl-PL, with Motion's reduced-motion preference. */
export default function CountUp({ to, from = 0, duration = 0.65, className = "" }: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reducedMotion = useReducedMotion();
  const motionValue = useMotionValue(from);
  const springValue = useSpring(motionValue, { damping: 20 + 40 / duration, stiffness: 100 / duration });
  const isInView = useInView(ref, { once: true, margin: "0px" });
  const formatValue = useCallback((value: number) => new Intl.NumberFormat("pl-PL", { maximumFractionDigits: 0 }).format(value), []);

  useEffect(() => {
    if (!ref.current) return;
    ref.current.textContent = formatValue(reducedMotion ? to : from);
  }, [from, formatValue, reducedMotion, to]);

  useEffect(() => {
    if (reducedMotion || !isInView) return;
    motionValue.set(to);
  }, [isInView, motionValue, reducedMotion, to]);

  useEffect(() => {
    const unsubscribe = springValue.on("change", (latest) => {
      if (ref.current) ref.current.textContent = formatValue(latest);
    });
    return unsubscribe;
  }, [springValue, formatValue]);

  return <span aria-hidden="true" className={className} ref={ref}>{formatValue(to)}</span>;
}
