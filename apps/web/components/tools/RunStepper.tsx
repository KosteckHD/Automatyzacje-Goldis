"use client";

import { motion, useReducedMotion } from "motion/react";

const steps = [
  { title: "Import Excela", detail: "Sprawdzenie REGON i nazwy" },
  { title: "Everest i Compensa", detail: "Sprawdzenie w portalach" },
  { title: "Polisy OC", detail: "Zapisany wynik i eksport" },
];

/** Controlled adaptation of React Bits Stepper: state is supplied by the API-backed workspace. */
export function RunStepper({ currentStep }: { currentStep: 1 | 2 | 3 }) {
  const reduceMotion = useReducedMotion();
  const transition = reduceMotion ? { duration: 0 } : { duration: 0.28 };

  return <ol className="rb-goldis-stepper" aria-label="Etapy pracy">
    {steps.map((step, index) => {
      const stepNumber = index + 1;
      const complete = stepNumber < currentStep;
      const current = stepNumber === currentStep;
      return <li key={step.title} className="rb-goldis-step" data-state={complete ? "complete" : current ? "active" : "upcoming"} aria-current={current ? "step" : undefined}>
        <motion.span
          className="rb-goldis-step-marker"
          aria-hidden="true"
          initial={false}
          animate={{ scale: current ? 1.04 : 1 }}
          transition={transition}
        >{complete ? "✓" : `0${stepNumber}`}</motion.span>
        <strong>{step.title}</strong>
        <small>{step.detail}{complete ? " · zakończono" : current ? " · bieżący etap" : ""}</small>
      </li>;
    })}
  </ol>;
}
