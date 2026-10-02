import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const FINAL = new Set(["completed", "failed", "blocked", "cancelled"]);

export function dataRoot() {
  const root = String(process.env.PLUGIN_DATA ?? "").trim();
  if (!root) throw new Error("PLUGIN_DATA is not set");
  mkdirSync(path.join(root, "graphs"), { recursive: true });
  return root;
}

function branchKey(branchId) {
  return typeof branchId === "string" && branchId.trim() !== "" ? branchId.trim() : null;
}

function fileFor(root, conversationId, branchId = null) {
  const key = `${String(conversationId)}\u0000${branchKey(branchId) ?? ""}`;
  const digest = createHash("sha256").update(key).digest("hex");
  return path.join(root, "graphs", `${digest}.json`);
}

/** Files written by versions that only scoped a graph to its conversation. */
function legacyFileFor(root, conversationId) {
  const digest = createHash("sha256").update(String(conversationId)).digest("hex");
  return path.join(root, "graphs", `${digest}.json`);
}

export function readGraph(root, conversationId, branchId = null) {
  const requestedBranch = branchKey(branchId);
  const file = fileFor(root, conversationId, requestedBranch);
  const candidates = [file];
  const legacy = legacyFileFor(root, conversationId);
  if (legacy !== file) candidates.push(legacy);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const graph = normalize(JSON.parse(readFileSync(candidate, "utf8")));
      if (graph.conversation_id !== String(conversationId)) continue;
      if (branchKey(graph.branch_id) !== requestedBranch) continue;
      return graph;
    } catch {
      // A malformed package state file is ignored; another branch can still run.
    }
  }
  return null;
}

export function writeGraph(root, graph) {
  graph.updated_at = Date.now();
  const file = fileFor(root, graph.conversation_id, graph.branch_id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(graph, null, 2)}\n`, "utf8");
}

export function deleteGraph(root, conversationId, branchId = null) {
  const file = fileFor(root, conversationId, branchId);
  if (existsSync(file)) unlinkSync(file);
}

export function newGraph(conversationId, branchId, objective, nodes) {
  const graph = {
    run_id: randomUUID(),
    conversation_id: String(conversationId),
    branch_id: branchKey(branchId),
    objective: String(objective ?? "").trim(),
    nodes: (nodes ?? []).map((node) => ({
      id: String(node.id).trim(),
      task: String(node.task).trim(),
      depends_on: Array.isArray(node.depends_on) ? node.depends_on.map(String) : [],
      status: "pending",
      started: false,
      child_conv_id: null,
      child_branch_id: null,
      child_checkpoint_id: null,
      result: null,
    })),
    status: "running",
    summary: null,
    iteration: 0,
    cursor: 0,
    updates: [],
    running: false,
    updated_at: Date.now(),
  };
  validateGraph(graph.nodes);
  return graph;
}

export function normalize(value) {
  const graph = value && typeof value === "object" ? value : {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  return {
    run_id: typeof graph.run_id === "string" ? graph.run_id : randomUUID(),
    conversation_id: String(graph.conversation_id ?? ""),
    branch_id: branchKey(graph.branch_id),
    objective: String(graph.objective ?? ""),
    nodes: nodes.map((node) => ({
      id: String(node?.id ?? ""),
      task: String(node?.task ?? ""),
      depends_on: Array.isArray(node?.depends_on) ? node.depends_on.map(String) : [],
      status: ["pending", "running", "completed", "failed", "blocked", "cancelled"].includes(node?.status)
        ? node.status
        : "pending",
      started: Boolean(node?.started),
      child_conv_id: node?.child_conv_id ? String(node.child_conv_id) : null,
      child_branch_id: node?.child_branch_id ? String(node.child_branch_id) : null,
      child_checkpoint_id: node?.child_checkpoint_id ? String(node.child_checkpoint_id) : null,
      result: node?.result == null ? null : String(node.result),
    })),
    status: ["running", "completed", "failed", "blocked", "cancelled"].includes(graph.status)
      ? graph.status
      : "running",
    summary: graph.summary == null ? null : String(graph.summary),
    iteration: Number.isInteger(graph.iteration) ? graph.iteration : 0,
    cursor: Number.isInteger(graph.cursor) ? graph.cursor : 0,
    updates: Array.isArray(graph.updates) ? graph.updates : [],
    running: Boolean(graph.running),
    updated_at: Number.isFinite(graph.updated_at) ? graph.updated_at : Date.now(),
  };
}

export function validateGraph(nodes) {
  const ids = new Set();
  for (const node of nodes) {
    if (!node.id || node.id.trim() !== node.id || !node.task.trim()) {
      throw new Error("graph nodes require non-empty id and task");
    }
    if (ids.has(node.id)) throw new Error(`duplicate graph node '${node.id}'`);
    ids.add(node.id);
  }
  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (!ids.has(dependency)) throw new Error(`unknown dependency '${dependency}'`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (id) => {
    if (visiting.has(id)) throw new Error("graph dependencies contain a cycle");
    if (visited.has(id)) return;
    visiting.add(id);
    const node = nodes.find((candidate) => candidate.id === id);
    for (const dependency of node.depends_on) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const node of nodes) visit(node.id);
  return true;
}

export function reconcile(graph) {
  if (graph.status === "cancelled" || graph.status === "failed" || graph.status === "blocked") return graph;
  if (graph.nodes.length > 0 && graph.nodes.every((node) => node.status === "completed")) {
    graph.status = "completed";
  } else {
    graph.status = "running";
  }
  return graph;
}

export function isTerminal(graph) {
  return FINAL.has(graph.status);
}

export function projection(graph) {
  return {
    title: graph.objective,
    status: graph.status,
    items: graph.nodes.map((node) => ({
      id: node.id,
      label: node.task,
      status: node.status,
      ...(node.result ? { detail: node.result } : {}),
    })),
    ...(graph.summary ? { summary: graph.summary } : {}),
  };
}

export function appendUpdate(graph, type, payload = {}) {
  graph.cursor += 1;
  graph.updates.push({ cursor: graph.cursor, type, ...payload, graph: projection(graph) });
  if (graph.updates.length > 200) graph.updates.splice(0, graph.updates.length - 200);
}
