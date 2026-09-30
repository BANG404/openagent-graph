# OpenAgent Graph

The standard Agent Plugin package for OpenAgent Graph Mode. The package carries
the public plugin identity, its Skill, Flow step, MCP server, package-owned
state, and the GitHub subscription source. The trusted OpenAgent Runtime
supplies only the generic Flow loop, conversations, checkpoints, cancellation,
and the plugin host bridge. Graph persistence, parallel node scheduling,
`/graph` prompts, and graph tool semantics live here.

Install or update this package from its GitHub repository in OpenAgent. The
package uses the portable Agent Plugins 1.0.0 format plus the
`extensions.openagent.runtime` binding.

## Message policies

This package declares none. The Runtime keeps the old
`graph_bootstrap`, `graph_continuation`, `graph_node_bootstrap`, and
`graph_node_continuation` entries only to read legacy checkpoints. New Graph
flow messages use the generic plugin-flow tags and projection. A policy declared here would be namespaced to
`plugin:graph:<tag>`, which belongs to messages this package's own automation
would print; this package ships no automation, so it could never take effect and
would only add a second entry to the plugin card's policy count.

## Development

Validate it with the validator from an
[OpenAgent Plugin Kit](https://github.com/BANG404/openagent-plugin-kit)
checkout, pointing at this directory.

```bash
bun <plugin-kit>/scripts/validate-plugin.mjs .
```

## License

MIT
