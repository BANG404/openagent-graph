#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { context, event, conversation } from "./graph-host.mjs";
import { bootstrapPrompt } from "./lib/graph-bridge.mjs";

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
  const flow = { kind: "plugin", state: { plugin_id: "graph", flow_id: "plugin:graph:graph", title: objective, status: "running", items: [] } };
  if (branchId) {
    await conversation.setFlow(conversationId, branchId, flow);
  }
  if (branchId) {
    await event.emit("plugin-flow-updated", {
      plugin_id: "graph",
      conv_id: conversationId,
      flow_id: "plugin:graph:graph",
      status: "running",
      branch_id: branchId,
      flow,
    });
  }
  process.stdout.write(bootstrapPrompt(objective));
}

try {
  await main();
} catch (error) {
  process.stderr.write(`graph command: ${error.message}\n`);
  process.exit(1);
}
