import { createServer } from "node:http";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const packageRoot = path.resolve(import.meta.dirname, "..");
const mcpScript = path.join(packageRoot, "bin", "graph-mcp.mjs");

async function startHost() {
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
      result = { branch_id: parsed.args.branch_id ?? null, workspace: "" };
    } else if (parsed.operation === "agent.wake") {
      result = {
        accepted: true,
        state: {
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
      expect(wake.args.request.branch_id).toBe("child-branch-1");
      expect(host.requests.some((request) => request.operation === "conversation.flow.set")).toBe(true);
      expect(host.requests.some((request) => request.operation === "conversation.create")).toBe(true);
      const firstProjection = host.requests.findIndex(
        (request) => request.operation === "conversation.flow.set",
      );
      const firstProjectionEvent = host.requests.findIndex(
        (request) => request.operation === "event.emit" &&
          request.args.name === "plugin-flow-updated",
      );
      expect(firstProjection).toBeGreaterThanOrEqual(0);
      expect(firstProjectionEvent).toBeGreaterThan(firstProjection);
    } finally {
      await mcp.stop();
      await host.close();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
