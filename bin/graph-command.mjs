#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { context, host } from "./graph-host.mjs";

function request() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not read Graph command request: ${error.message}`);
  }
}

async function main() {
  const input = request();
  const conversationId = String(input?.conversation_id ?? "").trim();
  const objective = String(input?.argument ?? "").trim();
  if (!conversationId || !objective) throw new Error("conversation_id and argument are required");
  const { branchId } = context({ _openagent: { conversation_id: conversationId, branch_id: input?.branch_id } });
  await host("event.emit", {
    name: "plugin-flow-updated",
    payload: {
      plugin_id: "graph",
      conv_id: conversationId,
      flow_id: "plugin:graph:graph",
      status: "running",
      branch_id: branchId,
      flow: {
        kind: "plugin",
        state: {
          plugin_id: "graph",
          flow_id: "plugin:graph:graph",
          title: objective,
          status: "running",
          items: [],
        },
      },
    },
  });
  process.stdout.write([
    "You are running the OpenAgent Graph plugin.",
    "",
    `Objective:\n${objective}`,
    "",
    "Design a dependency-aware set of nodes and call create_goal_graph with the complete graph.",
    "The Graph plugin creates child conversations and wakes their Agents through the generic host bridge.",
    "After starting it, use graph_read with the returned run_id and cursor to follow progress.",
    "Do not create a fallback or summarizer node.",
  ].join("\n"));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`graph command: ${error.message}\n`);
  process.exit(1);
}
