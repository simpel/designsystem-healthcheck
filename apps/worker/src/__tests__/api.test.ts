import {
  env,
  createExecutionContext,
  waitOnExecutionContext,
  fetchMock,
} from "cloudflare:test";
import { drizzle } from "drizzle-orm/d1";
import { desc } from "drizzle-orm";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import worker from "../index";
import { audits } from "../schema";

const BASE = "http://localhost";

function getDb() {
  return drizzle(env.DB);
}

async function request(
  path: string,
  options?: RequestInit
): Promise<Response> {
  const req = new Request(`${BASE}${path}`, options);
  const ctx = createExecutionContext();
  const resp = await worker.fetch(req, env, ctx);
  await waitOnExecutionContext(ctx);
  return resp;
}

async function jsonBody(resp: Response) {
  return resp.json() as Promise<Record<string, unknown>>;
}

async function setupDB() {
  await env.DB.exec("CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, figma_user_id TEXT NOT NULL UNIQUE, figma_user_name TEXT NOT NULL, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')))");
  await env.DB.exec("CREATE TABLE IF NOT EXISTS audits (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), timestamp TEXT NOT NULL DEFAULT (datetime('now')), collections_count INTEGER NOT NULL DEFAULT 0, variables_count INTEGER NOT NULL DEFAULT 0, violations_count INTEGER NOT NULL DEFAULT 0, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, violations_json TEXT NOT NULL DEFAULT '[]', audit_group_id TEXT, collection_name TEXT)");
}

async function teardownDB() {
  await env.DB.exec("DROP TABLE IF EXISTS audits");
  await env.DB.exec("DROP TABLE IF EXISTS users");
}

async function registerUser(
  figmaUserId = "user-1",
  figmaUserName = "Test User"
): Promise<string> {
  const resp = await request("/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ figmaUserId, figmaUserName }),
  });
  const data = await jsonBody(resp);
  return data.token as string;
}

/** Build a mock SSE stream that Anthropic would return. */
function mockSSEResponse(resultJson: unknown, inputTokens = 500, outputTokens = 200): string {
  const text = JSON.stringify(resultJson);
  return [
    `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: inputTokens } } })}\n\n`,
    `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
    `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: outputTokens } })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  ].join("");
}

// ─── Routing ────────────────────────────────────────────────────────

describe("routing", () => {
  it("OPTIONS returns 204 with CORS headers", async () => {
    const resp = await request("/anything", { method: "OPTIONS" });
    expect(resp.status).toBe(204);
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(resp.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("GET returns 405", async () => {
    const resp = await request("/register", { method: "GET" });
    expect(resp.status).toBe(405);
  });

  it("unknown route returns 404", async () => {
    const resp = await request("/nonexistent", { method: "POST" });
    expect(resp.status).toBe(404);
  });

  it("all responses include CORS headers", async () => {
    const resp = await request("/nonexistent", { method: "POST" });
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

// ─── Registration ───────────────────────────────────────────────────

describe("POST /register", () => {
  beforeEach(setupDB);
  afterEach(teardownDB);

  it("creates a new user and returns a token", async () => {
    const resp = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ figmaUserId: "user-1", figmaUserName: "Alice" }),
    });
    expect(resp.status).toBe(201);
    const data = await jsonBody(resp);
    expect(data.token).toBeDefined();
    expect(typeof data.token).toBe("string");
  });

  it("is idempotent — same user gets same token", async () => {
    const token1 = await registerUser("user-2", "Bob");
    const token2 = await registerUser("user-2", "Bob");
    expect(token1).toBe(token2);
  });

  it("different users get different tokens", async () => {
    const token1 = await registerUser("user-a", "Alice");
    const token2 = await registerUser("user-b", "Bob");
    expect(token1).not.toBe(token2);
  });

  it("returns 400 for missing figmaUserId", async () => {
    const resp = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ figmaUserName: "Alice" }),
    });
    expect(resp.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const resp = await request("/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    expect(resp.status).toBe(400);
  });
});

// ─── Audit auth (shared across all /audit/* routes) ────────────────

describe("audit auth", () => {
  beforeEach(setupDB);
  afterEach(teardownDB);

  const auditRoutes = ["/audit/primitives", "/audit/themes", "/audit/components", "/audit/generic", "/audit/fix"];

  for (const route of auditRoutes) {
    it(`${route} returns 401 with no Authorization header`, async () => {
      const resp = await request(route, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      expect(resp.status).toBe(401);
    });

    it(`${route} returns 401 with invalid token`, async () => {
      const resp = await request(route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer invalid-token",
        },
        body: "{}",
      });
      expect(resp.status).toBe(401);
    });
  }
});

// ─── Collection audit streaming ────────────────────────────────────

