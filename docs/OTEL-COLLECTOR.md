# Loki traces in Grafana, Honeycomb and Datadog

Loki exports OTLP/HTTP JSON traces to `LOKI_OTEL_ENDPOINT` (path `/v1/traces`). With `LOKI_OTEL_GENAI=1` the engine10 events map to `gen_ai` spans: `invoke_agent loki` for the run, `stage <name>` per stage, `execute_tool <name>` per tool call. Prompt and completion content never reach a span, and unknown token usage is absent, not 0.

The collector config `config/otel-collector/loki-collector.yaml` fans those spans out to three backends.

## Use it

1. Set the credentials for the vendors you use (the config reads them from the environment, nothing is stored in the file):
   - Grafana Cloud: `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_AUTH` (the full header value, `Basic <base64 instanceId:token>`).
   - Honeycomb: `HONEYCOMB_API_KEY` (ingest key).
   - Datadog: `DD_API_KEY`, `DD_SITE` (for example `datadoghq.com`). Needs a collector build that includes the Datadog exporter (collector-contrib).
2. Start the collector with the file unmodified: `otelcol-contrib --config config/otel-collector/loki-collector.yaml`.
3. Point Loki at it: `LOKI_OTEL_ENDPOINT=http://localhost:4318 LOKI_OTEL_GENAI=1 loki start ...`.

A vendor whose variables are unset must be removed from `service.pipelines.traces.exporters`; that list is the only edit ever needed.

## Receipt link

When tracing was on, the receipt carries a signed `trace_id` (see `docs/AGENT-CHANGE-RECEIPT.md`). Search for that id in the backend to open the run's trace.

## Offline check

`bash tests/test-otel-collector-config.sh` parses the config, asserts the receiver, processor, exporters and traces pipeline, asserts every credential is an `${env:NAME}` placeholder, and maps the deterministic fixture in `tests/fixtures/otel/` (fixed run id and timestamps) to the golden span list. It makes no network call. It does not run a collector or contact a vendor; import into each vendor UI is not tested.
