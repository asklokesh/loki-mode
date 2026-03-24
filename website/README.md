# Loki Mode -- Product Website

Product website for [Loki Mode](https://github.com/asklokesh/loki-mode) by [Autonomi](https://www.autonomi.dev/).

## View Locally

Open the file directly in your browser:

```bash
open website/index.html
```

Or serve it with any static file server:

```bash
# Python
cd website && python3 -m http.server 8080

# Node
npx serve website

# Then visit http://localhost:8080
```

## Structure

Single-page site with no build step and no framework dependencies.

- `index.html` -- Complete page (HTML + CSS + JS in one file)
- Google Fonts (Inter, JetBrains Mono) loaded from CDN
- All icons are inline SVG (no icon library required)

## Sections

1. Hero with animated code background
2. How It Works (3-step flow)
3. Features (8-card grid)
4. Comparison table (vs bolt.new, Replit, Lovable)
5. Testimonials
6. Pricing (Free, Pro, Enterprise)
7. Open Source stats and install command
8. Footer with links and social icons

## Design

- Dark theme with purple (#553DE9) accent
- Responsive (mobile hamburger menu, stacked layouts)
- CSS-only animations (scroll reveal, hover effects, floating code)
- No emojis -- all icons are SVG
