# AGENTS.md

Guidelines for coding agents working in `WednesdayAI-apps`.

## Conventions

- Commits follow Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`), imperative mood.
- Never add AI co-author trailers or "Generated with" lines to commits or PR bodies.
- The user-facing product name is "WednesdayAI".
- Gateway client ids use the `openclaw-` prefix (for example `openclaw-mentra-node`).
- Any change to `README.md` requires the matching change in `README.zh-CN.md`.
- npm workspaces with hoisted installs (`.npmrc`). Run `npm install` from the repo root.
- Engineering docs live in `dev-docs/` and follow the WednesdayAI-core `dev-docs/STRUCTURE.md` layout and frontmatter (workstreams in `dev-docs/workstreams/<name>/`).
- MentraOS host changes go in the `ExpansionX/MentraOS` fork (one `wai/<slug>` branch per hook, tests included, PR to upstream `dev`), never in this repo. See `dev-docs/workstreams/glasses-platform/`.

## Workspaces

| Path              | Purpose                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------- |
| apps/mentra-glass | MentraOS background miniapp: WednesdayAI assistant on display glasses (bun build, vitest + coverage) |
