#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { bootstrapPrompt } from "./lib/graph-bridge.mjs";

function request() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error(`could not read Graph command request: ${error.message}`);
  }
}

function main() {
  const input = request();
  const conversationId = String(input?.conversation_id ?? "").trim();
  const objective = String(input?.argument ?? "").trim();
  if (!conversationId || !objective) throw new Error("conversation_id and argument are required");
  process.stdout.write(bootstrapPrompt(objective));
}

try {
  main();
} catch (error) {
  process.stderr.write(`graph command: ${error.message}\n`);
  process.exit(1);
}
