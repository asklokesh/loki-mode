# Loki traces in Grafana, Honeycomb and Datadog

Loki exports OTLP/HTTP JSON traces to `LOKI_OTEL_ENDPOINT` (path `/v1/traces`). With `LOKI_OTEL_GENAI=1` the engine10 events map to `gen_ai` spans: `invoke_agent loki` for the run, `stage <name>` per stage, `execute_tool <name>` per tool call. Prompt and completion content never reach a span, and unknown token usage is absent, not 0.

The collector config `config/otel-collector/loki-collector.yaml` fans those spans out to three backends.

## Use it

1. Set the credentials for the vendors you use (the config reads them from the environment, nothing is stored in the file):
   - Grafana Cloud: `GRAFANA_OTLP_ENDPOINT`, `GRAFANA_OTLP_AUTH` (the full header value, `Basic <base64 instanceId:token>`).
   - Honeycomb: `HONEYCOMB_API_KEY` (ingest key).
   - Datadog: `DD_API_KEY`, `DD_SITE` (for example `datadoghq.com`). Needs a collector build that includes the Datadog exporter (collector-contrib).
2. Start the collector: `otelcol-contrib --config config/otel-collector/loki-collector.yaml`.
3. Point Loki at it: `LOKI_OTEL_ENDPOINT=http://localhost:4318 LOKI_OTEL_GENAI=1 loki start ...`.

To use a subset of vendors, edit only `service.pipelines.traces.exporters` and list the vendors you use. The collector validates every defined exporter even when it is not listed, so the required fields of the other vendors carry inert defaults (`https://unset.invalid` for the Grafana endpoint, `unset` for the Datadog key, `datadoghq.com` for the Datadog site). Those defaults are never used by a vendor that is not in the list, and are not credentials. A listed vendor with its variables unset sends to the inert default and fails at export time, so set the variables for every vendor you list.

## Receipt link

When tracing was on, the receipt carries a signed `trace_id` (see `docs/AGENT-CHANGE-RECEIPT.md`). Search for that id in the backend to open the run's trace.

## Offline check

`bash tests/test-otel-collector-config.sh` parses the config, asserts the receiver, processor, exporters and traces pipeline, asserts every credential is an `${env:NAME}` placeholder (an optional `:-default` is allowed and must not be key-shaped), asserts that every required field still resolves to a non-empty default when a vendor's variables are unset, and maps the deterministic fixture in `tests/fixtures/otel/` (fixed run id and timestamps) to the golden span list. It makes no network call. When `otelcol-contrib` is on PATH it also runs `otelcol-contrib validate` with only `HONEYCOMB_API_KEY` set; that step is skipped, not passed, when the binary is absent. It does not contact a vendor; import into each vendor UI is not tested.
