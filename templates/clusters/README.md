# Cluster Templates

Pre-built workflow topologies for common development patterns.

## Usage

    loki cluster list                    # List available templates
    loki cluster validate <template>     # Validate topology
    loki cluster run <template> [args]   # Execute workflow

## Template Format

Each template is a JSON file defining agents, their pub/sub topics,
and the workflow topology.

## Available Templates

- security-review: Multi-agent security audit pipeline
- performance-audit: Performance analysis with profiling
- refactoring: Structured refactoring with test preservation
- code-review: Multi-reviewer code review process
