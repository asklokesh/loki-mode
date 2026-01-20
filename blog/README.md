# Loki Mode Website

Static website for Loki Mode documentation, research references, and blog posts.

## Structure

```
blog/
├── index.html          # Main site homepage
├── css/
│   └── style.css       # Styling
├── js/
│   └── main.js         # Navigation and markdown rendering
├── posts/              # Blog posts (markdown)
│   ├── v3.3.0-cursor-learnings.md
│   ├── anti-sycophancy.md
│   └── velocity-quality-balance.md
├── images/             # Site images
└── .nojekyll           # Disable Jekyll processing
```

## Features

- **Dynamic Markdown Rendering:** Uses marked.js to render markdown files from the repository
- **Always Current:** References actual files from `references/` and `docs/` directories
- **Client-Side:** No build process required
- **Research-Backed:** Direct links to academic papers and industry sources

## Sections

### 1. Home
- Quick overview and features
- Installation instructions
- Key differentiators

### 2. Architecture
- Core workflow (RARV cycle)
- 37 agent types
- Memory systems
- Quality control
- Tool orchestration
- Scale patterns

### 3. Research
- OpenAI patterns
- Lab research (DeepMind, Anthropic)
- Production patterns
- Advanced patterns
- Acknowledgements

### 4. Comparisons
- Loki Mode vs Cursor
- Multi-agent systems comparison
- Competitive analysis

### 5. Blog
- Technical deep dives
- Research explanations
- Case studies
- Release notes

## GitHub Pages Setup

### Recommended: Deploy from Root

**IMPORTANT:** The site must be deployed from the repository root (not /blog) so that blog/index.html can access ../references/, ../skills/, etc. using relative paths.

1. Go to repository Settings
2. Navigate to Pages
3. Under "Build and deployment":
   - Source: Deploy from a branch
   - Branch: main
   - Folder: **/ (root)**
4. Save

Site will be available at: `https://asklokesh.github.io/loki-mode/blog/`

### Alternative: Root Redirect (Optional)

To make `https://asklokesh.github.io/loki-mode/` redirect to the blog:

1. Create `index.html` in repository root:
```html
<!DOCTYPE html>
<html>
<head>
    <meta http-equiv="refresh" content="0; url=blog/">
    <title>Redirecting...</title>
</head>
<body>
    <p>Redirecting to <a href="blog/">Loki Mode</a>...</p>
</body>
</html>
```

2. Keep GitHub Pages configured to deploy from root

### Custom Domain (Optional)

1. Add a `CNAME` file to repository root with your domain
2. Configure DNS records
3. Enable in GitHub Pages settings

## Local Development

**IMPORTANT:** Run the server from the repository root (not blog/) so that relative paths work correctly.

```bash
# Serve from repository root
cd /path/to/loki-mode  # NOT cd blog/

# Python
python3 -m http.server 8000

# Node.js
npx http-server -p 8000

# PHP
php -S localhost:8000

# Open browser to blog
open http://localhost:8000/blog/
```

## Adding Content

### New Blog Post

1. Create markdown file in `posts/`
2. Add front matter (title, date, tags)
3. Update `index.html` to add blog card

Example:

```html
<article class="blog-card" data-post="posts/new-post.md">
    <div class="blog-meta">January 20, 2026</div>
    <h3>Post Title</h3>
    <p>Brief description...</p>
    <div class="blog-tags">
        <span class="tag">Tag1</span>
        <span class="tag">Tag2</span>
    </div>
</article>
```

### New Documentation Reference

1. Add markdown file to `references/` directory
2. Update `index.html` to add doc card

Example:

```html
<div class="doc-card" data-doc="../references/new-doc.md">
    <h3>Document Title</h3>
    <p>Brief description...</p>
</div>
```

## Technologies

- **Marked.js** - Markdown parsing
- **DOMPurify** - XSS protection
- **Vanilla JavaScript** - No framework dependencies
- **CSS Grid & Flexbox** - Responsive layout

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+

## Performance

- **Initial load:** < 100KB (HTML + CSS + JS)
- **Markdown files:** Loaded on-demand
- **No build step:** Pure static files

## Customization

### Theme Colors

Edit `css/style.css`:

```css
:root {
    --primary-color: #6366f1;
    --secondary-color: #8b5cf6;
    --dark-bg: #0f172a;
    --card-bg: #1e293b;
    /* ... */
}
```

### Navigation

Edit `index.html` to add/remove nav links and sections.

### Content Layout

Modify grid layouts in `css/style.css`:

```css
.features {
    grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
}
```

## Security

- **DOMPurify:** Sanitizes all rendered markdown
- **CSP Ready:** Add Content Security Policy headers
- **No inline scripts:** All JS in external files

## License

MIT License - Same as Loki Mode core

## Contributing

1. Test changes locally
2. Ensure all markdown paths are correct
3. Verify responsive layout
4. Submit PR

## Support

- GitHub Issues: https://github.com/asklokesh/loki-mode/issues
- Documentation: See `references/` directory
