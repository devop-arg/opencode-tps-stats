# opencode-tps-stats

OpenCode TUI plugin that displays response speed and token statistics in the
session prompt area.

> **Experimental project.** This plugin is not affiliated with, endorsed by,
> sponsored by, or associated with Anomaly or OpenCode. Use it at your own
> risk.

```text
tps 12 μ20 ↑80 · 32r ↑88k ↓7k · C 1.0M T 1.1M
```

- `tps 12`: current TPS for the active response, or the last completed response.
- `μ20`: arithmetic mean TPS of completed responses in the session.
- `↑80`: highest TPS observed among completed responses and the active response.
- `32r`: assistant requests with token data.
- `↑88k`: input tokens.
- `↓7k`: output plus reasoning tokens.
- `C 1.0M`: cache read and write tokens.
- `T 1.1M`: input, output, reasoning, and cache tokens combined.

The plugin reads the local OpenCode SQLite database in read-only mode for
session totals. It does not send telemetry or make network requests.

## Installation

Clone the repository locally:

```bash
git clone https://github.com/devop-arg/opencode-tps-stats.git \
  ~/.opencode/plugins/opencode-tps-stats
```

Add the package root to the `plugin` array in the TUI configuration. Depending
on the OpenCode installation, this file is usually
`~/.config/opencode/tui.json` or `~/.opencode/tui.json`:

```json
{
  "plugin": [
    "/home/USER/.opencode/plugins/opencode-tps-stats"
  ]
}
```

Keep existing plugin entries when adding this one. This is a TUI plugin, so do
not add it to the server-plugin array in `opencode.json`.

Restart OpenCode after changing the configuration. Confirm that
`opencode-tps-stats` is enabled with `/plugins`.

## Updating

The local clone is the installed plugin. Update it with:

```bash
git -C ~/.opencode/plugins/opencode-tps-stats pull --ff-only
```

Restart OpenCode after updating. Releases can also be tagged and pinned by
checking out a version tag instead of tracking `main`.

## Development

The package exports the TypeScript source directly through `exports["./tui"]`.
There is intentionally no build step because OpenCode loads the SolidJS JSX at
runtime.

```bash
bun install
bun test
bun run typecheck
```

The plugin requires an OpenCode TUI host that provides
`@opencode-ai/plugin/tui`, `@opencode-ai/sdk/v2`, SolidJS, and OpenTUI.

## License

MIT
