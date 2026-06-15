# Change Log

All notable changes to the "loki-mode" extension will be documented in this file.

## [7.45.1] - 2026-06-15

### Changed
- Marked the extension DEPRECATED. The Loki Mode product is now the CLI
  (`npm install -g loki-mode`) with a built-in web dashboard
  (`loki dashboard start`). This listing is kept as a pointer only and will
  not receive feature updates.
- Corrected the listing content: removed Google Gemini (provider deprecated and
  runtime removed), fixed the license to Business Source License 1.1 (was
  incorrectly labeled MIT), and corrected the install and Docker instructions.

## [0.1.0] - 2026-01-31

### Added
- Initial release
- Session management: start, stop, pause, resume autonomous development sessions
- Multi-provider support: Claude Code, OpenAI Codex, Google Gemini
- Real-time task tracking with live progress updates
- Activity bar panel with sessions and tasks views
- Status bar integration showing current phase and progress
- Human guidance injection during execution
- Configurable API endpoint and polling interval
- Keyboard shortcut (Cmd+Shift+L / Ctrl+Shift+L) for quick access
