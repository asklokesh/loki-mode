# Loki 10 eval tasks

Format: id | kind | repo @ ref | issue | why chosen | red/green evidence

Counts: augmentiq 1, public 12, quickstart 14 (total 27)

Notes:
- Quickstart repo.source is the git bundle at the main-checkout path /Users/lokesh/git/lokimode-anthropic/eval/loki10/fixtures/empty-repo/empty-repo.bundle (rebuild and provenance: fixtures/empty-repo/make-bundle.sh). GREEN.txt for quickstart is a positive control against a throwaway reference implementation, not committed.
- augmentiq has only 3 issues (#50 closed, #52, #54). #54 ("add documentation") has no behavioral acceptance criterion and was dropped; #50 is closed and needs Ollama cloud plus live web search at test time, so it was dropped. The augmentiq shortfall is filled with extra quickstart tasks.
- Dropped public candidates: pypa/packaging#577 (fix PR #1351; verified red/green but the hidden test matches an exact error message the issue never states), pallets/click#1272 (PR #3578; asserts doubled-bracket output the issue never mentions), pallets/click#2819 (PR #3678; asserts private name _click_default_help), pallets/itsdangerous#375 (PR #378; imports private _lazy_sha1).
- Public GREEN.txt is the same hidden.run at the fix PR's merge commit; RED.txt is at repo.ref = merge^1.

- aiq-52-searchbar | augmentiq | /Users/lokesh/git/augmentiq @ b9796de68d30 | asklokesh/augmentiq#52 | founder's own product issue; head already fixed so ref is the pre-fix parent (see ref_note); behavioral vitest from issue text | hidden/RED.txt + hidden/GREEN.txt
- pub-click-2877 | public | pallets/click @ fe3ad76e5807 | pallets/click#2877 | merged fix PR pallets/click#3642 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-click-3059 | public | pallets/click @ 8240d25bdbb8 | pallets/click#3059 | merged fix PR pallets/click#3507 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-click-3487 | public | pallets/click @ d42f15b71757 | pallets/click#3487 | merged fix PR pallets/click#3493 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-click-3572 | public | pallets/click @ 6ec99f89261b | pallets/click#3572 | merged fix PR pallets/click#3653 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-humanize-152 | public | python-humanize/humanize @ b172d67eac6a | python-humanize/humanize#152 | merged fix PR python-humanize/humanize#297 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-humanize-174 | public | python-humanize/humanize @ 6ab21b6fb2ce | python-humanize/humanize#174 | merged fix PR python-humanize/humanize#272 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-humanize-205 | public | python-humanize/humanize @ 7574e0cc377d | python-humanize/humanize#205 | merged fix PR python-humanize/humanize#329 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-humanize-333 | public | python-humanize/humanize @ 08cf2c3026cf | python-humanize/humanize#333 | merged fix PR python-humanize/humanize#334 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-jsonschema-1389 | public | python-jsonschema/jsonschema @ 11455212a0ee | python-jsonschema/jsonschema#1389 | merged fix PR python-jsonschema/jsonschema#1390 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-markupsafe-417 | public | pallets/markupsafe @ 73e6a4886564 | pallets/markupsafe#417 | merged fix PR pallets/markupsafe#418 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-packaging-1315 | public | pypa/packaging @ c4fb81ff6eba | pypa/packaging#1315 | merged fix PR pypa/packaging#1316 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- pub-packaging-1318 | public | pypa/packaging @ 9a11fba3d532 | pypa/packaging#1318 | merged fix PR pypa/packaging#1319 added/changed tests; small fast suite | hidden/RED.txt + hidden/GREEN.txt
- qs-api-only | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/api-only.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-blog-platform | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/blog-platform.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-cli-tool | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/cli-tool.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-dashboard | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/dashboard.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-data-pipeline | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/data-pipeline.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-e-commerce | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/e-commerce.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-game | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/game.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-microservice | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/microservice.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-npm-library | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/npm-library.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-rest-api | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/rest-api.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-rest-api-auth | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/rest-api-auth.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-simple-todo-app | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/simple-todo-app.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-static-landing-page | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/static-landing-page.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
- qs-web-scraper | quickstart | fixtures/empty-repo/empty-repo.bundle @ a49d132f67fd | none | quickstart brief from templates/web-scraper.md; interface pinned in the prompt; stdlib behavioral test | hidden/RED.txt + hidden/GREEN.txt
