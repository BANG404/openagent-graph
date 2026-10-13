import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { normalize, readGraph } from "./graph-state.mjs";

/** Exact parent/child branch lookup; never borrow a sibling branch's Graph. */
export function readGraphView(root, conversationId, branchId) {
  const own = readGraph(root, conversationId, branchId);
  if (own) return view(own);
  const directory = path.join(root, "graphs");
  for (const file of readdirSync(directory).filter((name) => name.endsWith(".json"))) {
    let graph;
    try { graph = normalize(JSON.parse(readFileSync(path.join(directory, file), "utf8"))); }
    catch { continue; }
    if (graph.nodes.some((node) => node.child_conv_id === conversationId && node.child_branch_id === branchId)) {
      return view(graph);
    }
  }
  return null;
}

function view(graph) {
  return {
    run_id: graph.run_id,
    objective: graph.objective,
    status: graph.status,
    summary: graph.summary,
    nodes: graph.nodes.map(({ id, task, depends_on, status, result }) => ({ id, task, depends_on, status, result })),
  };
}
