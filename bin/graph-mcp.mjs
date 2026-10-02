#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { context, host } from "./graph-host.mjs";
import {
  appendUpdate,
  dataRoot,
  deleteGraph,
  isTerminal,
  newGraph,
  projection,
  readGraph,
  reconcile,
  validateGraph,
  writeGraph,
} from "./graph-state.mjs";

const PROTOCOL_VERSION = "2024-11-05";
const root = dataRoot();
const activeRuns = new Set();
let mutation = Promise.resolve();

function runMutation(fn) {
  const previous = mutation;
  let release;
  mutation = new Promise((resolve) => { release = resolve; });
  return previous.then(fn).finally(() => release());
}

const TOOLS = [
  {
    name: "create_goal_graph",
    description:
      "Create and execute a dependency-aware Graph in the background. The call returns immediately; use graph_read until the run is terminal.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["graph"],
      properties: {
        objective: { type: "string" },
        graph: {
          type: "object",
          additionalProperties: false,
          required: ["nodes"],
          properties: {
            nodes: {
              type: "array",
              minItems: 1,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "task"],
                properties: {
                  id: { type: "string" },
                  task: { type: "string" },
                  depends_on: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: "update_goal_graph",
    description: "Add, update, or remove Graph nodes that have not started.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        add_nodes: { type: "array", items: { type: "object" } },
        update_nodes: { type: "array", items: { type: "object" } },
        remove_node_ids: { type: "array", items: { type: "string" } },
        summary: { type: "string" },
      },
    },
  },
  {
    name: "graph_read",
    description: "Read incremental Graph progress by run id and cursor.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["run_id"],
      properties: {
        run_id: { type: "string" },
        cursor: { type: "integer", minimum: 0 },
        wait_secs: { type: "integer", minimum: 0, maximum: 60 },
        limit: { type: "integer", minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: "cancel_goal_graph",
    description: "Cancel an active Graph and its running child conversations.",
    inputSchema: { type: "object", additionalProperties: false, required: ["run_id"], properties: { run_id: { type: "string" } } },
  },
  {
    name: "delete_goal_graph",
    description: "Delete a terminal Graph run from the plugin's active state.",
    inputSchema: { type: "object", additionalProperties: false, required: ["run_id"], properties: { run_id: { type: "string" } } },
  },
];

function result(value) {
  return JSON.stringify(value);
}

function getGraph(args) {
  const { conversationId, branchId } = context(args);
  const graph = readGraph(root, conversationId, branchId);
  if (
    !graph ||
    graph.run_id !== String(args?.run_id ?? graph.run_id) ||
    (graph.branch_id ?? null) !== (branchId ?? null)
  ) {
    throw new Error("Graph run was not found for this conversation branch");
  }
  return { graph, conversationId, branchId };
}

function emit(graph, type, payload = {}) {
  appendUpdate(graph, type, payload);
  writeGraph(root, graph);
  const flow = {
    kind: "plugin",
    state: { plugin_id: "graph", flow_id: "plugin:graph:graph", ...projection(graph) },
  };
  if (graph.branch_id) {
    void host("conversation.flow.set", {
      conv_id: graph.conversation_id,
      branch_id: graph.branch_id,
      flow,
    }).catch(() => {});
  }
  void host("event.emit", {
    name: "plugin-flow-updated",
    payload: {
      plugin_id: "graph",
      conv_id: graph.conversation_id,
      branch_id: graph.branch_id,
      flow_id: "plugin:graph:graph",
      status: graph.status,
      flow,
    },
  }).catch(() => {});
}

async function startGraph(args) {
  const { conversationId, branchId } = context(args);
  const config = args?.graph;
  if (!config || !Array.isArray(config.nodes) || config.nodes.length === 0) throw new Error("graph.nodes must be a non-empty array");
  const objective = String(args?.objective ?? "").trim() || config.nodes.map((node) => String(node.task ?? "")).join("\n");
  const graph = await runMutation(() => {
    const created = newGraph(conversationId, branchId, objective, config.nodes);
    writeGraph(root, created);
    emit(created, "created");
    return created;
  });
  void runGraph(graph.conversation_id, graph.branch_id, graph.run_id);
  return { run_id: graph.run_id, conv_id: conversationId, status: graph.status, next_cursor: graph.cursor, graph: projection(graph) };
}

function dependencyResults(graph, node) {
  return node.depends_on
    .map((id) => graph.nodes.find((candidate) => candidate.id === id))
    .filter((candidate) => candidate?.result)
    .map((candidate) => `${candidate.id}:\n${candidate.result}`)
    .join("\n\n");
}

function currentChild(node) {
  return node?.child_conv_id && node?.child_branch_id
    ? { conv_id: node.child_conv_id, branch_id: node.child_branch_id }
    : null;
}

async function runNode(conversationId, branchId, runId, nodeId) {
  const initial = readGraph(root, conversationId, branchId);
  if (!initial || initial.run_id !== runId || isTerminal(initial)) return;
  const node = initial.nodes.find((candidate) => candidate.id === nodeId);
  if (!node || node.status !== "running") return;
  const existingChild = currentChild(node);
  const created = existingChild ?? await host("conversation.create", {
    title: `Graph node ${node.id}`,
    workspace: "",
    parent_conv_id: conversationId,
  });
  await runMutation(() => {
    const graph = readGraph(root, conversationId, branchId);
    if (!graph || graph.run_id !== runId || isTerminal(graph)) return;
    const current = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (!current || current.status !== "running") return;
    current.child_conv_id = created.conv_id;
    current.child_branch_id = created.branch_id;
    writeGraph(root, graph);
    emit(graph, "node-started", { node_id: nodeId });
  });
  const graph = readGraph(root, conversationId, branchId);
  const current = graph?.run_id === runId ? graph.nodes.find((candidate) => candidate.id === nodeId) : null;
  if (!graph || !current || isTerminal(graph)) {
    await host("conversation.cancel", { conv_id: created.conv_id }).catch(() => {});
    return;
  }
  const detail = await host("conversation.state", {
    conv_id: current.child_conv_id,
    branch_id: current.child_branch_id,
  });
  const taskMessageId = randomUUID();
  const assistantMessageId = randomUUID();
  if (!existingChild) {
    await host("event.emit", {
      name: "subagent-started",
      payload: {
        plugin_id: "graph",
        parent_conv_id: conversationId,
        sub_conv_id: current.child_conv_id,
        title: `Graph node ${node.id}`,
        task: node.task,
        task_msg_id: taskMessageId,
        asst_msg_id: assistantMessageId,
        workspace: String(detail?.workspace ?? ""),
        branch_id: current.child_branch_id,
        hidden_task: true,
        flow_kind: "graph-node",
      },
    }).catch(() => {});
  }
  const dependency = dependencyResults(graph, current);
  const prompt = [
    "You are executing one node from an OpenAgent Graph.",
    `Original objective: ${graph.objective}`,
    `Node id: ${current.id}`,
    `Node task: ${current.task}`,
    dependency ? `Completed dependency results:\n${dependency}` : "This node has no dependency results.",
    "Execute only this node and finish with a concise result.",
  ].join("\n\n");
  const response = await host("agent.wake", {
    request: {
      conv_id: current.child_conv_id,
      branch_id: current.child_branch_id,
      text: prompt,
      // The generic bridge resolves the selected child branch head just before
      // submission, so a queued wake cannot reuse a stale checkpoint.
      parent_checkpoint_id: null,
      attachments: [],
      contexts: [],
      model_binding: null,
      user_message_id: null,
      assistant_message_id: assistantMessageId,
      hidden: true,
      flow: {
        kind: "plugin",
        state: {
          plugin_id: "graph",
          flow_id: "plugin:graph:graph",
          title: graph.objective,
          status: graph.status,
          items: projection(graph).items,
        },
      },
    },
  });
  const messages = response?.state?.messages ?? [];
  const assistant = [...messages].reverse().find((message) => message.role === "assistant");
  await runMutation(() => {
    const latest = readGraph(root, conversationId, branchId);
    if (!latest || latest.run_id !== runId || isTerminal(latest)) return;
    const completed = latest.nodes.find((candidate) => candidate.id === nodeId);
    if (!completed || completed.status !== "running") return;
    completed.result = String(assistant?.text ?? "").trim();
    completed.child_checkpoint_id = response?.state?.checkpoint_id ?? null;
    completed.status = completed.result ? "completed" : "failed";
    if (!completed.result) latest.status = "failed";
    writeGraph(root, latest);
    emit(latest, "node-finished", { node_id: nodeId });
  });
}

async function runGraph(conversationId, branchId, runId) {
  const key = `${conversationId}:${branchId ?? ""}:${runId}`;
  if (activeRuns.has(key)) return;
  activeRuns.add(key);
  try {
    while (true) {
      const graph = readGraph(root, conversationId, branchId);
      if (!graph || graph.run_id !== runId || isTerminal(graph)) return;
      const running = graph.nodes.filter((node) => node.status === "running");
      if (running.length > 0) {
        await Promise.all(running.map((node) => runNode(conversationId, branchId, runId, node.id).catch((error) =>
          runMutation(() => {
            const latest = readGraph(root, conversationId, branchId);
            if (!latest || latest.run_id !== runId || isTerminal(latest)) return;
            const failed = latest.nodes.find((candidate) => candidate.id === node.id);
            if (!failed || failed.status !== "running") return;
            failed.status = "failed";
            failed.result = String(error?.message ?? error);
            latest.status = "failed";
            writeGraph(root, latest);
            emit(latest, "node-failed", { node_id: node.id });
          }),
        )));
        const resumed = readGraph(root, conversationId, branchId);
        if (!resumed || resumed.run_id !== runId || isTerminal(resumed)) return;
        reconcile(resumed);
        writeGraph(root, resumed);
        emit(resumed, "advance");
        continue;
      }
      const runnable = graph.nodes.filter((node) =>
        node.status === "pending" && node.depends_on.every((dependency) =>
          graph.nodes.some((candidate) => candidate.id === dependency && candidate.status === "completed"),
        ),
      );
      if (runnable.length === 0) {
        await runMutation(() => {
          const latest = readGraph(root, conversationId, branchId);
          if (!latest || latest.run_id !== runId || isTerminal(latest)) return;
          if (latest.nodes.some((node) => node.status === "pending" || node.status === "running")) {
            latest.status = "blocked";
            latest.summary = "Graph dependencies cannot make further progress.";
          } else {
            reconcile(latest);
          }
          writeGraph(root, latest);
          emit(latest, "terminal");
        });
        return;
      }
      const nodeIds = runnable.map((node) => node.id);
      const started = await runMutation(() => {
        const latest = readGraph(root, conversationId, branchId);
        if (!latest || latest.run_id !== runId || isTerminal(latest)) return false;
        for (const node of latest.nodes) {
          if (!nodeIds.includes(node.id) || node.status !== "pending") continue;
          node.started = true;
          node.status = "running";
        }
        writeGraph(root, latest);
        emit(latest, "nodes-started", { node_ids: nodeIds });
        return true;
      });
      if (!started) return;
      await Promise.all(nodeIds.map((nodeId) => runNode(conversationId, branchId, runId, nodeId).catch((error) =>
        runMutation(() => {
          const latest = readGraph(root, conversationId, branchId);
          if (!latest || latest.run_id !== runId || isTerminal(latest)) return;
          const failed = latest.nodes.find((node) => node.id === nodeId);
          if (!failed || failed.status !== "running") return;
          failed.status = "failed";
          failed.result = String(error?.message ?? error);
          latest.status = "failed";
          writeGraph(root, latest);
          emit(latest, "node-failed", { node_id: nodeId });
        }),
      )));
      const advanced = await runMutation(() => {
        const latest = readGraph(root, conversationId, branchId);
        if (!latest || latest.run_id !== runId || isTerminal(latest)) return latest;
        reconcile(latest);
        writeGraph(root, latest);
        emit(latest, "advance");
        return latest;
      });
      if (!advanced || isTerminal(advanced)) return;
    }
  } finally {
    activeRuns.delete(key);
  }
}

async function updateGraph(args) {
  return runMutation(async () => {
  const { graph } = getGraph(args);
  for (const id of args?.remove_node_ids ?? []) {
    const node = graph.nodes.find((candidate) => candidate.id === id);
    if (!node) throw new Error(`Graph node '${id}' does not exist`);
    if (node.started) throw new Error(`Graph node '${id}' has already started`);
    if (graph.nodes.some((candidate) => candidate.depends_on.includes(id))) throw new Error(`Graph node '${id}' is still required`);
  }
  graph.nodes = graph.nodes.filter((node) => !(args?.remove_node_ids ?? []).includes(node.id));
  for (const node of args?.add_nodes ?? []) {
    if (graph.nodes.some((candidate) => candidate.id === node.id)) throw new Error(`Graph node '${node.id}' already exists`);
    graph.nodes.push({ id: String(node.id), task: String(node.task), depends_on: Array.isArray(node.depends_on) ? node.depends_on.map(String) : [], status: "pending", started: false, child_conv_id: null, child_branch_id: null, child_checkpoint_id: null, result: null });
  }
  for (const update of args?.update_nodes ?? []) {
    const node = graph.nodes.find((candidate) => candidate.id === update.id);
    if (!node) throw new Error(`Graph node '${update.id}' does not exist`);
    if (node.started) throw new Error(`Graph node '${update.id}' has already started`);
    if (update.task !== undefined) node.task = String(update.task);
    if (update.depends_on !== undefined) node.depends_on = update.depends_on.map(String);
  }
  validateGraph(graph.nodes);
  if (typeof args?.summary === "string" && args.summary.trim()) graph.summary = args.summary.trim();
  graph.status = "running";
  writeGraph(root, graph);
  emit(graph, "updated");
  void runGraph(graph.conversation_id, graph.branch_id, graph.run_id);
  return { run_id: graph.run_id, status: graph.status, graph: projection(graph) };
  });
}

async function readProgress(args) {
  let { graph } = getGraph(args);
  const cursor = Number.isInteger(args?.cursor) ? args.cursor : 0;
  const limit = Math.max(1, Math.min(200, Number(args?.limit ?? 50)));
  const waitSecs = Math.max(0, Math.min(60, Number(args?.wait_secs ?? 10)));
  const deadline = Date.now() + waitSecs * 1000;
  let updates = graph.updates.filter((update) => update.cursor > cursor).slice(0, limit);
  while (updates.length === 0 && !isTerminal(graph) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    graph = getGraph(args).graph;
    updates = graph.updates.filter((update) => update.cursor > cursor).slice(0, limit);
  }
  return { run_id: graph.run_id, conv_id: graph.conversation_id, status: graph.status, next_cursor: updates.at(-1)?.cursor ?? cursor, updates, graph: projection(graph) };
}

async function callTool(name, args) {
  if (name === "create_goal_graph") return result(await startGraph(args));
  if (name === "update_goal_graph") return result(await updateGraph(args));
  if (name === "graph_read") return result(await readProgress(args));
  if (name === "cancel_goal_graph") {
    return runMutation(async () => {
      const { graph } = getGraph(args);
      if (isTerminal(graph)) throw new Error(`Graph run ${graph.run_id} is already terminal`);
      graph.status = "cancelled";
      for (const node of graph.nodes) if (node.status === "pending" || node.status === "running") node.status = "cancelled";
      writeGraph(root, graph);
      for (const node of graph.nodes) {
        if (node.child_conv_id) await host("conversation.cancel", { conv_id: node.child_conv_id }).catch(() => {});
      }
      emit(graph, "cancelled");
      return result({ run_id: graph.run_id, status: graph.status, graph: projection(graph) });
    });
  }
  if (name === "delete_goal_graph") {
    return runMutation(() => {
      const { graph, conversationId, branchId } = getGraph(args);
      if (!isTerminal(graph)) throw new Error("Graph must be terminal before deletion");
      const response = { run_id: graph.run_id, status: "deleted", graph: projection(graph), conversation_id: conversationId };
      deleteGraph(root, conversationId, branchId);
      return result(response);
    });
  }
  throw new Error(`Unknown tool: ${name}`);
}

function send(message) { process.stdout.write(`${JSON.stringify(message)}\n`); }
function reply(id, value, isError = false) {
  send({
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text: String(value) }], isError },
  });
}

function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: "graph", version: "1.0.0" } } });
    return;
  }
  if (method === "notifications/initialized" || method === "ping") { if (method === "ping") send({ jsonrpc: "2.0", id, result: {} }); return; }
  if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools: TOOLS } }); return; }
  if (method === "tools/call") {
    callTool(params?.name, params?.arguments ?? {})
      .then((value) => reply(id, value))
      .catch((error) => reply(id, String(error.message ?? error), true));
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try { handle(JSON.parse(line)); } catch (error) { process.stderr.write(`graph server: ${error.message}\n`); }
    }
    index = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));

async function recoverRunningGraphs() {
  const { existsSync, readdirSync, readFileSync } = await import("node:fs");
  const { default: path } = await import("node:path");
  const directory = path.join(root, "graphs");
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const stored = JSON.parse(readFileSync(path.join(directory, entry), "utf8"));
      if (stored?.status === "running" && stored?.nodes?.length > 0) {
        void runGraph(stored.conversation_id, stored.branch_id ?? null, stored.run_id);
      }
    } catch {
      // A malformed package state file is ignored; a new command can repair it.
    }
  }
}

setTimeout(() => void recoverRunningGraphs(), 100);
