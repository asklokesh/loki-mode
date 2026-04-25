"""
Live integration tests for Loki Managed Memory (v7.1.0).

These tests exercise the REAL Anthropic Managed Agents Memory beta API.
They are OPT-IN ONLY and do NOT run in default CI.

Activation requires BOTH environment variables:

    LOKI_LIVE_TESTS=1
    ANTHROPIC_API_KEY=<your-key>

When either variable is missing, every test in this package is reported
as SKIPPED with a clear reason. This guarantees that running
``pytest tests/`` in any normal environment makes ZERO API calls and
incurs ZERO billing.

Tests in this package use ``memory.managed_memory.client.ManagedClient``
as the only entry point to the SDK. Direct ``anthropic`` imports are
forbidden in this package; the wrapper enforces the beta header and
timeouts.

To run live:

    LOKI_LIVE_TESTS=1 ANTHROPIC_API_KEY=sk-ant-... \\
        python3 -m pytest tests/live/ -v

See ``tests/live/README.md`` for full documentation.
"""
