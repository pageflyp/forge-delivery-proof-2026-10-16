# Enforced standards

Forge wrote this file from its record of this release. Each standard is one layer of the baseline, selected at the revision shown.

## `forge-platform-invariants`

- Revision: `sha256:c049ebf01d507fbf81467e49ce0fdc3a398f21c01dbb9764550bb17a0cdb3b42`
- Reason: Forge needs these items to work with a repository safely.

### Enforcement references

- `platform.scaffold.records` (locked): none; the item is unbound
- `platform.assurance.records` (locked): none; the item is unbound
- `platform.environment.placement` (locked): none; the item is unbound
- `platform.guidance.entrypoint` (locked): none; the item is unbound
- `platform.standards.packet` (locked): none; the item is unbound
- `platform.environment.example` (locked): none; the item is unbound
- `platform.secrets.none-tracked` (locked): none; the item is unbound
- `platform.commands.catalogue-only` (locked): none; the item is unbound
- `platform.gate.single-entrypoint` (locked): none; the item is unbound
- `platform.deviation.limits` (locked): none; the item is unbound
- `platform.protected-paths` (locked): none; the item is unbound
- `platform.inspect-and-ignore` (locked): none; the item is unbound

### Exclusions

- `platform.runtime.definition`: No selected component has the placement target kind runtime.

## `forge-baseline`

- Revision: `sha256:9b9223ce860173f6a47e387d9b0d1168024d38627544999b46b223017318b18f`
- Reason: Good practice as tool-neutral outcomes. The level of each item says what the product may change.

### Enforcement references

- `repository.ignore.entries` (required): `setting:.gitignore`
- `repository.lockfile.frozen-install` (required): `file:bun.lock`, `preparation-argument:--frozen-lockfile`
- `change-flow.outside-agent-hooks` (required): `file:.claude/settings.json`, `file:.forge/hooks/protected-paths.mjs`
- `test.roles.declared` (required): `command:cli.boundary`, `command:cli.unit`
- `test.integration.runs` (default): none; the item is unchecked
- `test.unit.coverage.minimum` (required): `command:cli.coverage`
- `test.end-to-end.runs` (default): none; the item is unchecked
- `quality.format.check` (required): `command:cli.format-check`
- `quality.lint.zero-warnings` (required): `command:cli.lint`
- `quality.types.strict` (required): `command:cli.type-check`
- `quality.build.succeeds` (required): `command:cli.build`
- `ci.stage.static-checks` (required): none; the item is unbound
- `ci.stage.build` (required): none; the item is unbound
- `ci.stage.end-to-end-test` (default): none; the item is unchecked
- `ci.stage.code-security` (required): none; the item is unbound
- `ci.stage.supply-chain` (required): none; the item is unbound
- `ci.stage.maintenance` (default): none; the item is unchecked
- `ci.provider` (default): none; the item is unchecked
- `ci.dependency-scan.threshold` (default): `command:cli.dependency-scan`
- `ci.artifact.identity` (required): `command:cli.package`
- `ci.licence-scan.allow` (default): none; the item is unchecked
- `security.code-scan` (required): `command:cli.code-scan`, `command:forge-release.secret-scan`
- `security.dependency-scan` (required): `command:cli.dependency-scan`
- `security.licence-scan` (required): none; the item is unbound
- `security.infrastructure-scan` (required): none; the item is unbound

### Exclusions

- `ci.stage.integration-test`: This standalone CLI has no integrated service; boundary tests drive the real command.
- `runtime.http-errors.problem-details`: No selected component has the kind api or web and the placement target kind runtime.
- `runtime.health.ready`: No selected component has the kind api or web or worker and the placement target kind runtime.
- `runtime.logs.structured`: No selected component has the kind api or web or worker and the placement target kind runtime.
- `runtime.shutdown.graceful`: No selected component has the kind api or web or worker and the placement target kind runtime.
- `runtime.settings.checked`: No selected component has the kind api or web or worker and the placement target kind runtime.
- `runtime.jobs.retry-dead-letter`: No selected component has the kind worker and the placement target kind runtime.
- `ui.design.source`: No selected component has the kind static-web or web.
- `ui.design.files`: No selected component has the kind static-web or web.
