---
name: graph
description: Use OpenAgent Graph Mode when a task can be represented as dependent nodes that should execute with durable progress and parallel scheduling.
---

# Graph Mode

Graph Mode is provided by the OpenAgent Runtime through the `graph` plugin
binding. Use `/graph`, `create_goal_graph`, and `graph_read` so dependencies,
node results, and terminal state remain durable.
