# Acme Service (Member Context)

Background worker. Consumes job queue (Redis Streams). Long-running
tasks run here; api enqueues work and polls for results. Use structured
logging via `structlog`.