describe("POST /audit/primitives — streaming proxy", () => {
  beforeEach(async () => {
    await setupDB();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(async () => {
    // Allow background completion handlers (D1 logging) to finish
    await new Promise((r) => setTimeout(r, 200));
    fetchMock.deactivate();
    await teardownDB();
  });

  const MOCK_VIOLATIONS = {
    summary: { total_variables: 10, total_violations: 1 },
    violations: [
      {
        collection: "primitives",
        variable_id: "VariableID:1:1",
        variable: "color/brand/500",
        rule: "No semantic meaning in primitives",
        explanation: "brand implies usage context",
        options: [
          { name: "color/blue/500", description: "Matches the existing blue scale" },
        ],
      },
    ],
  };

  it("returns SSE stream with correct content type", async () => {
    const token = await registerUser();
    const sseBody = mockSSEResponse(MOCK_VIOLATIONS);

    fetchMock
      .get("https://gateway.ai.cloudflare.com")
      .intercept({ path: /.*/, method: "POST" })
      .reply(200, sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      });

    const resp = await request("/audit/primitives", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        collectionData: { name: "primitives", modes: ["default"], variables: [] },
        auditGroupId: "test-group-1",
        variablesCount: 10,
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");
    expect(resp.headers.get("Access-Control-Allow-Origin")).toBe("*");

    // Read full stream
    const text = await resp.text();
    expect(text).toContain("content_block_delta");
    expect(text).toContain("color/brand/500");
  });

  it("logs audit to D1 after stream completes", async () => {
    const token = await registerUser("logger-test", "Logger");
    const sseBody = mockSSEResponse(MOCK_VIOLATIONS, 500, 200);

    fetchMock
      .get("https://gateway.ai.cloudflare.com")
      .intercept({ path: /.*/, method: "POST" })
      .reply(200, sseBody, {
        headers: { "Content-Type": "text/event-stream" },
      });

    await request("/audit/primitives", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        collectionData: { name: "primitives", modes: ["default"], variables: [] },
        auditGroupId: "group-123",
        variablesCount: 10,
      }),
    });

    // Give async logging time to complete
    await new Promise((r) => setTimeout(r, 100));

    const db = getDb();
    const audit = await db
      .select()
      .from(audits)
      .orderBy(desc(audits.id))
      .get();

    expect(audit).toBeDefined();
    expect(audit!.collectionName).toBe("primitives");
    expect(audit!.auditGroupId).toBe("group-123");
    expect(audit!.violationsCount).toBe(1);
  });
});

// ─── Fix endpoint ──────────────────────────────────────────────────

describe("POST /audit/fix — streaming", () => {
  beforeEach(async () => {
    await setupDB();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 200));
    fetchMock.deactivate();
    await teardownDB();
  });

  it("returns SSE stream with fix suggestions", async () => {
    const token = await registerUser();
    const mockFixes = {
      fixes: [
        {
          action: "rename-collection",
          description: "Rename 'Tokens' to 'primitives'",
          params: { collectionId: "col:1", newName: "primitives" },
        },
      ],
    };

    fetchMock
      .get("https://gateway.ai.cloudflare.com")
      .intercept({ path: /.*/, method: "POST" })
      .reply(200, mockSSEResponse(mockFixes), {
        headers: { "Content-Type": "text/event-stream" },
      });

    const resp = await request("/audit/fix", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        collectionStructure: [{ name: "Tokens", id: "col:1", variableCount: 5 }],
        auditGroupId: "fix-group-1",
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("rename-collection");
  });
});

// ─── Generic audit ─────────────────────────────────────────────────

describe("POST /audit/generic — streaming", () => {
  beforeEach(async () => {
    await setupDB();
    fetchMock.activate();
    fetchMock.disableNetConnect();
  });

  afterEach(async () => {
    await new Promise((r) => setTimeout(r, 200));
    fetchMock.deactivate();
    await teardownDB();
  });

  it("returns SSE stream with violations", async () => {
    const token = await registerUser();
    const mockResult = {
      summary: { total_variables: 20, total_violations: 2 },
      violations: [
        {
          collection: "primitives",
          variable_id: "VariableID:1:1",
          variable: "color/brand/500",
          rule: "No semantic meaning",
          explanation: "brand implies usage",
          options: [
            { name: "color/blue/500", description: "Matches the existing blue scale" },
          ],
        },
        {
          collection: "themes",
          variable_id: "VariableID:2:1",
          variable: "red/500",
          rule: "Not semantic",
          explanation: "raw color name",
          options: [
            { name: "feedback/error/bg", description: "Follows semantic naming" },
            { name: "feedback/danger/bg", description: "Alternative semantic name" },
          ],
        },
      ],
    };

    fetchMock
      .get("https://gateway.ai.cloudflare.com")
      .intercept({ path: /.*/, method: "POST" })
      .reply(200, mockSSEResponse(mockResult), {
        headers: { "Content-Type": "text/event-stream" },
      });

    const resp = await request("/audit/generic", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        variableData: { collections: [] },
        auditGroupId: "generic-group-1",
        variablesCount: 20,
      }),
    });

    expect(resp.status).toBe(200);
    expect(resp.headers.get("Content-Type")).toBe("text/event-stream");

    const text = await resp.text();
    expect(text).toContain("color/brand/500");
    expect(text).toContain("red/500");
  });
});
