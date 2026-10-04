# OpenAgent Graph

The standard Agent Plugin package for dependency aware Graph execution. The
package owns the graph schema, reducer, persistence, child conversations,
parallel scheduling, prompts, recovery, MCP tools, and progress projection.
OpenAgent supplies the same generic capability bridge available to every
plugin: conversations, branches, Agent submission and wake, roles, events,
cancellation, permissions, and ordinary checkpoint storage.

The package uses the portable Agent Plugins 1.0.0 format and is an ordinary
package; the Runtime does not select or implement Graph behavior. The `graph`
command is exposed as
`/graph` through the generic package-id alias; `/graph:graph` remains the full
namespaced route. `mcp.json` starts `bin/graph-mcp.mjs`, which persists Graph
state under `PLUGIN_DATA/graphs/` and wakes child Agents through
`agent.wake`.

The slash command only supplies the planning/execution prompt. It does not
write package state or publish an empty running projection. A Graph starts
when the Agent successfully calls `create_goal_graph`; that tool persists the
DAG and publishes its first projection before scheduling nodes. If a model
returns only a plan without calling the tool, no run is created and an earlier
branch projection remains intact. The bootstrap prompt requires same-turn
creation and progress reads through the terminal outcome, but a prompt cannot
guarantee that a model will call tools.

The package persists its complete display projection through the generic
`conversation.flow.set` capability after each reducer advance; the graph files
under `PLUGIN_DATA` remain authoritative. The `plugin:graph:graph` value in
that projection is only the package's own flow identifier. Runtime does not
register, inspect, or execute a Graph implementation based on that string.

## State and recovery

Each parent conversation branch has one package-owned Graph record. Nodes are
validated as a DAG, marked started before their child conversation is created,
and reduced serially as child Agent turns finish. A node stores its child
conversation, branch, checkpoint, status, and result. The package resumes
running records when its MCP server starts, and cancellation propagates through
the generic conversation cancellation bridge.

`plugin-flow-updated` is a transient display event. The Runtime carries the
package's optional projection opaquely in checkpoints and never interprets node
dependencies or Graph completion rules.

## Development

Stable GitHub releases include an installable ZIP with `plugin.json` at the
archive root. OpenAgent verifies the release asset's SHA-256 digest before
offering an explicit update; installed Graph data is preserved during activation.

Validate it with the validator from an
[OpenAgent Plugin Kit](https://github.com/BANG404/openagent-plugin-kit)
checkout, pointing at this directory.

```bash
bun <plugin-kit>/scripts/validate-plugin.mjs .
bun test
```

## License

MIT
