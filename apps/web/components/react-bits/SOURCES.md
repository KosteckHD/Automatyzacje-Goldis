# React Bits components

- Project: [DavidHDev/react-bits](https://github.com/DavidHDev/react-bits)
- Variant: TypeScript + CSS (TS-CSS)
- Upstream revision reviewed: `3a1c7f2f9f94ed833934ab5c2635760b9e644583` (2026-09-11)
- License: MIT for the free React Bits components. See [React Bits](https://reactbits.dev/get-started/installation) and the linked upstream repository.
- Runtime dependency: `motion` (used through `motion/react` by CountUp and the controlled run stepper).

| Component | Upstream source | Local use and changes |
| --- | --- | --- |
| SpotlightCard | [TS source](https://github.com/DavidHDev/react-bits/blob/3a1c7f2f9f94ed833934ab5c2635760b9e644583/src/ts-default/Components/SpotlightCard/SpotlightCard.tsx) | Tracks mouse pointer only; namespaced CSS; warm Goldis light; static on touch and reduced motion. |
| CountUp | [TS source](https://github.com/DavidHDev/react-bits/blob/3a1c7f2f9f94ed833934ab5c2635760b9e644583/src/ts-default/TextAnimations/CountUp/CountUp.tsx) | Adapted to `pl-PL`, short duration, reduced-motion preference, static server-rendered value, and an `aria-hidden` animated copy. |
| Stepper | [TS source](https://github.com/DavidHDev/react-bits/blob/3a1c7f2f9f94ed833934ab5c2635760b9e644583/src/ts-default/Components/Stepper/Stepper.tsx) | Rebuilt as `RunStepper`: the current step comes from the selected import/run state, uses semantic ordered-list markup and cannot be clicked to change backend state. Motion is decorative only. |

Only the components used by the product are included. No React Bits registry code, unrelated assets, or optional GSAP animation is bundled.
