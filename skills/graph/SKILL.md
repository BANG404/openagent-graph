---
name: graph
description: Use OpenAgent Graph Mode when a task can be represented as dependent nodes that should execute with durable progress and parallel scheduling.
---

# Graph Mode

Graph Mode is implemented by this plugin. Start it with `/graph <objective>`;
then call `create_goal_graph` with a complete DAG and use `graph_read` to follow
the package-owned run. The plugin creates child conversations and wakes their
Agents through the generic host bridge. It owns node state, dependencies,
reduction, recovery, cancellation, and completion.

`/graph` supplies an execution prompt and does not start or publish a run.
Plan the nodes internally and call `create_goal_graph` in the same turn before
replying. Pass the original objective and `graph.nodes` with each node's `id`,
`task`, and `depends_on`. Only successful creation establishes a running Graph;
its MCP server then persists and publishes the first projection. Follow the
returned `run_id` and `next_cursor` with `graph_read`, using `wait_secs: 60`
until terminal. Report the actual outcome in the user's language. If tools
cannot be loaded or creation fails, report the error rather than promising
future execution or claiming that a run exists.

The package's `plugin:graph:graph` flow identifier is an opaque projection key
chosen by this package. Runtime only validates the authenticated plugin owner
and stores the projection; it does not provide or register Graph behavior.
