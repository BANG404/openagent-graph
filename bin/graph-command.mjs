#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { bootstrapPrompt } from "./lib/graph-bridge.mjs";
import { createHostClient } from "./lib/openagent-host.mjs";
import { defaultLocale, errorNotice, requestLocale } from "./i18n.mjs";

function request() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch (error) {
    throw new Error("Could not read the Graph command request");
  }
}

function main() {
  const input = request();
  const conversationId = String(input?.conversation_id ?? "").trim();
  const objective = String(input?.argument ?? "").trim();
  if (!conversationId || !objective) throw new Error("conversation_id and argument are required");
  process.stdout.write(bootstrapPrompt(objective));
}

let host = null;
let locale = defaultLocale;
try {
  if (process.env.OPENAGENT_PLUGIN_HOST_URL?.trim()) host = createHostClient();
  try { locale = await requestLocale({}, host); } catch {}
  main();
} catch (error) {
  process.stderr.write(`${errorNotice(error, locale)}\n`);
  process.exit(1);
}
