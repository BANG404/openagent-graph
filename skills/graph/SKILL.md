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

The package's `plugin:graph:graph` flow identifier is an opaque projection key
chosen by this package. Runtime only validates the authenticated plugin owner
and stores the projection; it does not provide or register Graph behavior.
