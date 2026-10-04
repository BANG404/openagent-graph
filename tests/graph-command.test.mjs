import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { newGraph, readGraph, writeGraph } from "../bin/graph-state.mjs";

const commandScript = path.resolve(import.meta.dirname, "../bin/graph-command.mjs");

function command(input, environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [commandScript], {
      env: { ...process.env, ...environment },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

describe("Graph slash-command startup", () => {
  test("does not publish a phantom run or overwrite an existing branch projection", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openagent-graph-command-"));
    const requests = [];
    const server = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      requests.push(JSON.parse(body));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, result: {} }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const environment = {
        PLUGIN_DATA: root,
        OPENAGENT_PLUGIN_ID: "graph",
        OPENAGENT_PLUGIN_HOST_URL: `http://127.0.0.1:${server.address().port}`,
        OPENAGENT_PLUGIN_HOST_TOKEN: "test-token",
      };
      const objective = "最近的 agent 研究";
      const input = { conversation_id: "parent", branch_id: "branch", argument: objective };
      const initial = await command(input, environment);
      expect(initial.code).toBe(0);
      expect(initial.stderr).toBe("");
      expect(initial.stdout).toContain(objective);
      expect(initial.stdout).toContain("call create_goal_graph in this turn");
      expect(initial.stdout).toContain(JSON.stringify({ objective, graph: { nodes: [{ id: "research", task: "Perform the requested research", depends_on: [] }] } }));
      expect(readdirSync(root)).toEqual([]);

      const existing = newGraph("parent", "branch", "Previous objective", [{ id: "one", task: "Done" }]);
      existing.status = "completed";
      existing.nodes[0].status = "completed";
      writeGraph(root, existing);
      const before = readGraph(root, "parent", "branch");
      const subsequent = await command(input, environment);
      expect(subsequent.code).toBe(0);
      expect(readGraph(root, "parent", "branch")).toEqual(before);
      expect(requests).toEqual([]);
    } finally {
      await new Promise((resolve) => server.close(resolve));
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an empty objective instead of producing a startup prompt", async () => {
    const result = await command({ conversation_id: "parent", argument: " " }, {});
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("conversation_id and argument are required");
  });
});
