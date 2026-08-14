# Changelog

All notable changes to this project are documented here. The project follows
a `0.x` developer-preview cadence until a stable 1.0; breaking changes to the
DeepSeek Harness platform are tracked in `docs/compatibility.md`.

## Unreleased (0.1.0-beta.0)

- Pure domain core: strict ledger decoder, Guard/Policy/Incident state
  machine, three supervision policies (lifecycle silence, absolute deadline,
  abnormal-turn streak), hysteresis, replay determinism.
- Plugin-owned durable store under `$DSH_HOME` (atomic writes, fail-closed
  corruption taxonomy); v1 never writes session-log events.
- Four tools (`guardian_create/list/update/check_now`) with canonical JSON
  views and stable error codes.
- Per-root-Agent runtime: single-shot timers, absolute next-evaluation
  scheduling, single-flight evaluation, activity tracking with
  hold/release/restore deltas.
- Bounded incident delivery: one follow-up per incident, configured retries,
  dead-letter terminal, at-least-once semantics with a stable IncidentId.
