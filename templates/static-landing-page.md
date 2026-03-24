# PRD: Static Landing Page

## Overview
A simple static landing page for a fictional SaaS product. Tests Loki Mode's frontend and marketing agent capabilities.

## Target Users
Marketing teams needing a quick landing page.

## Page Sections

### Hero Section
- Headline: "Supercharge Your Workflow"
- Subheadline: "The all-in-one tool for modern teams"
- Primary CTA: "Get Started Free"
- Secondary CTA: "Watch Demo"
- Hero image placeholder

### Features Section (3 features)
1. **Fast Setup** - "Get started in minutes, not days"
2. **Team Collaboration** - "Work together seamlessly"
3. **Analytics** - "Track what matters"

### Social Proof
- 3 testimonial cards with placeholder content
- "Trusted by 10,000+ teams"

### Pricing Section
- Free tier: $0/month
- Pro tier: $29/month
- Enterprise: Contact us

### FAQ Section
- 4 common questions with answers

### Footer
- Links: About, Blog, Careers, Contact
- Social icons: Twitter, LinkedIn, GitHub
- Copyright notice

## Tech Stack
- HTML5
- CSS3 (no framework, or Tailwind CSS)
- Minimal JavaScript (for FAQ accordion)
- No build step required

## Requirements
- Responsive design (mobile + desktop)
- Semantic HTML
- Accessible (WCAG 2.1 AA basics)
- Fast load time (< 2s)
- No external dependencies (except fonts)

## Assets
- Use placeholder images (placeholder.com or similar)
- Use system fonts or Google Fonts
- Use text labels or Lucide icons (no emojis)

## Out of Scope
- Backend/API
- Form submission handling
- Analytics tracking
- A/B testing
- Deployment

## Deliverables
1. `index.html` - Main page
2. `styles.css` - Stylesheet
3. `script.js` - Minimal JS (optional)
4. `README.md` - How to view locally

## Success Criteria
- Page loads without errors (no broken images, missing styles, or JS errors)
- All 6 sections render correctly (hero, features, social proof, pricing, FAQ, footer)
- FAQ accordion opens and closes on click
- Responsive layout works on mobile (375px) and desktop (1440px)
- Semantic HTML passes basic accessibility checks
- Page loads in under 2 seconds on a fresh browser

---

**Purpose:** Tests frontend agent, marketing agent (copy), and design patterns without backend complexity. Expect ~10-15 minutes for full execution.
