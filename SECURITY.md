# Security

## Scope

This file covers the plugin's own attack surface. The DeepSeek Harness host,
its sandboxing, and its LLM providers are out of scope (report their issues
upstream).

## v1 attack-surface decisions

- **No shell, no subprocesses.** The plugin never constructs or executes
  commands; no `child_process` usage exists in the codebase.
- **No network.** No outbound HTTP, no webhooks, no listeners, no ports.
- **No filesystem reads beyond its own store.** The only files touched are
  `$DSH_HOME/plugins/session-supervisor/<sessionId>.json` and its atomic
  temp files.
- **No credential or environment reads** other than `DSH_HOME` (path
  resolution only).
- **No user-supplied code evaluation.** Policies are a closed union decoded
  by a strict, fail-closed parser (unknown keys, versions, and out-of-range
  values are rejected).
- **No side-effect replay.** Delivery never retries tool calls; a follow-up
  is a model-visible message with a bounded budget, and a dead-letter is
  terminal.

## Data handling

- Labels and evidence are bounded (`maxLabelBytes`, `maxEvidenceBytes`).
  Truncation is explicit (`…[truncated]`).
- Evidence frames everything as untrusted data, never instructions.
- Stored state is event-sourced JSON with strict decode on every read;
  corruption, unknown versions, and identity mismatches fail closed and are
  never repaired silently.

## Threat model

See [docs/threat-model.md](docs/threat-model.md) for the full model, including
prompt-injection and cross-session isolation analysis.

## Reporting

Report vulnerabilities privately to the maintainers listed in the repository.
This project is pre-release community software; there is no paid security
program.
