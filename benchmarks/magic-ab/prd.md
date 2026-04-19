# Counter App PRD

Build a small, accessible Counter web component.

## Requirements

- A single React component named `Counter` exported from `src/Counter.tsx`.
- Three buttons: decrement (-), reset (0), increment (+).
- A label that announces the current count, with `aria-live="polite"` so
  screen readers announce changes.
- The minus button is disabled when the count is 0 to avoid negative numbers.
- Use design tokens from `.loki/magic/tokens.json` for colors and spacing
  if the file exists; otherwise use sensible defaults.
- A `Counter.css` file containing all styles. No inline styles. No emoji.

## Acceptance

- `Counter.tsx` exports a default React component.
- All three buttons are keyboard-accessible and focusable.
- Default count is 0.
- Decrement button is disabled at count 0.
- Live region announces "Count: N" on every change.
- Component renders without runtime errors when imported.
