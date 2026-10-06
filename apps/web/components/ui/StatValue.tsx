"use client";

import CountUp from "../react-bits/CountUp";

type StatValueProps = { value: number | string };

/** Keeps a locale-correct, readable SSR value while the decorative copy counts up. */
export function StatValue({ value }: StatValueProps) {
  const label = typeof value === "number" ? new Intl.NumberFormat("pl-PL").format(value) : value;
  if (typeof value !== "number" || !Number.isFinite(value)) return <>{label}</>;

  return <span className="rb-goldis-count"><span className="sr-only">{label}</span><CountUp to={value} duration={0.65} className="rb-goldis-count-live" /></span>;
}
