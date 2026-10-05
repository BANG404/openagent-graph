import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { newGraph, readGraph, writeGraph } from "../bin/graph-state.mjs";

const packageRoot = path.resolve(import.meta.dirname, "..");
const mcpScript = path.join(packageRoot, "bin", "graph-mcp.mjs");

async function startHost({ childState, wakeState } = {}) {
  const requests = [];
  let childNumber = 0;
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const parsed = JSON.parse(body);
    requests.push(parsed);
    let result = {};
    if (parsed.operation === "conversation.create") {
      childNumber += 1;
      result = { conv_id: `child-${childNumber}`, branch_id: `child-branch-${childNumber}` };
    } else if (parsed.operation === "conversation.state") {
      result = parsed.args.conv_id === "parent"
        ? { branch_id: parsed.args.branch_id ?? null, workspace: "parent-workspace" }
        : childState?.() ?? { branch_id: parsed.args.branch_id ?? null, workspace: "" };
    } else if (parsed.operation === "agent.wake") {
      result = {
        accepted: true,
        state: wakeState ?? {
          phase: "final_completed",
          checkpoint_id: "child-checkpoint",
          messages: [{ role: "assistant", text: "node complete" }],
        },
      };
    } else if (parsed.operation === "conversation.flow.set") {
      result = { checkpoint_id: "projection-checkpoint" };
    } else if (parsed.operation === "event.emit") {
      result = { name: parsed.args.name };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    requests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function startMcp(dataRoot, hostUrl) {
  const child = spawn(process.execPath, [mcpScript], {
    cwd: packageRoot,
    env: {
      ...process.env,
      PLUGIN_DATA: dataRoot,
      OPENAGENT_PLUGIN_HOST_URL: hostUrl,
      OPENAGENT_PLUGIN_HOST_TOKEN: "test-token",
      OPENAGENT_PLUGIN_ID: "graph",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  const replies = new Map();
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        const message = JSON.parse(line);
        replies.get(message.id)?.(message);
      }
      newline = buffer.indexOf("\n");
    }
  });
  let nextId = 1;
  const request = (method, params = {}) => {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        replies.delete(id);
        reject(new Error(`MCP request timed out: ${method}`));
      }, 3000);
      replies.set(id, (message) => {
        clearTimeout(timeout);
        replies.delete(id);
        resolve(message);
      });
    });
  };
  await request("initialize", { protocolVersion: "2024-11-05" });
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
  return {
    child,
    callTool: (name, args) => request("tools/call", { name, arguments: args }),
    listTools: () => request("tools/list"),
    stop: () => new Promise((resolve) => {
      child.once("close", resolve);
      child.kill();
    }),
  };
}

async function waitFor(predicate, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("condition did not become true before timeout");
}

