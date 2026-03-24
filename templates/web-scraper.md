# PRD: Web Scraper Tool

## Overview
A configurable web scraping tool that extracts structured data from websites, handles pagination, respects robots.txt, and exports results in multiple formats.

## Target Users
- Data analysts collecting web data for research
- Developers building data pipelines from web sources
- Marketers monitoring competitor pricing or content

## Core Features
1. **Configurable Extraction** - Define scraping targets with CSS selectors or XPath expressions in a config file
2. **Pagination Handling** - Automatically follow next-page links or infinite scroll patterns
3. **Rate Limiting** - Configurable request delays and concurrent connection limits to avoid blocking
4. **Robots.txt Compliance** - Parse and respect robots.txt rules, with override flag for allowed domains
5. **Multi-Format Export** - Export scraped data as JSON, CSV, or SQLite database
6. **Retry and Error Handling** - Automatic retry with exponential backoff for failed requests
7. **Proxy Support** - Rotate through proxy list for distributed scraping

## Technical Requirements
- Python 3.10+ with async/await
- httpx for async HTTP requests
- BeautifulSoup4 and lxml for HTML parsing
- SQLite for persistent storage
- YAML configuration files
- CLI interface with argparse
- Structured logging

## Quality Gates
- Unit tests for parser, config loader, and export functions
- Integration tests with mock HTTP server
- Robots.txt parser tested against edge cases
- Rate limiter verified with timing assertions
- Export format validation for JSON, CSV, and SQLite

## Project Structure
```
/
├── src/
│   ├── scraper/
│   │   ├── engine.py          # Main scraping orchestrator
│   │   ├── fetcher.py         # Async HTTP client with retries
│   │   ├── parser.py          # CSS/XPath extraction logic
│   │   └── pagination.py      # Next-page detection and following
│   ├── compliance/
│   │   └── robots.py          # robots.txt parser and enforcer
│   ├── export/
│   │   ├── json_export.py     # JSON file writer
│   │   ├── csv_export.py      # CSV file writer
│   │   └── sqlite_export.py   # SQLite database writer
│   ├── cli.py                 # CLI entrypoint (argparse)
│   └── config.py              # YAML config loader
├── configs/
│   └── example.yaml           # Sample scraping target definition
├── tests/
│   ├── test_parser.py         # Extraction logic tests
│   ├── test_robots.py         # robots.txt compliance tests
│   └── test_export.py         # Export format tests
├── pyproject.toml
└── README.md
```

## Out of Scope
- JavaScript-rendered pages (Puppeteer, Playwright)
- CAPTCHA solving or bypass
- Login-required or session-based scraping
- Distributed scraping across multiple machines
- Web UI for configuring scraping jobs
- Data deduplication across runs
- Cloud storage export (S3, GCS)

## Acceptance Criteria
- YAML config defines target URL, CSS selectors, and field names
- Scraper extracts all matching elements from a page
- Pagination follows next-page links until no more pages remain
- Requests are spaced by the configured delay interval
- robots.txt disallow rules prevent scraping blocked paths
- JSON, CSV, and SQLite exports all contain identical data
- Failed requests retry with exponential backoff up to 3 times

## Success Metrics
- Scraper extracts data matching CSS selector configuration
- Pagination follows links and collects all pages
- Rate limiting maintains configured request interval
- Robots.txt rules correctly block disallowed paths
- All export formats contain valid, complete data
- All tests pass

---

**Purpose:** Tests Loki Mode's ability to build an async Python tool with HTTP clients, HTML parsing, rate limiting, robots.txt compliance, and multi-format data export. Expect ~30-45 minutes for full execution.
