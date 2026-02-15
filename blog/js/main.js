// Navigation
document.addEventListener('DOMContentLoaded', () => {
    // Auto-fetch version from GitHub VERSION file
    fetch('https://raw.githubusercontent.com/asklokesh/loki-mode/main/VERSION')
        .then(response => {
            if (!response.ok) throw new Error('Version fetch failed');
            return response.text();
        })
        .then(version => {
            const v = version.trim();
            if (!v) return;
            // Update all version badges (mobile header and sidebar)
            document.querySelectorAll('.version').forEach(el => {
                el.textContent = 'v' + v;
            });
            // Update announcement banner version
            const bannerVersion = document.getElementById('banner-version');
            if (bannerVersion) {
                bannerVersion.textContent = 'NEW in v' + v + ':';
            }
        })
        .catch(() => {
            // Silently fail - keep hardcoded version as fallback
        });

    // Auto-fetch latest release description for announcement banner
    fetch('https://api.github.com/repos/asklokesh/loki-mode/releases/latest')
        .then(response => {
            if (!response.ok) throw new Error('Release fetch failed');
            return response.json();
        })
        .then(release => {
            const bannerText = document.getElementById('banner-text');
            if (bannerText && release.name) {
                // Extract a short summary from release name or first line of body
                const summary = release.name.replace(/^v[\d.]+\s*[-:]\s*/, '');
                if (summary) {
                    bannerText.textContent = summary;
                }
            }
        })
        .catch(() => {
            // Silently fail - keep hardcoded text as fallback
        });

    // Configure marked for secure rendering
    marked.setOptions({
        breaks: true,
        gfm: true,
        headerIds: true,
        mangle: false
    });

    // Mobile hamburger menu - toggle sidebar
    const hamburger = document.getElementById('hamburger');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    const navMenu = document.getElementById('navMenu');

    function closeSidebar() {
        if (hamburger) {
            hamburger.classList.remove('active');
            hamburger.setAttribute('aria-expanded', 'false');
        }
        if (sidebar) sidebar.classList.remove('active');
        if (sidebarOverlay) sidebarOverlay.classList.remove('active');
        document.body.style.overflow = '';
    }

    function openSidebar() {
        if (hamburger) {
            hamburger.classList.add('active');
            hamburger.setAttribute('aria-expanded', 'true');
        }
        if (sidebar) sidebar.classList.add('active');
        if (sidebarOverlay) sidebarOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    function toggleSidebar() {
        if (sidebar.classList.contains('active')) {
            closeSidebar();
        } else {
            openSidebar();
        }
    }

    if (hamburger && sidebar) {
        hamburger.addEventListener('click', toggleSidebar);

        // Keyboard support for hamburger button
        hamburger.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleSidebar();
            }
        });

        // Close sidebar when clicking overlay
        if (sidebarOverlay) {
            sidebarOverlay.addEventListener('click', closeSidebar);
        }

        // Close sidebar when clicking a nav link (mobile)
        if (navMenu) {
            navMenu.querySelectorAll('.nav-link').forEach(link => {
                link.addEventListener('click', () => {
                    if (window.innerWidth <= 768) {
                        closeSidebar();
                    }
                });
            });
        }
    }

    // Navigation handling
    const navLinks = document.querySelectorAll('.nav-link');
    const sections = document.querySelectorAll('.section');

    function navigateToSection(targetId) {
        // Update active nav link
        navLinks.forEach(l => {
            if (l.getAttribute('href') === '#' + targetId) {
                l.classList.add('active');
            } else {
                l.classList.remove('active');
            }
        });

        // Show corresponding section
        sections.forEach(section => {
            if (section.id === targetId) {
                section.classList.add('active');
            } else {
                section.classList.remove('active');
            }
        });
    }

    navLinks.forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            if (href && href.startsWith('#')) {
                e.preventDefault();
                navigateToSection(href.slice(1));
            }
        });
    });

    // Handle section links outside the nav (banner "Learn more", hero buttons, etc.)
    document.querySelectorAll('a[href^="#"]:not(.nav-link)').forEach(link => {
        link.addEventListener('click', (e) => {
            const href = link.getAttribute('href');
            const targetId = href.slice(1);
            const targetSection = document.getElementById(targetId);
            if (targetSection && targetSection.classList.contains('section')) {
                e.preventDefault();
                navigateToSection(targetId);
                window.scrollTo({ top: 0, behavior: 'smooth' });
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
                document.body.style.overflow = 'hidden';
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
                document.body.style.overflow = 'hidden';
            }
        });
    });

    // Close modal
    function closeModal() {
        if (modal) {
            modal.style.display = 'none';
            document.body.style.overflow = '';
        }
    }

    if (closeBtn) {
        closeBtn.addEventListener('click', closeModal);
    }

    window.addEventListener('click', (e) => {
        if (e.target === modal) {
            closeModal();
        }
    });

    // Close modal on escape key, also close sidebar on mobile
    window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (modal && modal.style.display === 'block') {
                closeModal();
            }
            if (sidebar && sidebar.classList.contains('active')) {
                closeSidebar();
            }
        }
    });

    // Load markdown function
    async function loadMarkdown(path, container) {
        try {
            container.innerHTML = '<p style="text-align: center; color: #5B4EEA;">Loading...</p>';
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
