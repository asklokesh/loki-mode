# Loki Mode

**Multi-agent autonomous development system for Claude Code, OpenAI Codex CLI, and Google Gemini CLI**

Transform your PRD into a fully deployed, production-ready product with zero human intervention.

## Quick Start

```bash
# Pull the latest image
docker pull asklokesh/loki-mode

# Run with your project mounted
docker run -it -v $(pwd):/workspace asklokesh/loki-mode

# Start autonomous mode with a PRD
docker run -it -v $(pwd):/workspace asklokesh/loki-mode loki start prd.md
```

## Features

- **Autonomous Development**: Complete SDLC from PRD to deployment
- **Multi-Provider Support**: Claude Code, OpenAI Codex CLI, Google Gemini CLI
- **Quality Gates**: 7-gate verification system with automated testing
- **Context Management**: Persistent memory across sessions
- **Dashboard API**: Real-time monitoring at localhost:57374

## Usage

```bash
# Interactive mode
docker run -it -v $(pwd):/workspace asklokesh/loki-mode bash

# Background autonomous mode
docker run -d -v $(pwd):/workspace asklokesh/loki-mode loki start --bg prd.md

# Check status
docker run -it -v $(pwd):/workspace asklokesh/loki-mode loki status

# With dashboard server access
docker run -it -p 57374:57374 -v $(pwd):/workspace asklokesh/loki-mode loki start --api prd.md
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `LOKI_PROVIDER` | AI provider (claude/codex/gemini) | claude |
| `LOKI_MAX_ITERATIONS` | Max iteration cycles | 50 |
| `LOKI_MAX_RETRIES` | Max retry attempts | 10 |

## Requirements

For full functionality, mount your API credentials:

```bash
docker run -it \
  -v $(pwd):/workspace \
  -v ~/.claude:/root/.claude:ro \
  asklokesh/loki-mode
```

## Documentation

- [GitHub Repository](https://github.com/asklokesh/loki-mode)
- [Installation Guide](https://github.com/asklokesh/loki-mode#installation)
- [Usage Guide](https://github.com/asklokesh/loki-mode#usage)

## License

MIT License - See [LICENSE](https://github.com/asklokesh/loki-mode/blob/main/LICENSE)

## Tags

- `latest` - Latest stable release
- `5.x.x` - Specific version tags

## Support

- [GitHub Issues](https://github.com/asklokesh/loki-mode/issues)
- [Documentation](https://asklokesh.github.io/loki-mode)
