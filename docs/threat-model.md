# Threat model

Scope: the `dsh-session-supervisor` plugin running inside a DeepSeek Harness
profile. Trusted: the harness host process, its session log, and the plugin's
own store directory. Untrusted: model outputs, user-supplied Guard fields
(labels, policy parameters), and any session content.

## Assets

1. The plugin store (`$DSH_HOME/plugins/session-supervisor/`) — incident and
   delivery state.
2. The owner session's inbox — one follow-up per incident.
3. The session log — integrity of the user's durable history (the plugin
   writes nothing to it, so uninstall is always safe).

## Threats and mitigations

| Threat | Impact | Mitigation |
|---|---|---|
| Model or user injects instructions into `label`/evidence | Model follows attacker text as commands | Labels are JSON fields, never spliced into system prompts; incident evidence is framed as untrusted data with fixed text around it |
| Model floods guards to exhaust store/timers | DoS | `maxGuardsPerSession`, `maxPoliciesPerGuard`, bounded evidence, single timer per agent, single-flight drive |
| Prompt injection tricks the plugin into "helpful" action (shell, cancel) | Side effects | The plugin has no shell/network/cancel code paths at all; closed tool surface |
| Cross-session access (child agent reads parent guards) | Isolation break | Tools bind to `exec.agent` and its session id; owner mismatch fails closed; children are never attached (root detection via `parentSession`) |
| Fork inherits parent guard state | Stale supervision | Store is keyed by `SessionId`; forks get new ids; fork seeds contain no plugin events (v1 writes none) |
| Corrupted store artifact | Wrong state or silent repair | Strict decode on every read; `corrupt`/`unsupported` fail closed; atomic replace prevents torn files |
| Crash between follow-up and receipt persist | Duplicate notification | Documented at-least-once; stable incident id for dedup; retries bounded, dead-letter terminal |
| Clock manipulation | Spurious or missed incidents | Absolute anchors only; backward jumps cannot clear a breach; forward jumps coalesce into one current incident |
| Session log pollution | User sessions become unresumable | v1 writes no session events (the harness currently lacks an ignorable-writer seam; see the plan ADR) |

## Residual risks (documented, accepted in v1)

- A compromised harness host can read or tamper with the store — the plugin
  assumes host integrity, like every other in-process plugin.
- The owner agent may act on incident evidence in unsafe ways; the framing
  only reduces, never eliminates, that risk.
- Supervision availability is bounded by the host process lifetime.
