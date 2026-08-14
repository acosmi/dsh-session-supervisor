# Contributing

This is a community plugin for DeepSeek Harness. It is not an official
DeepSeek project and there is no upstream PR channel.

## Local development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run coverage   # 100% statements/branches/functions/lines gate
pnpm run build      # tsdown bundle + tsc declarations
```

## Standards

- TypeScript strict, ESM only, named-exports function plugin (no default
  export).
- Every contribution registers through `ctx.effect()` and owns its disposer.
- Deployment-tunable values are validated `Config` fields; protocol caps and
  security invariants stay fixed in the domain layer.
- Fail closed: unknown versions, malformed events, and identity mismatches
  throw; they are never repaired silently.
- Tests describe behavior. Coverage is a hard CI gate at 100%; unreachable
  defensive branches carry a `v8 ignore` with a written reason.

## Before a release

- Re-verify the pinned compatibility matrix (`docs/compatibility.md`).
- Run the profile-install smoke from a fresh tarball.
- Audit `npm pack` contents: no absolute paths, no credentials, no source
  maps, no out-of-scope files.
