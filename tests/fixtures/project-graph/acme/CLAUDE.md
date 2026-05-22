# Acme App (Parent Context)

Cross-cutting conventions for the Acme logical app. Members:
ui (web front-end), api (REST surface), service (background worker).
All members share the `acme` app_id and the shared memory directory.
Use Pydantic models for API contracts; the UI consumes via fetch().
