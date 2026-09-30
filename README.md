# opencode-tps-stats

OpenCode v2 TUI plugin that displays response speed and token statistics under
the prompt's context window.

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

The plugin reads the session totals from the message list the TUI already keeps
in memory. It does not send telemetry or make network requests.

## Requirements

OpenCode **v2** (tested against `@opencode/cli` 2.0.20) and its CLI plugin API.
The v1 plugin API is not supported.

## Installation

Clone the repository locally:

```bash
git clone https://github.com/devop-arg/opencode-tps-stats.git \
  ~/.opencode/plugins/opencode-tps-stats
```

Add the package root to the `plugins` array in the CLI configuration
(`~/.config/opencode/cli.json`):

```json
{
  "plugins": ["/home/USER/.opencode/plugins/opencode-tps-stats"]
}
```

Keep existing plugin entries when adding this one. This is a terminal plugin,
so it belongs in `cli.json` and not in the server-plugin array of
`opencode.json`.

> **The `tui.ts` entrypoint is required.** When a plugin is referenced by local
> path, v2 looks for a `tui.ts` file at the root of the directory. It does not
> resolve the `exports["./tui"]` map of `package.json` for path references, so a
> package that only declares that export loads silently as nothing. The root
> `tui.ts` in this repository re-exports `src/index.tsx` and is what makes the
> path reference above work.

The alternative is to let v2 discover the plugin automatically by placing it at
`~/.config/opencode/plugins/opencode-tps-stats/` with `tui.ts` next to
`index.ts`; in that case no `plugins` entry is needed.

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

There is intentionally no build step because OpenCode loads the SolidJS JSX at
runtime.

```bash
bun install
bun test
bun run typecheck
```

The plugin requires an OpenCode v2 TUI host that provides
`@opencode/plugin/tui`, SolidJS, and OpenTUI. Those are declared as peer
dependencies on purpose: the host resolves them, and a second copy of SolidJS
would break the reactive graph.

## License

MIT