describe("Graph MCP package boundary", () => {
  test("formats validation feedback in the live request locale", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-locale-"));
    const host = await startHost();
    const mcp = await startMcp(dataRoot, host.url);
    try {
      const response = await mcp.callTool("create_goal_graph", {
        _openagent: { conversation_id: "parent", branch_id: "branch", locale: "zh" },
        graph: { nodes: [] },
      });
      expect(response.result.isError).toBe(true);
      expect(response.result.content[0].text).toBe("graph.nodes 必须是非空数组");
      expect(host.requests.some((request) => request.operation === "locale.get")).toBe(false);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("starts through node and wakes a child through the generic bridge", async () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "mcp.json"), "utf8"));
    expect(manifest.mcpServers.graph.command).toBe("node");
    expect(manifest.mcpServers.graph.args).toEqual(["${PLUGIN_ROOT}/bin/graph-mcp.mjs"]);

    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-"));
    const host = await startHost();
    const mcp = await startMcp(dataRoot, host.url);
    try {
      const listed = await mcp.listTools();
      expect(listed.result.tools.some((tool) => tool.name === "create_goal_graph")).toBe(true);
      const response = await mcp.callTool("create_goal_graph", {
        _openagent: { conversation_id: "parent", branch_id: "parent-branch" },
        objective: "Run the graph",
        graph: { nodes: [{ id: "one", task: "Do one thing" }] },
      });
      expect(response.result.isError).not.toBe(true);
      await waitFor(() => host.requests.some((request) => request.operation === "agent.wake"));
      const wake = host.requests.find((request) => request.operation === "agent.wake");
      expect((wake.args.request ?? wake.args).branch_id).toBe("child-branch-1");
      expect(host.requests.some((request) => request.operation === "conversation.flow.set")).toBe(true);
      expect(host.requests.some((request) => request.operation === "conversation.create")).toBe(true);
      expect(host.requests.find((request) => request.operation === "conversation.create").args.workspace).toBe("parent-workspace");
      const firstProjection = host.requests.findIndex(
        (request) => request.operation === "conversation.flow.set",
      );
      const firstProjectionEvent = host.requests.findIndex(
        (request) => request.operation === "event.emit" &&
          request.args.name === "plugin-flow-updated",
      );
      expect(firstProjection).toBeGreaterThanOrEqual(0);
      expect(firstProjectionEvent).toBeGreaterThan(firstProjection);
      await waitFor(() => host.requests.some((request) => request.operation === "conversation.flow.set" &&
        request.args.conv_id === "child-1" && request.args.flow.state.status === "completed"));
      const finalProjections = host.requests.filter((request) => request.operation === "conversation.flow.set" &&
        request.args.flow.state.status === "completed");
      expect([...new Set(finalProjections.map((request) => request.args.conv_id))].sort()).toEqual(["child-1", "parent"]);
      for (const request of finalProjections) expect(request.args.flow).toEqual(finalProjections[0].args.flow);
      expect(finalProjections[0].args.flow.state.items[0].status).toBe("completed");
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test.each(["final_completed", "final_failed", "final_cancelled"])(
    "keeps an interrupted child pending until %s, then publishes its actual outcome",
    async (phase) => {
      const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-interrupted-"));
      const interrupted = { phase: "interrupted", checkpoint_id: "approval", messages: [{ role: "assistant", text: "I will research" }] };
      let detail = interrupted;
      const host = await startHost({ wakeState: interrupted, childState: () => detail });
      const mcp = await startMcp(dataRoot, host.url);
      const context = { conversation_id: "parent", branch_id: "parent-branch" };
      try {
        const created = await mcp.callTool("create_goal_graph", {
          _openagent: context, objective: "Wait for the result",
          graph: { nodes: [{ id: "one", task: "Research" }, { id: "two", task: "Use the result", depends_on: ["one"] }] },
        });
        const run = JSON.parse(created.result.content[0].text);
        await waitFor(() => host.requests.some((request) => request.operation === "agent.wake"));
        const pending = await mcp.callTool("graph_read", { _openagent: context, run_id: run.run_id, wait_secs: 0 });
        expect(JSON.parse(pending.result.content[0].text).graph.items.map((item) => item.status)).toEqual(["running", "pending"]);
        detail = { phase, checkpoint_id: "finished", messages: [{ role: "assistant", text: "Actual research result" }] };
        const expected = phase === "final_completed" ? "completed" : "failed";
        await waitFor(() => host.requests.some((request) => request.operation === "conversation.flow.set" &&
          request.args.conv_id === "child-1" && request.args.flow.state.status === expected));
        const terminal = host.requests.filter((request) => request.operation === "conversation.flow.set" &&
          request.args.flow.state.status === expected);
        expect(terminal.find((request) => request.args.conv_id === "parent").args.flow)
          .toEqual(terminal.find((request) => request.args.conv_id === "child-1").args.flow);
        if (phase === "final_completed") expect(terminal[0].args.flow.state.items[0].detail).toBe("Actual research result");
        else expect(host.requests.filter((request) => request.operation === "agent.wake")).toHaveLength(1);
      } finally {
        await mcp.stop();
        await host.close();
        rmSync(dataRoot, { recursive: true, force: true });
      }
    },
  );

  test("cancellation updates the waiting child and never schedules a dependent node", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-cancel-"));
    const interrupted = { phase: "interrupted", checkpoint_id: "approval", messages: [] };
    const host = await startHost({ wakeState: interrupted, childState: () => interrupted });
    const mcp = await startMcp(dataRoot, host.url);
    const context = { conversation_id: "parent", branch_id: "parent-branch" };
    try {
      const response = await mcp.callTool("create_goal_graph", {
        _openagent: context, graph: { nodes: [{ id: "one", task: "Work" }] },
      });
      const { run_id } = JSON.parse(response.result.content[0].text);
      await waitFor(() => host.requests.some((request) => request.operation === "agent.wake"));
      await mcp.callTool("cancel_goal_graph", { _openagent: context, run_id });
      expect(host.requests.some((request) => request.operation === "conversation.flow.set" &&
        request.args.conv_id === "child-1" && request.args.flow.state.status === "cancelled")).toBe(true);
      expect(host.requests.filter((request) => request.operation === "agent.wake")).toHaveLength(1);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("restart republishes terminal state to existing children without waking them", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-recover-"));
    const graph = newGraph("parent", "parent-branch", "Done", [{ id: "one", task: "Work" }]);
    graph.status = "completed";
    Object.assign(graph.nodes[0], { status: "completed", child_conv_id: "child", child_branch_id: "child-branch" });
    writeGraph(dataRoot, graph);
    const host = await startHost();
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await waitFor(() => host.requests.some((request) => request.operation === "conversation.flow.set" && request.args.conv_id === "child"));
      expect(host.requests.filter((request) => request.operation === "agent.wake")).toEqual([]);
      expect(host.requests.find((request) => request.operation === "conversation.flow.set" && request.args.conv_id === "child").args.flow.state.status).toBe("completed");
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test("restart keeps an interrupted child and collects its resumed result without a duplicate wake", async () => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-resume-"));
    const graph = newGraph("parent", "parent-branch", "Resume", [{ id: "one", task: "Work" }]);
    Object.assign(graph.nodes[0], { status: "running", started: true, child_conv_id: "existing-child", child_branch_id: "existing-branch" });
    writeGraph(dataRoot, graph);
    let detail = { phase: "interrupted", checkpoint_id: "approval", messages: [{ role: "assistant", text: "Planning" }] };
    const host = await startHost({ childState: () => detail });
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await waitFor(() => host.requests.filter((request) => request.operation === "conversation.state").length >= 3);
      expect(host.requests.filter((request) => ["conversation.cancel", "conversation.create", "agent.wake"].includes(request.operation))).toEqual([]);
      detail = { phase: "final_completed", checkpoint_id: "finished", messages: [{ role: "assistant", text: "Resumed result" }] };
      await waitFor(() => host.requests.some((request) => request.operation === "conversation.flow.set" &&
        request.args.conv_id === "existing-child" && request.args.flow.state.status === "completed"));
      const flow = host.requests.find((request) => request.operation === "conversation.flow.set" && request.args.flow.state.status === "completed").args.flow;
      expect(flow.state.items[0].detail).toBe("Resumed result");
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });

  test.each(["final_failed", "final_cancelled"])("restart preserves a child %s outcome without retrying it", async (phase) => {
    const dataRoot = mkdtempSync(path.join(tmpdir(), "openagent-graph-recover-failed-"));
    const graph = newGraph("parent", "parent-branch", "Recover failure", [{ id: "one", task: "Work" }]);
    Object.assign(graph.nodes[0], { status: "running", started: true, child_conv_id: "existing-child", child_branch_id: "existing-branch" });
    writeGraph(dataRoot, graph);
    const host = await startHost({ childState: () => ({ phase, checkpoint_id: "failed-checkpoint", messages: [] }) });
    const mcp = await startMcp(dataRoot, host.url);
    try {
      await waitFor(() => host.requests.some((request) => request.operation === "conversation.flow.set" &&
        request.args.conv_id === "existing-child" && request.args.flow.state.status === "failed"));
      expect(host.requests.filter((request) => ["conversation.create", "conversation.cancel", "agent.wake"].includes(request.operation))).toEqual([]);
      const saved = readGraph(dataRoot, graph.conversation_id, graph.branch_id);
      expect(saved.nodes[0].child_checkpoint_id).toBe("failed-checkpoint");
      expect(saved.nodes[0].result).toContain(phase);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
