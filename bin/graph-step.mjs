import { readFileSync } from "node:fs";
import { dataRoot, isTerminal, newGraph, projection, readGraph, reconcile, writeGraph } from "./graph-state.mjs";

function payload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not read flow payload: ${error.message}`);
  }
}

function promptFor(graph, previous, first) {
  if (first) {
    return [
      "You are running OpenAgent Graph Mode.",
      "",
      `Objective: ${graph.objective}`,
      "",
      "Decompose the objective into dependency-aware nodes and call create_goal_graph with the complete graph. Do not create a fallback or summarizer node.",
      "After the graph starts, use graph_read with its run_id and cursor to follow progress. Use update_goal_graph only for not-yet-started nodes.",
    ].join("\n");
  }
  const output = String(previous ?? "").trim();
  const state = JSON.stringify(projection(graph), null, 2);
  return [
    "This is an OpenAgent Graph control continuation.",
    "",
    `Current Graph state:\n${state}`,
    ...(output ? ["", `Previous execution output:\n${output}`] : []),
    isTerminal(graph)
      ? `The Graph is terminal with status '${graph.status}'. State the final outcome and do not start new nodes.`
      : "Read the latest graph progress with graph_read, then continue unfinished work. Keep node results concise.",
  ].join("\n");
}

function main() {
  const input = payload();
  const conversationId = String(input?.conversation_id ?? "").trim();
  if (!conversationId) throw new Error("conversation_id is required");
  const root = dataRoot();
  let graph = readGraph(root, conversationId);
  const first = Number(input?.iteration ?? 1) === 1 || graph === null;
  if (first) graph = newGraph(conversationId, String(input?.argument ?? input?.input ?? "").trim());
  graph.iteration = Number(input?.iteration ?? 1);
  reconcile(graph);
  writeGraph(root, graph);
  process.stdout.write(`${JSON.stringify({
    prompt: promptFor(graph, input?.last_output, first),
    done: !first && isTerminal(graph),
    state: { plugin_id: String(input?.plugin_id ?? "graph"), flow_id: String(input?.flow_id ?? "plugin:graph:graph"), ...projection(graph) },
  })}\n`);
}

try { main(); } catch (error) { process.stderr.write(`graph step: ${error.message}\n`); process.exit(1); }

