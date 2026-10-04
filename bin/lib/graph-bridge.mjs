import { isTerminal, projection } from "../graph-state.mjs";

export const FLOW_ID = "plugin:graph:graph";

export function flowState(graph) {
  return {
    plugin_id: "graph",
    flow_id: FLOW_ID,
    ...projection(graph),
  };
}

export function flowProjection(graph) {
  return { kind: "plugin", state: flowState(graph) };
}

/** Persist Graph's opaque projection using only generic package capabilities. */
export async function publishGraph(host, graph) {
  const flow = flowProjection(graph);
  const targets = new Map();
  const add = (conversationId, branchId) => {
    if (conversationId && branchId) targets.set(`${conversationId}\u0000${branchId}`, [conversationId, branchId]);
  };
  add(graph.conversation_id, graph.branch_id);
  for (const node of graph.nodes) add(node.child_conv_id, node.child_branch_id);
  // A deleted child or a busy sibling branch must not prevent the other
  // surfaces from receiving the authoritative package projection.
  const results = await Promise.allSettled([...targets.values()].map(async ([conversationId, branchId]) => {
    await host.conversation.setFlow(conversationId, branchId, flow);
    await host.event.emit("plugin-flow-updated", {
      plugin_id: "graph",
      conv_id: conversationId,
      branch_id: branchId,
      flow_id: FLOW_ID,
      status: graph.status,
      flow,
    });
  }));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Graph projection publication failed");
}

export function bootstrapPrompt(objective) {
  return [
    "You are running the OpenAgent Graph plugin.",
    "",
    `Objective:\n${objective}`,
    "",
    "This is an execution request. Plan the dependency-aware nodes internally, then call create_goal_graph in this turn before replying to the user.",
    "Pass the original objective and a complete DAG using this argument shape (replace the example node with the actual tasks and dependencies):",
    JSON.stringify({ objective, graph: { nodes: [{ id: "research", task: "Perform the requested research", depends_on: [] }] } }),
    "The Graph plugin creates child conversations and wakes their Agents through the generic host bridge.",
    "The slash command has not created or started a Graph. Only a successful create_goal_graph result confirms that execution started.",
    "After creating it, call graph_read with the returned run_id, cursor set to next_cursor, and wait_secs: 60. Keep reading with each returned next_cursor until the run is terminal.",
    "Do not end the turn with a plan or a promise to call tools later. Once graph_read reports a terminal status, stop calling tools and immediately report the actual outcome in the user's language; do not inspect skills or run unrelated commands.",
    "If the required tools are unavailable, try load_tool to load Graph execution tools; if they remain unavailable or creation fails, report that the Graph could not start and the concrete error. Never claim it is running without a successful tool result.",
    "Do not create a fallback or summarizer node.",
  ].join("\n");
}

export function nodePrompt(graph, node, dependency) {
  return [
    "You are executing one node from an OpenAgent Graph plugin run.",
    `Original objective: ${graph.objective}`,
    `Node id: ${node.id}`,
    `Node task: ${node.task}`,
    dependency ? `Completed dependency results:\n${dependency}` : "This node has no dependency results.",
    "Execute only this node and finish with a concise result.",
  ].join("\n\n");
}

export function continuationPrompt(graph, previousOutput = "") {
  const output = String(previousOutput ?? "").trim();
  return [
    "This is a package-owned Graph continuation.",
    "",
    "Current Graph state:",
    JSON.stringify(projection(graph), null, 2),
    ...(output ? ["", "Previous execution output:", output] : []),
    "",
    isTerminal(graph)
      ? `The Graph is terminal with status ${graph.status}. State the final outcome and do not start new nodes.`
      : "Read the latest graph progress with graph_read, then continue unfinished work.",
  ].join("\n");
}
