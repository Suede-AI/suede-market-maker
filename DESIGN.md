# Suede Market Maker Design System

## Product scene

A founder or market operator is reviewing wallet activity on a secondary screen late at night. They need fast state recognition, visible safety controls, legible logs, and an immediate path to the next operational action.

## Register and signature

- Register: product, retro-technical control desk
- Primary job: operate and inspect the local Solana market maker
- Signature: the six-cell live Suede operations tape beneath the product manifest
- Brand hierarchy: Suede Labs AI first, product second, founder and builder Jason Colapietro always visible

## Tokens

- Base surface: `oklch(0.115 0.016 250)`
- Elevated surface: `oklch(0.155 0.018 250)`
- Overlay surface: `oklch(0.195 0.022 250)`
- Brand blue: `oklch(0.7 0.16 246)`
- Live green: `oklch(0.83 0.17 150)`
- Warning amber: `oklch(0.82 0.14 82)`
- Danger red: `oklch(0.68 0.18 25)`
- Display: Avenir Next Condensed or DIN Condensed
- Body: Avenir Next or Segoe UI
- Utility and data: platform monospace
- Radius: 6px controls, 8-12px major surfaces
- Elevation: borders, not decorative shadows
- Motion: 220-280ms ease-out-expo, opacity and transform only

## Component states

- Primary action: live green fill with dark text
- Destructive action: muted red fill and red border
- Warning action: muted amber fill and amber border
- Focus: two-pixel blue outline with two-pixel offset
- Disabled: reduced contrast without motion
- Running status: green indicator; stopped status: red indicator
- Empty and error states: specific inline next-step copy, never illustration-only placeholders

## Responsive contract

- Desktop: three-part masthead, two-column operation grid, sticky logs
- Tablet: founder credit drops to its own masthead row, single-column operation grid
- Mobile: two-column live tape, horizontal action navigation, stacked form groups, 40px navigation targets
- Reduced motion: all animation and transition durations become zero

## Asset source

The Suede mark is the checksum-approved asset from `JasonColapietro/suede-creator-skills`, pinned to commit `5101ac66214193608b97a2ca314772c7037693de`.
