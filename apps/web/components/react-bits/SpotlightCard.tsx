"use client";

import React, { useRef, type PropsWithChildren } from "react";

type SpotlightCardProps = PropsWithChildren<{
  className?: string;
  spotlightColor?: `rgba(${number}, ${number}, ${number}, ${number})`;
}>;

/** Adapted from React Bits TS-CSS SpotlightCard; touch input keeps its static card. */
export default function SpotlightCard({
  children,
  className = "",
  spotlightColor = "rgba(217, 182, 95, 0.12)",
}: SpotlightCardProps) {
  const cardRef = useRef<HTMLDivElement>(null);

  const trackPointer: React.PointerEventHandler<HTMLDivElement> = (event) => {
    if (event.pointerType !== "mouse" || !cardRef.current) return;
    const rect = cardRef.current.getBoundingClientRect();
    cardRef.current.style.setProperty("--mouse-x", `${event.clientX - rect.left}px`);
    cardRef.current.style.setProperty("--mouse-y", `${event.clientY - rect.top}px`);
    cardRef.current.style.setProperty("--spotlight-color", spotlightColor);
  };

  return <div ref={cardRef} onPointerMove={trackPointer} className={`rb-goldis-card-spotlight ${className}`}>{children}</div>;
}
