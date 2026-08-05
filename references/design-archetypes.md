# DESIGN ARCHETYPES (pick exactly ONE)

Do not average these together and do not invent a fourth palette hue. Choose the
single archetype whose mood matches the product domain, then hold it on every
surface: palette, type pairing, spacing rhythm, and layout skeleton. A build that
commits fully to the "wrong" archetype still looks designed; a build that blends
two looks generated.

Every hex below is a real Radix Colors step. Every font below is real and served
by Google Fonts, so `@import` / `next/font` resolves at build time. Steps map to
roles: 2 = page background, 3 = raised surface, 6 = border, 9 = solid accent,
11 = accent text on light, 12 = body text.

## 1. EDITORIAL (publishing, long-form, research, journalism, docs)
- Palette: bg #f9f9f8, surface #f1f0ef, border #dad9d6, accent #d13415, text #21201c
- Type: Newsreader (display, 600) + Public Sans (body, 400). Headline 3.5rem, leading 1.05, tracking -0.02em.
- Layout: single measured column, 68ch max. Asymmetric: text left, wide margin right for notes and pull quotes. Rules (1px, border color) separate sections, not cards.
- Signature move: an oversized drop-cap or a hanging marginal note. Body text at 1.125rem with 1.7 leading.

## 2. BRUTALIST (developer tools, infra, dashboards, technical products)
- Palette: bg #f0f0f0, surface #f9f9f9, border #202020, accent #e54d2e, text #202020
- Type: Space Grotesk (display, 700) + JetBrains Mono (body/UI, 400). Headline 4rem, leading 0.95, tracking -0.03em.
- Layout: hard 2px black borders, zero border-radius, zero shadows. Visible grid lines. Elements butt directly against each other with no gap.
- Signature move: monospace labels in UPPERCASE with 0.1em tracking. Offset/stacked blocks instead of centered ones.

## 3. LUXURY (hospitality, jewelry, real estate, private services, fine dining)
- Palette: bg #faf9f2, surface #f2f0e7, border #d8d0bf, accent #71624b, text #3b352b
- Type: Playfair Display (display, 400) + Lora (body, 400). Headline 4.5rem, leading 1.1, tracking 0.01em.
- Layout: enormous whitespace, generous 8rem+ section padding. Full-bleed imagery. Content sits low and left, never centered in a card.
- Signature move: letterspaced small-caps eyebrow text above headings. Thin 1px gold rules. No shadows at all.

## 4. RETRO-FUTURE (music, gaming, crypto, creative tools, events)
- Palette: bg #1c2024, surface #21201c, border #43302b, accent #ffc53d, text #f1f0ef
- Type: Syne (display, 800) + Chivo (body, 400). Headline 4rem, leading 1.0, tracking -0.02em.
- Layout: deliberate dark ground (this is the one archetype where dark is the point, not a reflex). Amber accent used sparingly on one element per viewport.
- Signature move: thin amber outline on interactive elements. Slight text glow via text-shadow on the hero only.

## 5. SOFT / PASTEL (wellness, education, kids, community, journaling)
- Palette: bg #f2fbf9, surface #ddf9f2, border #9ce0d0, accent #027864, text #16433c
- Type: Fraunces (display, 600, opsz soft) + DM Sans (body, 400). Headline 3.25rem, leading 1.15.
- Layout: large border-radius (24px+) used consistently, never mixed with sharp corners. Rounded blob or arc shapes in the background.
- Signature move: overlapping soft shapes behind content. Illustrative, generous line-height (1.75) body text.

## 6. INDUSTRIAL (logistics, manufacturing, field ops, B2B operations)
- Palette: bg #f8faf8, surface #eff1ef, border #d7dad7, accent #cc4e00, text #1d211c
- Type: Archivo (display, 700, condensed-leaning) + IBM Plex Sans (body, 400). Headline 3rem, leading 1.05.
- Layout: dense information grid, tight 4px/8px spacing scale. Tables are first-class, not an afterthought. Status uses the orange accent only for exceptions.
- Signature move: numeric data in tabular-nums. Thin dividers over cards. High information density is the aesthetic.

## 7. CLINICAL (health, finance, legal, compliance, insurance)
- Palette: bg #f9f9fb, surface #f0f0f3, border #d9d9e0, accent #208368, text #1c2024
- Type: Source Serif 4 (display, 600) + Work Sans (body, 400). Headline 2.75rem, leading 1.2.
- Layout: calm, restrained, strictly aligned to a 12-column grid. Nothing decorative. Whitespace does all the separation work.
- Signature move: serif headings over sans body signals authority without ornament. One accent hue, used only for confirm/positive state.

## 8. ARTISANAL (food, craft, retail, local business, marketplace)
- Palette: bg #fcf9f6, surface #f6eee7, border #e4cdb7, accent #815e46, text #3e332e
- Type: Instrument Serif (display, 400) + Manrope (body, 400). Headline 4rem, leading 1.05.
- Layout: warm paper ground, photography-forward, imagery bleeds past its container. Text overlaps images slightly.
- Signature move: a hand-drawn-feeling asymmetry. Sections alternate image-left / image-right rather than stacking identical cards.

## SPACING AND SHAPE (Open Props scale; pick one row, hold it)
- Tight: 4 8 12 16 24 32 48 -- pairs with BRUTALIST, INDUSTRIAL, CLINICAL
- Standard: 8 16 24 32 48 64 96 -- pairs with EDITORIAL, ARTISANAL, RETRO-FUTURE
- Generous: 16 32 48 64 96 128 192 -- pairs with LUXURY, SOFT

Radius is an archetype property, not a per-component choice: BRUTALIST 0px,
INDUSTRIAL/CLINICAL 4px, EDITORIAL/LUXURY 2px, ARTISANAL 8px, RETRO-FUTURE 6px,
SOFT 24px. Use that ONE value everywhere.

## LAYOUT SKELETONS (choose one; not all three-card rows)
- Split hero: 55/45 asymmetric, content left, single large visual right, no centering.
- Editorial stack: full-width measured column with alternating margin notes.
- Data-first: compact header, then the real table or list immediately, no marketing block.
- Staggered: sections alternate left/right emphasis with unequal widths (60/40, then 40/60).
- Gallery: one dominant item plus a differently-sized supporting grid, never uniform tiles.

## LICENSE ATTRIBUTION
Palette values are steps from Radix Colors, MIT License, Copyright (c) 2021-2022
Modulz, Copyright (c) 2022-Present WorkOS.
Spacing scale is derived from Open Props, MIT License, Copyright (c) 2021 Adam Argyle.
Theme structure and role naming follow daisyUI, MIT License, Copyright (c) 2020
Pouya Saadeghi.
All named fonts are served by Google Fonts under the SIL Open Font License and
are free to embed and redistribute.
