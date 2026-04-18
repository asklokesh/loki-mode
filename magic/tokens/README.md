# Magic Modules Design Tokens

Design tokens are the named constants that describe Loki Mode's visual
language: colors, spacing steps, typography, border radii, shadows, and
motion curves. Generated components read these tokens so every new screen
stays consistent with the rest of the dashboard and web app.

## Files

- `defaults.json` -- baseline tokens shipped with Magic Modules. Reflects the
  live Loki Mode dashboard palette (primary `#553DE9`, success `#1FC5A8`,
  etc.) and the Inter / JetBrains Mono type pairing.
- `.loki/magic/tokens.json` (per project) -- optional override file. Merged
  on top of the defaults at load time, so you only have to list the values
  you want to change.

## Override defaults

Create `.loki/magic/tokens.json` at your project root:

```json
{
  "colors": {
    "primary": "#1E88E5",
    "success": "#2E7D32"
  },
  "radii": {
    "md": "10px"
  }
}
```

The loader deep-merges this file onto `defaults.json`, so any key you omit
falls back to the shipped value.

## Extract from an existing codebase

Run the extractor to learn tokens from what's already in the repo (CSS
custom properties, Tailwind spacing utilities, hex literals, font-family
declarations, box-shadow values, border-radius declarations):

```bash
loki magic tokens extract          # dry run, prints observed tokens
loki magic tokens extract --save   # writes to .loki/magic/tokens.json
```

Programmatic equivalent:

```python
from magic.core.design_tokens import DesignTokens

tokens = DesignTokens(project_dir=".")
observed = tokens.extract_from_codebase(save=True)
```

The extractor scans (relative to the project root):

- `web-app/src/index.css` and any other `web-app/src/**/*.css`
- `dashboard-ui/**/*.css` and `dashboard-ui/loki-unified-styles.js`
- `dashboard/static/**/*.css`
- `.tsx` and `.jsx` files under `web-app/src/` and `dashboard-ui/` for
  Tailwind spacing classes and inline hex colors

## How generated components use tokens

The generator calls `DesignTokens.to_prompt_context()` and injects the
resulting block into the component-generation prompt so the model always
knows the approved palette, spacing scale, and type stack. Example output:

```
DESIGN TOKENS:
Colors: primary=#553DE9, success=#1FC5A8, danger=#C45B5B, ...
Spacing: xs=4px, sm=8px, md=12px, lg=16px, xl=24px
Typography: Inter (body), JetBrains Mono (code)
Radii: sm=4px, md=6px, lg=8px, xl=12px, full=9999px
```

Additional renderers for post-processing generated code:

- `to_tailwind_config()` -- returns a Tailwind `theme.extend` dict you can
  drop into a component-local `tailwind.config.js`.
- `to_css_variables()` -- returns a `:root { --color-primary: ... }` CSS
  block for plain-CSS components.
