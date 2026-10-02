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
  if (graph.branch_id) {
    await host.conversation.setFlow(graph.conversation_id, graph.branch_id, flow);
    await host.event.emit("plugin-flow-updated", {
      plugin_id: "graph",
      conv_id: graph.conversation_id,
      branch_id: graph.branch_id,
      flow_id: FLOW_ID,
      status: graph.status,
      flow,
    });
  }
}

export function bootstrapPrompt(objective) {
  return [
    "You are running the OpenAgent Graph plugin.",
    "",
    `Objective:\n${objective}`,
    "",
    "Design a dependency-aware set of nodes and call create_goal_graph with the complete graph.",
    "The Graph plugin creates child conversations and wakes their Agents through the generic host bridge.",
    "After starting it, use graph_read with the returned run_id and cursor to follow progress.",
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
