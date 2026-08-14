# dsh-session-supervisor

A durable, bounded lifecycle supervisor for live [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) sessions.

> **Developer preview — community plugin.** DeepSeek Harness is pre-release
> and may break compatibility. This is **not** an official DeepSeek product:
> no DeepSeek endorsement, review, or store listing exists. Compatibility is
> pinned per release in [docs/compatibility.md](docs/compatibility.md); never
> install from `latest`.

## What it does

You declare an explicit supervision contract over one root Agent session:

- `lifecycle_silence` — no qualifying durable lifecycle event for N seconds;
- `deadline_unclosed` — an absolute RFC 3339 deadline passed and the guard is
  still open;
- `abnormal_turn_streak` — K consecutive `turn/end` results ended in
  `error` / `blocked` / `max-tokens` / `interrupted`.

When a policy first crosses its threshold and stays crossed for a
confirmation window, the plugin forms one durable **incident**, records
bounded evidence, and (if configured) queues **at most one** follow-up into
the owner session. `completed` turns and fresh activity are recovery
evidence; acknowledgements and resolutions are explicit and auditable.

The plugin **observes and notifies only**. It never runs shell commands,
network requests, retries your tools, or cancels your agent. "Time passed" is
not an authorization.

## Hard limits (read before installing)

- **Host lifetime:** timers only run while the harness process is alive. The
  plugin cannot supervise a cold session and does not wake your machine.
- **Cold sessions:** silence time is re-anchored on resume; an already-lapsed
  deadline coalesces into one incident on resume.
- **At-least-once delivery:** a crash between queueing a follow-up and
  persisting its receipt can duplicate one notification. Every notification
  carries the same stable incident id so the model and UI can deduplicate.
- **A hung agent cannot be rescued by this plugin:** if the owner agent never
  finishes, follow-ups queue but are not consumed. The plugin will not cancel
  the agent (a future cancel feature would be a separate, opt-in safety RFC).
- **Session log integrity:** v1 writes nothing into the session log. The
  plugin's state lives under `$DSH_HOME/plugins/session-supervisor/`. It can
  be uninstalled at any time without affecting session resume.
- **Single host, single process:** no multi-host coordination or leader
  election.

## Install

Prebuilt tarball (recommended — no install-time scripts):

```bash
dsh plugin --profile <name> add <path-to-tarball.tgz>
# verify:
dsh --profile <name> --dump-config
```

Or from npm once published:

```bash
dsh plugin --profile <name> add @<publisher>/dsh-session-supervisor@0.1.0-beta.1
```

The bundle contributes the `dsh-session-supervisor` row. Later profile layers
replace its whole `config` (no deep merge) — copy the full example below.

## Configuration

```yaml
# in your profile's cordis.patch.yml (full object, not a merge):
- id: dsh-session-supervisor
  config:
    enabled: true
    minSilenceSeconds: 60
    maxGuardsPerSession: 16
    maxPoliciesPerGuard: 8
    maxLabelBytes: 240
    confirmationSeconds: 60
    recoveryConfirmationSeconds: 30
    deliveryRetryDelaysMs: [1000, 5000, 15000]
    maxDeliveryAttempts: 3
    maxEvidenceItems: 20
    maxEvidenceBytes: 4096
    logLevel: warn
```

## Tools

| Tool | Purpose |
|---|---|
| `guardian_create` | Create a guard over the current root session |
| `guardian_list` | List guards, control state, and policy phases (bounded) |
| `guardian_update` | `edit` / `pause` / `resume` / `acknowledge` / `close` |
| `guardian_check_now` | One evaluation pass; records only real state transitions |

Tools refuse to run outside a root agent session (`OWNER_MISSING`), never
leak stack traces or paths, and return stable error codes
(`BAD_REQUEST`, `GUARD_NOT_FOUND`, `TOO_MANY_GUARDS`, `STORE_UNAVAILABLE`, …).

## Privacy and safety

- No shell, HTTP, webhooks, or port listeners.
- No file or environment reads beyond the plugin's own store.
- Evidence is bounded, UTF-8 truncated with an explicit marker, and framed as
  untrusted data — never instructions.
- See [SECURITY.md](SECURITY.md) and [docs/threat-model.md](docs/threat-model.md).

## License

[MIT](LICENSE)
