// Navigation
document.addEventListener('DOMContentLoaded', () => {
    // Configure marked for secure rendering
    marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: true,
        mangle: false
    });

    // Navigation handling
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.section');

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            if (href && href.startsWith('#')) {
                e.preventDefault();

                // Update active nav link
                navLinks.forEach(l => l.classList.remove('active'));
                link.classList.add('active');

                // Show corresponding section
                const targetId = href.slice(1);
                sections.forEach(section => {
                    if (section.id === targetId) {
                        section.classList.add('active');
                    } else {
                        section.classList.remove('active');
                    }
                });
            }
        });
    });

    // Doc cards - load markdown when clicked
    const docCards = document.querySelectorAll('.doc-card');
    const modal = document.getElementById('docModal');
    const modalContent = document.getElementById('docContent');
    const closeBtn = document.querySelector('.close');

    docCards.forEach(card => {
        card.addEventListener('click', async () => {
            const docPath = card.getAttribute('data-doc');
            if (docPath) {
                await loadMarkdown(docPath, modalContent);
                modal.style.display = 'block';
            }
        });
    });

    // Blog cards - load markdown when clicked
    const blogCards = document.querySelectorAll('.blog-card');
    blogCards.forEach(card => {
        card.addEventListener('click', async () => {
            const postPath = card.getAttribute('data-post');
            if (postPath) {
                await loadMarkdown(postPath, modalContent);
                modal.style.display = 'block';
            }
        });
    });

    // Close modal
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });

    // Load markdown function
    async function loadMarkdown(path, container) {
        try {
            container.innerHTML = '<p style="text-align: center; color: #8b5cf6;">Loading...</p>';

            const response = await fetch(path);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const markdown = await response.text();
            const html = marked.parse(markdown);
            const cleanHtml = DOMPurify.sanitize(html);

            container.innerHTML = cleanHtml;

            // Smooth scroll to top of modal content
            container.scrollIntoView({ behavior: 'smooth', block: 'start' });
        } catch (error) {
            container.innerHTML = `
                <div style="text-align: center; padding: 2rem;">
                    <h2 style="color: #f59e0b;">Failed to load document</h2>
                    <p style="color: #cbd5e1;">${error.message}</p>
                    <p style="color: #64748b; margin-top: 1rem;">Path: ${path}</p>
                </div>
            `;
        }
    }

    // Handle hash changes (for direct links)
    function handleHash() {
        const hash = window.location.hash || '#home';
        const targetId = hash.slice(1);

        navLinks.forEach(link => {
            if (link.getAttribute('href') === hash) {
                link.classList.add('active');
            } else {
                link.classList.remove('active');
            }
        });

        sections.forEach(section => {
            if (section.id === targetId) {
                section.classList.add('active');
            } else {
                section.classList.remove('active');
            }
        });
    }

    window.addEventListener('hashchange', handleHash);
    handleHash();

    // Smooth scrolling for anchor links within content
    document.addEventListener('click', (e) => {
        if (e.target.tagName === 'A' && e.target.getAttribute('href')?.startsWith('#')) {
            const targetId = e.target.getAttribute('href').slice(1);
            const targetElement = document.getElementById(targetId);
            if (targetElement) {
                e.preventDefault();
                targetElement.scrollIntoView({ behavior: 'smooth' });
            }
        }
    });
});
