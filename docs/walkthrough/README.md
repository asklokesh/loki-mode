# Loki Mode Walkthroughs

Interactive HTML walkthroughs demonstrating Loki Mode's capabilities. Each file is self-contained -- no external dependencies, no build step. Open in any browser.

## Walkthrough Files

| File | Description | Size |
|------|-------------|------|
| `index.html` | **Build Your First App** -- Step-by-step tutorial walking through a complete Loki Mode build from PRD to deployment | 43 KB |
| `architecture.html` | **System Architecture** -- Interactive SVG diagram showing the full Loki Mode architecture: RARV cycle, providers, memory, quality gates | 34 KB |
| `comparison.html` | **Feature Comparison** -- Side-by-side comparison of Loki Mode vs alternative AI build tools with interactive feature matrix | 26 KB |
| `gallery.html` | **Project Gallery** -- Showcase of 24 example projects built with Loki Mode across SaaS, CLI, mobile, and enterprise categories | 37 KB |
| `video-placeholder.html` | **Build Process Animation** -- CSS-animated walkthrough of the build process with terminal replay and phase transitions | 25 KB |

## Hub Page

Open `hub.html` for a landing page that links to the walkthroughs with descriptions and categories.

## How to View

```bash
# Open directly in browser
open docs/walkthrough/hub.html

# Or serve locally
cd docs/walkthrough && python3 -m http.server 8080
# Then visit http://localhost:8080/hub.html
```

## Design Conventions

All walkthroughs share a consistent design language:

- **Dark theme** with purple accent (#553DE9)
- **Inter** font for UI text, **JetBrains Mono** for code
- **Responsive** layouts that work on mobile, tablet, and desktop
- **Self-contained** HTML with embedded CSS and JavaScript
- **No external dependencies** beyond Google Fonts (optional, degrades gracefully)

## Related Content

- **Demo Apps**: See `examples/` for 6 functional app demos built by Loki Mode
- **Product Website**: See `website/index.html` for the full product landing page
- **Master Index**: See `docs/DEMOS.md` for a complete listing of all interactive content
