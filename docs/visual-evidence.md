# Visual evidence

On by default (`LOKI_VISUAL_EVIDENCE=0` disables). For changed page files, Loki screenshots each route with the repo's Playwright CLI.

Playwright e2e media: when `@playwright/test` is installed in the repo, Loki also runs a short walkthrough of the same routes with `video` and `trace` on. The `.webm` video and trace `.zip` are sha256-hashed into the receipt (`evidence_screens`), rechecked by `loki verify`, and listed as `video:` and `trace:` lines in the PR body Evidence section. Nothing is downloaded. When Playwright is absent the run records "playwright e2e video and trace skipped: ..." under NOT PROVEN and continues.
