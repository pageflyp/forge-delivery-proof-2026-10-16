# Forge guidance

Forge wrote this file and keeps it current. Read it before you change this repository.

- The standards this release follows, and what enforces each one: `.forge/standards/README.md`.
- Every baseline item in force, with its level and status: `.forge/scaffold/baseline.json`.
- The product's own guidance: `AGENTS.md`. It belongs to the product. Forge does not check or repair it.

## Paths that belong to Forge

Do not edit, move or delete these paths. Forge writes them and restores them on repair.

- `.claude/settings.json`
- `.forge/README.md`
- `.forge/assurance/ci-profile.json`
- `.forge/assurance/release-qualification.json`
- `.forge/checks/cli-boundary/cli-matrix.json`
- `.forge/checks/cli-boundary/cli-runner.mjs`
- `.forge/checks/cosign-signing-config.json`
- `.forge/checks/coverage-floor.ts`
- `.forge/checks/dependency-scan.mjs`
- `.forge/checks/eslint-security.config.js`
- `.forge/checks/gitleaks-report.tmpl`
- `.forge/checks/gitleaks.toml`
- `.forge/checks/osv-scanner.toml`
- `.forge/checks/syft-bill-of-materials.tmpl`
- `.forge/checks/syft.yaml`
- `.forge/ci/run-command.mjs`
- `.forge/hooks/protected-paths.mjs`
- `.forge/scaffold/baseline.json`
- `.forge/standards/README.md`
- `.github/workflows/forge-change.yml`
- `.github/workflows/forge-release.yml`
- `.gitleaksignore`
- `eslint.config.js`
- `tsconfig.json`

## Platform choice

The components this release was created with. Build for these; do not add or swap a backing service.

- `cli`: stack entry `command-line-app` (cli) in `.`.

## Product behaviour

For how the product behaves, the product's own sources win: its requirements, its code and `AGENTS.md`.

## Advisory items

An item with level `advisory` is review guidance: it is never a gate failure and never drift.
