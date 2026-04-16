# Multi-Agent Streaming Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the monolithic single-call audit with a multi-agent streaming architecture that gives users real-time progress feedback and fail-fast architecture validation.

**Architecture:** Client-side orchestrator validates architecture (3 collections, correct names), then dispatches 3 parallel streaming LLM requests (one per collection with specialized prompts). If architecture fails, user gets fix suggestions from an LLM or can run a generic full audit. System prompts move from client to worker. Worker pipes SSE streams with CORS headers.

**Tech Stack:** Cloudflare Workers (streaming responses), Anthropic SSE streaming API, Figma Plugin API, D1 SQLite, Drizzle ORM.

---

## File Structure

### Worker (`apps/worker/src/`)

| File | Responsibility |
|------|---------------|
| `index.ts` | Route dispatch, auth middleware, CORS — modified to add new routes and streaming |
| `schema.ts` | D1 schema — modified to add `audit_group_id` column |
| `prompts.ts` | **New** — all system prompts (primitives, themes, components, generic, fix) and JSON schemas |
| `stream.ts` | **New** — streaming proxy logic: forwards to Anthropic with `stream: true`, pipes SSE back, accumulates response for logging |
| `audit-logger.ts` | **New** — D1 audit logging extracted from inline code, supports `audit_group_id` |
| `__tests__/api.test.ts` | Tests — modified to cover new routes and streaming |

### Figma Plugin (`apps/figma-plugin/`)

| File | Responsibility |
|------|---------------|
| `ui.html` | UI — rewritten audit flow: orchestrator, progress slots, architecture failure view, fix view |
| `code.ts` | Plugin sandbox — new message handlers for collection/variable operations |

### Migration

| File | Responsibility |
|------|---------------|
| `apps/worker/migrations/0002_add_audit_group_id.sql` | Adds `audit_group_id` and `collection_name` columns to `audits` table |

---

## Task 1: Extract system prompts to `prompts.ts`

**Files:**
- Create: `apps/worker/src/prompts.ts`
- Modify: `apps/worker/src/index.ts`

- [ ] **Step 1: Create `prompts.ts` with all prompts and schemas**

```typescript
// apps/worker/src/prompts.ts

// ─── Primitives prompt ──────────────────────────────────────────────
export const PRIMITIVES_SYSTEM_PROMPT = `You are a Figma variable auditor for the PRIMITIVES collection.

Golden rule: a primitive name must never imply how, where, or why a value is used. If you can tell from the name how or where something will be used, it is a violation.

Structure: two or three lowercase segments separated by "/".
- Two segments: category/scale
- Three segments: category/variant/scale

Category: must describe a raw value type (color, spacing, radius, font-size, opacity, shadow, border-width, line-height, font-weight). Flag any category that implies a role, component, or usage context.

Variant (if present): must be a neutral descriptor with no semantic meaning. Words like "brand", "danger", "primary", "button", "default" are violations.

Scale: must be a t-shirt size (xs, sm, md, lg, xl, 2xl, 3xl…) or a direct numeric value (4, 13, 500, 1.5…). Descriptive words like "large", "heavy", "dark", "light" are violations.

Aliasing: primitives must have raw hardcoded values. A primitive where aliasId is not null is a violation.

Consistency: identify the dominant pattern across the collection and flag any variable that deviates from it in structure or naming style.

Unused variables: you will receive a list of "unreferenced" primitive variable names — these are not aliased by any theme variable. Flag each as a violation with rule "Unused variable" and suggest removal.

Always include the variable's id field in each violation so it can be used to apply fixes programmatically.

Every violation must have:
- collection: "primitives"
- variable_id: the variable's id string
- variable: the full variable name
- rule: short label
- explanation: one specific sentence explaining exactly what is wrong and why
- suggestion: a concrete corrected name or action`;

// ─── Themes prompt ──────────────────────────────────────────────────
export const THEMES_SYSTEM_PROMPT = `You are a Figma variable auditor for the THEMES collection.

Golden rule: every theme variable must imply usage — it must answer "how or where is this used?"

Mode names: all lowercase, single word or hyphenated, no spaces. A file with one mode must name it "default". Flag violations.

Variable names: must be semantic. Flag any name that looks like a primitive — contains a raw colour name, a numeric scale, or describes a raw value rather than a usage context.

Aliasing: every theme variable must alias a primitive. You will receive a list of valid primitive variable names. A hardcoded value (aliasId is null) is a violation. An alias pointing to a variable NOT in the primitives list is a violation.

Consistency: identify the dominant segment depth and style and flag deviations.

Unused variables: you will receive a list of "unreferenced" theme variable names — these are not aliased by any component variable. Flag each as a violation with rule "Unused variable" and suggest removal.

Always include the variable's id field in each violation.

Every violation must have:
- collection: "themes"
- variable_id: the variable's id string
- variable: the full variable name
- rule: short label
- explanation: one specific sentence explaining exactly what is wrong and why
- suggestion: a concrete corrected name or action`;

// ─── Components prompt ──────────────────────────────────────────────
export const COMPONENTS_SYSTEM_PROMPT = `You are a Figma variable auditor for the COMPONENTS collection.

Golden rule: every variable must be traceable to a specific component, a specific property, and a specific state.

Structure: component/property/state or component/element/property/state.

Component name: the first segment must match a real component name in the design system, lowercase. Flag abbreviations or capitalisation differences.

Aliasing: component variables must alias a theme variable. You will receive a list of valid theme variable names. Aliasing a primitive directly is a violation. A hardcoded value is a violation. An alias pointing to a variable NOT in the themes list is a violation.

Mode names: only t-shirt sizes allowed (xs, sm, md, lg, xl, 2xl…), lowercase. Flag any descriptive mode names.

States: check each component's variable set against common interaction states: default, hover, focus, active, disabled, error, loading, selected, pressed, visited. Flag missing states that would be expected for the component type. Check consistency — if most interactive components define hover, flag any that do not.

Always include the variable's id field in each violation.

Every violation must have:
- collection: "components"
- variable_id: the variable's id string
- variable: the full variable name
- rule: short label
- explanation: one specific sentence explaining exactly what is wrong and why
- suggestion: a concrete corrected name or action`;

// ─── Generic prompt (full monolithic audit) ─────────────────────────
export const GENERIC_SYSTEM_PROMPT = `You are a Figma variable architecture auditor. You receive a structured JSON object containing all variable collections from a Figma file, including each variable's id, name, type, and whether its value is aliased or hardcoded. You must audit every collection and every variable against the rules below and return only violations — do not mention passing variables.

Always include the variable's id field in each violation so it can be used to apply fixes programmatically.

**Collection: primitives (if present)**

Golden rule: a primitive name must never imply how, where, or why a value is used.

Structure: two or three lowercase segments separated by "/".
- Two segments: category/scale
- Three segments: category/variant/scale

Category: must describe a raw value type (color, spacing, radius, font-size, opacity, shadow, border-width, line-height, font-weight). Flag any category that implies a role, component, or usage context.

Variant (if present): must be a neutral descriptor with no semantic meaning. Words like "brand", "danger", "primary", "button", "default" are violations.

Scale: must be a t-shirt size (xs, sm, md, lg, xl, 2xl, 3xl…) or a direct numeric value (4, 13, 500, 1.5…). Descriptive words like "large", "heavy", "dark", "light" are violations.

Aliasing: primitives must have raw hardcoded values. A primitive where aliasId is not null is a violation.

**Collection: themes (if present)**

Golden rule: every theme variable must imply usage.

Mode names: all lowercase, single word or hyphenated, no spaces.

Variable names: must be semantic. Flag any name that looks like a primitive.

Aliasing: every theme variable must alias a primitive. A hardcoded value is a violation.

**Collection: components (if present)**

Golden rule: every variable must be traceable to a specific component, property, and state.

Structure: component/property/state or component/element/property/state.

Aliasing: component variables must alias a theme variable. Aliasing a primitive directly is a violation.

Mode names: only t-shirt sizes allowed (xs, sm, md, lg, xl, 2xl…).

**For all collections present:** identify the dominant naming pattern and flag deviations. Flag unused variables where possible.

Every violation must have:
- collection: the collection name
- variable_id: the variable's id string (empty string for architecture-level violations)
- variable: the full variable name or collection name
- rule: short label
- explanation: one specific sentence explaining exactly what is wrong and why
- suggestion: a concrete corrected name or action`;

// ─── Fix prompt ─────────────────────────────────────────────────────
export const FIX_SYSTEM_PROMPT = `You are a Figma variable architecture advisor. The user's file has architecture violations — the expected structure is exactly three collections: "primitives", "themes", "components" (all lowercase).

You will receive the current collection structure (names, variable counts, and variable names with their types). Analyze the issues and suggest concrete fixes.

Available fix actions:
- rename-collection: rename a collection (provide collectionId and newName)
- move-variables: move variables from one collection to another (provide variableIds and targetCollectionId)
- create-collection: create a new empty collection (provide name)
- delete-collection: delete a collection (provide collectionId)
- delete-variable: remove a variable (provide variableId)

For each fix, provide:
- action: one of the action types above
- description: human-readable explanation of what this fix does
- params: the parameters needed (use the exact IDs provided in the input)

Order fixes logically — create collections before moving variables into them. Be specific about which variables should move where based on their names and types.`;

// ─── JSON schemas ───────────────────────────────────────────────────
export const VIOLATIONS_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["summary", "violations"],
    properties: {
      summary: {
        type: "object",
        additionalProperties: false,
        required: ["total_variables", "total_violations"],
        properties: {
          total_variables: { type: "number" },
          total_violations: { type: "number" },
        },
      },
      violations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["collection", "variable_id", "variable", "rule", "explanation", "suggestion"],
          properties: {
            collection: { type: "string" },
            variable_id: { type: "string" },
            variable: { type: "string" },
            rule: { type: "string" },
            explanation: { type: "string" },
            suggestion: { type: "string" },
          },
        },
      },
    },
  },
};

export const FIX_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["fixes"],
    properties: {
      fixes: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["action", "description", "params"],
          properties: {
            action: { type: "string" },
            description: { type: "string" },
            params: {
              type: "object",
              additionalProperties: true,
            },
          },
        },
      },
    },
  },
};
```

- [ ] **Step 2: Verify file compiles**

Run: `cd apps/worker && npx tsc --noEmit src/prompts.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/prompts.ts
git commit -m "feat: extract system prompts and schemas to prompts.ts"
```

---

## Task 2: Create streaming proxy utility `stream.ts`

**Files:**
- Create: `apps/worker/src/stream.ts`

- [ ] **Step 1: Create `stream.ts`**

This module handles: forwarding requests to Anthropic with `stream: true`, piping the SSE stream back to the client with CORS headers, and accumulating the final response text for audit logging.

```typescript
// apps/worker/src/stream.ts

interface StreamProxyOptions {
  gatewayUrl: string;
  apiKey: string;
  aigToken: string;
  model: string;
  maxTokens: number;
  systemPrompt: string;
  userMessage: string;
  outputSchema: unknown;
  corsHeaders: Record<string, string>;
}

interface StreamResult {
  response: Response;
  /** Resolves with the accumulated text and usage after the stream ends. */
  completion: Promise<{
    text: string;
    inputTokens: number;
    outputTokens: number;
  }>;
}

export function createStreamingProxy(options: StreamProxyOptions): StreamResult {
  const {
    gatewayUrl,
    apiKey,
    aigToken,
    model,
    maxTokens,
    systemPrompt,
    userMessage,
    outputSchema,
    corsHeaders,
  } = options;

  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    stream: true,
    system: systemPrompt,
    messages: [{ role: "user", content: userMessage }],
    output_config: { format: outputSchema },
  });

  let resolveCompletion: (value: { text: string; inputTokens: number; outputTokens: number }) => void;
  let rejectCompletion: (err: Error) => void;
  const completion = new Promise<{ text: string; inputTokens: number; outputTokens: number }>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  const readable = new ReadableStream({
    async start(controller) {
      try {
        const resp = await fetch(gatewayUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "structured-outputs-2025-11-13",
            "cf-aig-authorization": `Bearer ${aigToken}`,
          },
          body,
        });

        if (!resp.ok || !resp.body) {
          const errText = await resp.text();
          controller.enqueue(new TextEncoder().encode(`event: error\ndata: ${JSON.stringify({ status: resp.status, error: errText })}\n\n`));
          controller.close();
          rejectCompletion!(new Error(`Anthropic ${resp.status}: ${errText.slice(0, 200)}`));
          return;
        }

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let accumulatedText = "";
        let inputTokens = 0;
        let outputTokens = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          // Forward raw SSE chunk to client
          controller.enqueue(value);

          // Parse SSE events from chunk to accumulate text
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6);
            if (data === "[DONE]") continue;
            try {
              const event = JSON.parse(data);
              if (event.type === "content_block_delta" && event.delta?.text) {
                accumulatedText += event.delta.text;
              }
              if (event.type === "message_delta" && event.usage) {
                outputTokens = event.usage.output_tokens ?? outputTokens;
              }
              if (event.type === "message_start" && event.message?.usage) {
                inputTokens = event.message.usage.input_tokens ?? inputTokens;
              }
            } catch {
              // Not all lines are JSON — ignore
            }
          }
        }

        controller.close();
        resolveCompletion!({ text: accumulatedText, inputTokens, outputTokens });
      } catch (err) {
        controller.error(err);
        rejectCompletion!(err instanceof Error ? err : new Error(String(err)));
      }
    },
  });

  const response = new Response(readable, {
    headers: {
      ...corsHeaders,
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });

  return { response, completion };
}
```

- [ ] **Step 2: Verify file compiles**

Run: `cd apps/worker && npx tsc --noEmit src/stream.ts`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/stream.ts
git commit -m "feat: add streaming proxy utility for SSE piping"
```

---

## Task 3: Create audit logger `audit-logger.ts` and migration

**Files:**
- Create: `apps/worker/src/audit-logger.ts`
- Modify: `apps/worker/src/schema.ts`
- Create: `apps/worker/migrations/0002_add_audit_group_id.sql`

- [ ] **Step 1: Add migration for `audit_group_id` and `collection_name`**

```sql
-- apps/worker/migrations/0002_add_audit_group_id.sql
ALTER TABLE audits ADD COLUMN audit_group_id TEXT;
ALTER TABLE audits ADD COLUMN collection_name TEXT;
```

- [ ] **Step 2: Update `schema.ts` with new columns**

Add these two fields after `violationsJson` in the `audits` table definition in `apps/worker/src/schema.ts`:

```typescript
    auditGroupId: text("audit_group_id"),
    collectionName: text("collection_name"),
```

- [ ] **Step 3: Create `audit-logger.ts`**

```typescript
// apps/worker/src/audit-logger.ts
import { drizzle } from "drizzle-orm/d1";
import { audits } from "./schema";

interface AuditLogEntry {
  userId: number;
  auditGroupId: string;
  collectionName: string;
  variablesCount: number;
  violationsCount: number;
  inputTokens: number;
  outputTokens: number;
  violationsJson: string;
}

/** Best-effort audit logging — never throws. */
export async function logAudit(db: D1Database, entry: AuditLogEntry): Promise<void> {
  try {
    const orm = drizzle(db);
    await orm.insert(audits).values({
      userId: entry.userId,
      auditGroupId: entry.auditGroupId,
      collectionName: entry.collectionName,
      collectionsCount: 1,
      variablesCount: entry.variablesCount,
      violationsCount: entry.violationsCount,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      violationsJson: entry.violationsJson,
    });
  } catch {
    // Best-effort — don't break the response
  }
}
```

- [ ] **Step 4: Verify compilation**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/migrations/0002_add_audit_group_id.sql apps/worker/src/schema.ts apps/worker/src/audit-logger.ts
git commit -m "feat: add audit logger with group ID and collection name tracking"
```

---

## Task 4: Rewrite worker `index.ts` with new routes

**Files:**
- Modify: `apps/worker/src/index.ts`

This is the biggest task. The worker gets 5 new routes replacing the old `/audit` route. All share auth logic and use the streaming proxy.

- [ ] **Step 1: Rewrite `index.ts`**

```typescript
// apps/worker/src/index.ts
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users } from "./schema";
import { createStreamingProxy } from "./stream";
import { logAudit } from "./audit-logger";
import {
  PRIMITIVES_SYSTEM_PROMPT,
  THEMES_SYSTEM_PROMPT,
  COMPONENTS_SYSTEM_PROMPT,
  GENERIC_SYSTEM_PROMPT,
  FIX_SYSTEM_PROMPT,
  VIOLATIONS_SCHEMA,
  FIX_SCHEMA,
} from "./prompts";

interface Env {
  ANTHROPIC_API_KEY: string;
  CF_AIG_TOKEN: string;
  CF_ACCOUNT_ID: string;
  CF_GATEWAY_ID: string;
  DB: D1Database;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Audit-Group-Id",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function authenticate(request: Request, env: Env): Promise<{ userId: number } | Response> {
  const auth = request.headers.get("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401);
  }
  const token = auth.slice(7);
  const db = drizzle(env.DB);
  const user = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.token, token))
    .get();
  if (!user) {
    return json({ error: "Unauthorized" }, 401);
  }
  return { userId: user.id };
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  let body: { figmaUserId?: string; figmaUserName?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const { figmaUserId, figmaUserName } = body;
  if (!figmaUserId || !figmaUserName) {
    return json({ error: "figmaUserId and figmaUserName are required" }, 400);
  }

  const db = drizzle(env.DB);
  const existing = await db
    .select({ token: users.token })
    .from(users)
    .where(eq(users.figmaUserId, figmaUserId))
    .get();

  if (existing) {
    return json({ token: existing.token });
  }

  const token = crypto.randomUUID();
  await db.insert(users).values({ figmaUserId, figmaUserName, token });
  return json({ token }, 201);
}

interface AuditRequestBody {
  model: string;
  collectionData: unknown;
  referenceNames?: string[];
  unreferencedNames?: string[];
  auditGroupId: string;
  variablesCount: number;
}

function getGatewayUrl(env: Env): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/anthropic/v1/messages`;
}

async function handleCollectionAudit(
  request: Request,
  env: Env,
  collectionName: string,
  systemPrompt: string,
): Promise<Response> {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) return authResult;

  let body: AuditRequestBody;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  let userContent = `Audit the following Figma "${collectionName}" collection data:\n\n${JSON.stringify(body.collectionData, null, 2)}`;

  if (body.referenceNames && body.referenceNames.length > 0) {
    const refSource = collectionName === "themes" ? "primitives" : "themes";
    userContent += `\n\nValid reference variable names (from the ${refSource} collection):\n${JSON.stringify(body.referenceNames)}`;
  }

  if (body.unreferencedNames && body.unreferencedNames.length > 0) {
    userContent += `\n\nUnreferenced ${collectionName} variables (not aliased by any downstream collection):\n${JSON.stringify(body.unreferencedNames)}`;
  }

  const { response, completion } = createStreamingProxy({
    gatewayUrl: getGatewayUrl(env),
    apiKey: env.ANTHROPIC_API_KEY,
    aigToken: env.CF_AIG_TOKEN,
    model: body.model || "claude-sonnet-4-5",
    maxTokens: 8192,
    systemPrompt,
    userMessage: userContent,
    outputSchema: VIOLATIONS_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  // Log audit after stream completes (non-blocking)
  completion.then(async ({ text, inputTokens, outputTokens }) => {
    try {
      const parsed = JSON.parse(text);
      await logAudit(env.DB, {
        userId: authResult.userId,
        auditGroupId: body.auditGroupId,
        collectionName,
        variablesCount: body.variablesCount,
        violationsCount: parsed.summary?.total_violations ?? 0,
        inputTokens,
        outputTokens,
        violationsJson: JSON.stringify(parsed.violations ?? []),
      });
    } catch {
      // Best-effort logging
    }
  }).catch(() => {});

  return response;
}

async function handleFix(request: Request, env: Env): Promise<Response> {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) return authResult;

  let body: { model: string; collectionStructure: unknown; auditGroupId: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const userContent = `Analyze the following Figma file structure and suggest fixes to achieve the correct architecture (exactly 3 collections: primitives, themes, components):\n\n${JSON.stringify(body.collectionStructure, null, 2)}`;

  const { response } = createStreamingProxy({
    gatewayUrl: getGatewayUrl(env),
    apiKey: env.ANTHROPIC_API_KEY,
    aigToken: env.CF_AIG_TOKEN,
    model: body.model || "claude-sonnet-4-5",
    maxTokens: 4096,
    systemPrompt: FIX_SYSTEM_PROMPT,
    userMessage: userContent,
    outputSchema: FIX_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  return response;
}

async function handleGeneric(request: Request, env: Env): Promise<Response> {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) return authResult;

  let body: { model: string; variableData: unknown; auditGroupId: string; variablesCount: number };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const userContent = `Audit the following Figma variable data:\n\n${JSON.stringify(body.variableData, null, 2)}`;

  const { response, completion } = createStreamingProxy({
    gatewayUrl: getGatewayUrl(env),
    apiKey: env.ANTHROPIC_API_KEY,
    aigToken: env.CF_AIG_TOKEN,
    model: body.model || "claude-sonnet-4-5",
    maxTokens: 8192,
    systemPrompt: GENERIC_SYSTEM_PROMPT,
    userMessage: userContent,
    outputSchema: VIOLATIONS_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  completion.then(async ({ text, inputTokens, outputTokens }) => {
    try {
      const parsed = JSON.parse(text);
      await logAudit(env.DB, {
        userId: authResult.userId,
        auditGroupId: body.auditGroupId,
        collectionName: "generic",
        variablesCount: body.variablesCount,
        violationsCount: parsed.summary?.total_violations ?? 0,
        inputTokens,
        outputTokens,
        violationsJson: JSON.stringify(parsed.violations ?? []),
      });
    } catch {
      // Best-effort logging
    }
  }).catch(() => {});

  return response;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(request.url);

      if (request.method !== "POST") {
        return json({ error: "Method not allowed" }, 405);
      }

      switch (url.pathname) {
        case "/register":
          return handleRegister(request, env);
        case "/audit/primitives":
          return handleCollectionAudit(request, env, "primitives", PRIMITIVES_SYSTEM_PROMPT);
        case "/audit/themes":
          return handleCollectionAudit(request, env, "themes", THEMES_SYSTEM_PROMPT);
        case "/audit/components":
          return handleCollectionAudit(request, env, "components", COMPONENTS_SYSTEM_PROMPT);
        case "/audit/fix":
          return handleFix(request, env);
        case "/audit/generic":
          return handleGeneric(request, env);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return json({ error: message }, 500);
    }
  },
};
```

- [ ] **Step 2: Verify compilation**

Run: `cd apps/worker && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat: rewrite worker with per-collection streaming audit routes"
```

---

## Task 5: Update worker tests

**Files:**
- Modify: `apps/worker/src/__tests__/api.test.ts`

The existing tests cover the old `/audit` route. Update them for the new routes. The responses are now SSE streams instead of JSON.

- [ ] **Step 1: Rewrite `api.test.ts`**

```typescript
// apps/worker/src/__tests__/api.test.ts
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
        suggestion: "color/blue/500",
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
          suggestion: "color/blue/500",
        },
        {
          collection: "themes",
          variable_id: "VariableID:2:1",
          variable: "red/500",
          rule: "Not semantic",
          explanation: "raw color name",
          suggestion: "feedback/error/bg",
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
```

- [ ] **Step 2: Run the tests**

Run: `cd apps/worker && pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/worker/src/__tests__/api.test.ts
git commit -m "test: update worker tests for streaming multi-agent routes"
```

---

## Task 6: Add new message handlers to `code.ts`

**Files:**
- Modify: `apps/figma-plugin/code.ts`

Add handlers for `rename-collection`, `move-variables`, `create-collection`, `delete-collection`, `delete-variable`, and `reload-variables`.

- [ ] **Step 1: Update the message type signature**

Replace the `figma.ui.onmessage` type annotation in `apps/figma-plugin/code.ts:96`:

```typescript
figma.ui.onmessage = async (msg: {
  type: string;
  id?: string;
  newName?: string;
  name?: string;
  message?: string;
  error?: boolean;
  token?: string;
  collectionId?: string;
  targetCollectionId?: string;
  variableIds?: string[];
  variableId?: string;
}) => {
```

- [ ] **Step 2: Add new message handlers**

Add the following after the existing `rename-variable` handler (after line 112) in `apps/figma-plugin/code.ts`:

```typescript
  if (msg.type === "rename-collection" && msg.collectionId && msg.newName) {
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const collection = collections.find(c => c.id === msg.collectionId);
      if (!collection) {
        figma.ui.postMessage({ type: "fix-error", action: "rename-collection", error: "Collection not found" });
        return;
      }
      collection.name = msg.newName;
      figma.ui.postMessage({ type: "fix-success", action: "rename-collection", collectionId: msg.collectionId, newName: msg.newName });
      figma.notify(`Renamed collection to "${msg.newName}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: "fix-error", action: "rename-collection", error: message });
    }
  }

  if (msg.type === "move-variables" && msg.variableIds && msg.targetCollectionId) {
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const targetCollection = collections.find(c => c.id === msg.targetCollectionId);
      if (!targetCollection) {
        figma.ui.postMessage({ type: "fix-error", action: "move-variables", error: "Target collection not found" });
        return;
      }
      let moved = 0;
      for (const varId of msg.variableIds) {
        const variable = await figma.variables.getVariableByIdAsync(varId);
        if (!variable) continue;

        const sourceCollection = collections.find(c => c.variableIds.includes(varId));
        if (!sourceCollection) continue;

        const newVar = figma.variables.createVariable(variable.name, targetCollection, variable.resolvedType);
        for (const mode of targetCollection.modes) {
          const sourceMode = sourceCollection.modes[0];
          if (sourceMode) {
            const value = variable.valuesByMode[sourceMode.modeId];
            if (value !== undefined) {
              newVar.setValueForMode(mode.modeId, value);
            }
          }
        }
        variable.remove();
        moved++;
      }

      figma.ui.postMessage({ type: "fix-success", action: "move-variables", moved });
      figma.notify(`Moved ${moved} variables`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: "fix-error", action: "move-variables", error: message });
    }
  }

  if (msg.type === "create-collection" && msg.name) {
    try {
      const collection = figma.variables.createVariableCollection(msg.name);
      figma.ui.postMessage({ type: "fix-success", action: "create-collection", collectionId: collection.id, name: msg.name });
      figma.notify(`Created collection "${msg.name}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: "fix-error", action: "create-collection", error: message });
    }
  }

  if (msg.type === "delete-collection" && msg.collectionId) {
    try {
      const collections = await figma.variables.getLocalVariableCollectionsAsync();
      const collection = collections.find(c => c.id === msg.collectionId);
      if (!collection) {
        figma.ui.postMessage({ type: "fix-error", action: "delete-collection", error: "Collection not found" });
        return;
      }
      collection.remove();
      figma.ui.postMessage({ type: "fix-success", action: "delete-collection", collectionId: msg.collectionId });
      figma.notify("Deleted collection", { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: "fix-error", action: "delete-collection", error: message });
    }
  }

  if (msg.type === "delete-variable" && msg.variableId) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(msg.variableId);
      if (!variable) {
        figma.ui.postMessage({ type: "fix-error", action: "delete-variable", error: "Variable not found" });
        return;
      }
      const name = variable.name;
      variable.remove();
      figma.ui.postMessage({ type: "fix-success", action: "delete-variable", variableId: msg.variableId, name });
      figma.notify(`Deleted variable "${name}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({ type: "fix-error", action: "delete-variable", error: message });
    }
  }

  if (msg.type === "reload-variables") {
    await loadVariableData();
  }
```

- [ ] **Step 3: Verify compilation**

Run: `cd apps/figma-plugin && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add apps/figma-plugin/code.ts
git commit -m "feat: add collection and variable management message handlers"
```

---

## Task 7: Rewrite `ui.html` — orchestrator, streaming, and progress UI

**Files:**
- Modify: `apps/figma-plugin/ui.html`

This is the largest UI task. The audit flow is completely rewritten: client-side orchestrator, parallel streaming requests, progress slots, architecture failure view, fix view.

- [ ] **Step 1: Rewrite `ui.html`**

Replace the entire contents of `apps/figma-plugin/ui.html` with the following. Key changes:
- `showView()` helper manages view switching
- `validateArchitecture()` client-side orchestrator
- `computeReferenceMaps()` builds cross-collection context
- `readSSEStream()` consumes SSE and accumulates JSON
- `runParallelAudit()` fires 3 agents in parallel with progress slots
- `showArchitectureFailure()` renders failure UI with Fix/Generic buttons
- `runFixAgent()` streams fix suggestions
- `runGenericAudit()` streams full audit
- `renderFixes()` renders actionable fix list
- Re-run audit button on all result views

```html
<style>
  :root {
    --text-primary: #1A1A1A;
    --text-secondary: #767676;
    --error: #CC0000;
    --success: #1A7A1A;
    --border: rgba(0,0,0,0.12);
  }

  @media (prefers-color-scheme: dark) {
    :root {
      --text-primary: #E8E8E8;
      --text-secondary: #767676;
      --border: rgba(255,255,255,0.1);
    }
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    color: var(--text-primary);
    padding: 16px;
    line-height: 1.4;
  }

  .mono {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Consolas, monospace;
    font-size: 11px;
  }

  .section-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-secondary);
    padding: 12px 0 4px 0;
  }

  .summary { padding-bottom: 12px; font-size: 12px; }

  button.primary-btn {
    width: 100%;
    padding: 8px 0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
    margin-top: 8px;
  }

  button.primary-btn:disabled { cursor: default; opacity: 0.6; }

  .btn-row {
    display: flex;
    gap: 8px;
    margin-top: 8px;
  }

  .btn-row button {
    flex: 1;
    padding: 8px 0;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border);
    background: transparent;
    color: var(--text-primary);
  }

  .btn-row button:disabled { cursor: default; opacity: 0.6; }

  .progress-area { margin-top: 12px; }

  .progress-slot {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    font-size: 11px;
  }

  .progress-slot .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border);
    flex-shrink: 0;
  }

  .progress-slot.streaming .dot { background: var(--text-secondary); animation: pulse 1s infinite; }
  .progress-slot.done .dot { background: var(--success); }
  .progress-slot.error .dot { background: var(--error); }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .progress-slot .label { color: var(--text-secondary); }
  .progress-slot.done .label { color: var(--text-primary); }
  .progress-slot.error .label { color: var(--error); }

  .violation-row {
    padding: 8px 0;
    border-top: 1px solid var(--border);
  }

  .violation-top {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
  }

  .violation-name {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    font-weight: 600;
    word-break: break-all;
  }

  .violation-name.fixed {
    text-decoration: line-through;
    color: var(--text-secondary);
  }

  .fix-btn {
    background: none;
    border: none;
    font-family: system-ui, -apple-system, sans-serif;
    font-size: 11px;
    color: var(--text-secondary);
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
    margin-left: 8px;
  }

  .fix-btn:hover { color: var(--text-primary); }

  .violation-rule { color: var(--text-secondary); font-size: 11px; margin-top: 2px; }

  .violation-explanation {
    color: var(--text-secondary);
    font-size: 11px;
    margin-top: 2px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }

  .violation-suggestion {
    font-family: ui-monospace, "SF Mono", "Cascadia Code", "Segoe UI Mono", Menlo, Consolas, monospace;
    font-size: 11px;
    margin-top: 2px;
  }

  .pass { text-align: center; padding-top: 40px; }
  .pass-title { color: var(--success); font-size: 12px; }
  .pass-sub { color: var(--text-secondary); font-size: 11px; margin-top: 4px; }

  .arch-failure { margin-top: 8px; }
  .arch-issue { color: var(--error); font-size: 11px; padding: 2px 0; }

  .fix-row {
    padding: 8px 0;
    border-top: 1px solid var(--border);
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
  }

  .fix-description { font-size: 11px; flex: 1; }
  .fix-row .fix-btn { flex-shrink: 0; }
</style>

<div id="app">
  <div id="registering-view" style="display:none">
    <div class="summary">Registering...</div>
  </div>
  <div id="default-view">
    <div class="summary" id="inventory">Loading variables...</div>
    <button class="primary-btn" id="run-btn" disabled>Run audit</button>
  </div>
  <div id="progress-view" style="display:none">
    <div class="summary" id="progress-summary">Running audit...</div>
    <div class="progress-area" id="progress-slots"></div>
  </div>
  <div id="arch-failure-view" style="display:none"></div>
  <div id="fix-view" style="display:none"></div>
  <div id="results-view" style="display:none"></div>
</div>

<script>
  // ─── Configuration ────────────────────────────────────────────────
  var WORKER_URL = "http://localhost:8787";
  var MODEL      = "claude-sonnet-4-5";
  // ─────────────────────────────────────────────────────────────────

  var variableData = null;
  var apiToken = null;

  var registeringView = document.getElementById("registering-view");
  var inventoryEl = document.getElementById("inventory");
  var runBtn = document.getElementById("run-btn");
  var defaultView = document.getElementById("default-view");
  var progressView = document.getElementById("progress-view");
  var progressSummary = document.getElementById("progress-summary");
  var progressSlots = document.getElementById("progress-slots");
  var archFailureView = document.getElementById("arch-failure-view");
  var fixView = document.getElementById("fix-view");
  var resultsView = document.getElementById("results-view");

  function showView(view) {
    [defaultView, progressView, archFailureView, fixView, resultsView, registeringView].forEach(function(v) {
      v.style.display = "none";
    });
    view.style.display = "block";
  }

  // ─── Receive messages from code.js ────────────────────────────────
  window.onmessage = function(event) {
    var msg = event.data.pluginMessage;
    if (!msg) return;

    if (msg.type === "auth-ready") {
      apiToken = msg.token;
      showView(defaultView);
    }

    if (msg.type === "register-user") {
      showView(registeringView);
      registerUser(msg.figmaUserId, msg.figmaUserName);
    }

    if (msg.type === "variable-data") {
      variableData = msg.data;
      var totalVars = variableData.collections.reduce(function(sum, c) { return sum + c.variables.length; }, 0);
      inventoryEl.textContent = variableData.collections.length + " collections \u00b7 " + totalVars + " variables";
      runBtn.disabled = false;
    }

    if (msg.type === "rename-success") {
      var nameEl = document.querySelector("[data-var-id=\"" + msg.id + "\"] .violation-name");
      if (nameEl) { nameEl.classList.add("fixed"); nameEl.textContent = msg.newName; }
      var fixBtn = document.querySelector("[data-var-id=\"" + msg.id + "\"] .fix-btn");
      if (fixBtn) { fixBtn.textContent = "Fixed"; fixBtn.disabled = true; }
    }

    if (msg.type === "rename-error") {
      var btn = document.querySelector("[data-var-id=\"" + msg.id + "\"] .fix-btn");
      if (btn) btn.textContent = "Error";
    }

    if (msg.type === "fix-success") {
      var fixEl = document.querySelector("[data-fix-action=\"" + msg.action + "\"]");
      if (fixEl) {
        var b = fixEl.querySelector(".fix-btn");
        if (b) { b.textContent = "Done"; b.disabled = true; }
      }
    }

    if (msg.type === "fix-error") {
      var fixEl2 = document.querySelector("[data-fix-action=\"" + msg.action + "\"]");
      if (fixEl2) {
        var b2 = fixEl2.querySelector(".fix-btn");
        if (b2) b2.textContent = "Error";
      }
    }
  };

  // ─── Orchestrator: architecture validation ────────────────────────
  function validateArchitecture(collections) {
    var expected = ["primitives", "themes", "components"];
    var names = collections.map(function(c) { return c.name.toLowerCase(); });
    var issues = [];

    for (var i = 0; i < expected.length; i++) {
      if (names.indexOf(expected[i]) === -1) {
        var closeMatch = collections.find(function(c) {
          return c.name.toLowerCase() === expected[i] && c.name !== expected[i];
        });
        if (closeMatch) {
          issues.push("Collection \"" + closeMatch.name + "\" should be lowercase: \"" + expected[i] + "\"");
        } else {
          issues.push("Missing collection: \"" + expected[i] + "\"");
        }
      }
    }

    for (var j = 0; j < names.length; j++) {
      if (expected.indexOf(names[j]) === -1) {
        issues.push("Unexpected collection: \"" + collections[j].name + "\"");
      }
    }

    return issues;
  }

  // ─── Orchestrator: compute reference maps ─────────────────────────
  function computeReferenceMaps(collections) {
    var byName = {};
    for (var i = 0; i < collections.length; i++) {
      byName[collections[i].name.toLowerCase()] = collections[i];
    }

    var primitiveNames = [];
    var themeNames = [];
    if (byName.primitives) {
      primitiveNames = byName.primitives.variables.map(function(v) { return v.name; });
    }
    if (byName.themes) {
      themeNames = byName.themes.variables.map(function(v) { return v.name; });
    }

    var referencedPrimitives = {};
    var referencedThemes = {};

    if (byName.themes) {
      for (var t = 0; t < byName.themes.variables.length; t++) {
        var tv = byName.themes.variables[t];
        var modes = Object.keys(tv.valuesByMode);
        for (var m = 0; m < modes.length; m++) {
          var alias = tv.valuesByMode[modes[m]].aliasId;
          if (alias) referencedPrimitives[alias] = true;
        }
      }
    }

    if (byName.components) {
      for (var c = 0; c < byName.components.variables.length; c++) {
        var cv = byName.components.variables[c];
        var cmodes = Object.keys(cv.valuesByMode);
        for (var cm = 0; cm < cmodes.length; cm++) {
          var calias = cv.valuesByMode[cmodes[cm]].aliasId;
          if (calias) referencedThemes[calias] = true;
        }
      }
    }

    var unreferencedPrimitives = primitiveNames.filter(function(n) { return !referencedPrimitives[n]; });
    var unreferencedThemes = themeNames.filter(function(n) { return !referencedThemes[n]; });

    return {
      primitiveNames: primitiveNames,
      themeNames: themeNames,
      unreferencedPrimitives: unreferencedPrimitives,
      unreferencedThemes: unreferencedThemes,
    };
  }

  // ─── SSE stream reader ────────────────────────────────────────────
  async function readSSEStream(response) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var text = "";

    while (true) {
      var result = await reader.read();
      if (result.done) break;

      var chunk = decoder.decode(result.value, { stream: true });
      var lines = chunk.split("\n");
      for (var i = 0; i < lines.length; i++) {
        if (!lines[i].startsWith("data: ")) continue;
        var data = lines[i].slice(6);
        if (data === "[DONE]") continue;
        try {
          var event = JSON.parse(data);
          if (event.type === "content_block_delta" && event.delta && event.delta.text) {
            text += event.delta.text;
          }
          if (event.error) {
            throw new Error(event.error);
          }
        } catch (e) {
          if (e.message && e.message !== "Unexpected end of JSON input" &&
              e.message !== "Unexpected token e in JSON at position 1") throw e;
        }
      }
    }

    return JSON.parse(text);
  }

  // ─── Run audit ────────────────────────────────────────────────────
  runBtn.addEventListener("click", async function() {
    if (!variableData || !apiToken) return;
    runBtn.disabled = true;

    var archIssues = validateArchitecture(variableData.collections);

    if (archIssues.length > 0) {
      showArchitectureFailure(archIssues);
      return;
    }

    await runParallelAudit();
  });

  // ─── Architecture failure UI ──────────────────────────────────────
  function showArchitectureFailure(issues) {
    showView(archFailureView);
    while (archFailureView.firstChild) archFailureView.removeChild(archFailureView.firstChild);

    var title = document.createElement("div");
    title.className = "summary";
    var titleSpan = document.createElement("span");
    titleSpan.style.color = "var(--error)";
    titleSpan.textContent = "Architecture check failed";
    title.appendChild(titleSpan);
    archFailureView.appendChild(title);

    var issueList = document.createElement("div");
    issueList.className = "arch-failure";
    for (var i = 0; i < issues.length; i++) {
      var issueEl = document.createElement("div");
      issueEl.className = "arch-issue";
      issueEl.textContent = issues[i];
      issueList.appendChild(issueEl);
    }
    archFailureView.appendChild(issueList);

    var btnRow = document.createElement("div");
    btnRow.className = "btn-row";

    var fixBtn = document.createElement("button");
    fixBtn.textContent = "Fix it";
    fixBtn.addEventListener("click", function() { runFixAgent(); });

    var genericBtn = document.createElement("button");
    genericBtn.textContent = "Run generic check";
    genericBtn.addEventListener("click", function() { runGenericAudit(); });

    btnRow.appendChild(fixBtn);
    btnRow.appendChild(genericBtn);
    archFailureView.appendChild(btnRow);
  }

  // ─── Fix agent ────────────────────────────────────────────────────
  async function runFixAgent() {
    showView(progressView);
    progressSummary.textContent = "Analyzing architecture issues...";
    while (progressSlots.firstChild) progressSlots.removeChild(progressSlots.firstChild);

    var slot = createProgressSlot("Architecture fix");
    slot.el.classList.add("streaming");

    try {
      var structure = variableData.collections.map(function(c) {
        return {
          id: c.id || c.name,
          name: c.name,
          modes: c.modes,
          variableCount: c.variables.length,
          variables: c.variables.map(function(v) {
            return { id: v.id, name: v.name, type: v.type };
          }),
        };
      });

      var resp = await fetch(WORKER_URL + "/audit/fix", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiToken,
        },
        body: JSON.stringify({
          model: MODEL,
          collectionStructure: structure,
          auditGroupId: crypto.randomUUID(),
        }),
      });

      if (!resp.ok) throw new Error("API " + resp.status);

      var result = await readSSEStream(resp);
      slot.el.classList.remove("streaming");
      slot.el.classList.add("done");
      slot.label.textContent = "Architecture fix \u2014 " + result.fixes.length + " suggestions";

      renderFixes(result.fixes);
    } catch (err) {
      slot.el.classList.remove("streaming");
      slot.el.classList.add("error");
      slot.label.textContent = "Architecture fix \u2014 failed";
      parent.postMessage({ pluginMessage: { type: "notify", message: "Fix analysis failed: " + err.message, error: true } }, "*");
    }
  }

  // ─── Render fixes ─────────────────────────────────────────────────
  function renderFixes(fixes) {
    showView(fixView);
    while (fixView.firstChild) fixView.removeChild(fixView.firstChild);

    var title = document.createElement("div");
    title.className = "summary";
    title.textContent = fixes.length + " suggested fixes";
    fixView.appendChild(title);

    for (var i = 0; i < fixes.length; i++) {
      (function(fix, index) {
        var row = document.createElement("div");
        row.className = "fix-row";
        row.setAttribute("data-fix-action", fix.action + "-" + index);

        var desc = document.createElement("div");
        desc.className = "fix-description";
        desc.textContent = fix.description;

        var btn = document.createElement("button");
        btn.className = "fix-btn";
        btn.textContent = "Fix";
        btn.addEventListener("click", function() {
          btn.textContent = "Fixing\u2026";
          btn.disabled = true;

          var message = { type: fix.action };
          if (fix.params) {
            var keys = Object.keys(fix.params);
            for (var k = 0; k < keys.length; k++) {
              message[keys[k]] = fix.params[keys[k]];
            }
          }
          parent.postMessage({ pluginMessage: message }, "*");
        });

        row.appendChild(desc);
        row.appendChild(btn);
        fixView.appendChild(row);
      })(fixes[i], i);
    }

    addRerunButton(fixView);
  }

  // ─── Generic audit ────────────────────────────────────────────────
  async function runGenericAudit() {
    showView(progressView);
    progressSummary.textContent = "Running generic audit...";
    while (progressSlots.firstChild) progressSlots.removeChild(progressSlots.firstChild);

    var slot = createProgressSlot("Full audit");
    slot.el.classList.add("streaming");

    try {
      var totalVars = variableData.collections.reduce(function(s, c) { return s + c.variables.length; }, 0);

      var resp = await fetch(WORKER_URL + "/audit/generic", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiToken,
        },
        body: JSON.stringify({
          model: MODEL,
          variableData: variableData,
          auditGroupId: crypto.randomUUID(),
          variablesCount: totalVars,
        }),
      });

      if (!resp.ok) throw new Error("API " + resp.status);

      var result = await readSSEStream(resp);
      slot.el.classList.remove("streaming");
      slot.el.classList.add("done");
      slot.label.textContent = "Full audit \u2014 " + result.summary.total_violations + " violations";

      renderResults(result);
    } catch (err) {
      slot.el.classList.remove("streaming");
      slot.el.classList.add("error");
      slot.label.textContent = "Full audit \u2014 failed";
      parent.postMessage({ pluginMessage: { type: "notify", message: "Audit failed: " + err.message, error: true } }, "*");
    }
  }

  // ─── Parallel collection audit ────────────────────────────────────
  async function runParallelAudit() {
    showView(progressView);
    progressSummary.textContent = "Running audit...";
    while (progressSlots.firstChild) progressSlots.removeChild(progressSlots.firstChild);

    var refs = computeReferenceMaps(variableData.collections);
    var byName = {};
    for (var i = 0; i < variableData.collections.length; i++) {
      byName[variableData.collections[i].name.toLowerCase()] = variableData.collections[i];
    }

    var auditGroupId = crypto.randomUUID();
    var allViolations = [];
    var totalVars = 0;

    var agents = [
      {
        name: "primitives",
        route: "/audit/primitives",
        collection: byName.primitives,
        referenceNames: [],
        unreferencedNames: refs.unreferencedPrimitives,
      },
      {
        name: "themes",
        route: "/audit/themes",
        collection: byName.themes,
        referenceNames: refs.primitiveNames,
        unreferencedNames: refs.unreferencedThemes,
      },
      {
        name: "components",
        route: "/audit/components",
        collection: byName.components,
        referenceNames: refs.themeNames,
        unreferencedNames: [],
      },
    ];

    var slots = {};
    for (var a = 0; a < agents.length; a++) {
      slots[agents[a].name] = createProgressSlot(agents[a].name);
    }

    var promises = agents.map(function(agent) {
      return runSingleAgent(agent, auditGroupId, slots[agent.name]);
    });

    var results = await Promise.allSettled(promises);

    for (var r = 0; r < results.length; r++) {
      if (results[r].status === "fulfilled" && results[r].value) {
        var res = results[r].value;
        totalVars += res.summary.total_variables;
        allViolations = allViolations.concat(res.violations);
      }
    }

    renderResults({
      summary: { total_variables: totalVars, total_violations: allViolations.length },
      violations: allViolations,
    });
  }

  async function runSingleAgent(agent, auditGroupId, slot) {
    slot.el.classList.add("streaming");

    try {
      var resp = await fetch(WORKER_URL + agent.route, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiToken,
        },
        body: JSON.stringify({
          model: MODEL,
          collectionData: agent.collection,
          referenceNames: agent.referenceNames,
          unreferencedNames: agent.unreferencedNames,
          auditGroupId: auditGroupId,
          variablesCount: agent.collection.variables.length,
        }),
      });

      if (!resp.ok) {
        if (resp.status === 401) {
          apiToken = null;
          parent.postMessage({ pluginMessage: { type: "clear-token" } }, "*");
        }
        throw new Error("API " + resp.status);
      }

      var result = await readSSEStream(resp);

      slot.el.classList.remove("streaming");
      slot.el.classList.add("done");
      slot.label.textContent = agent.name + " \u2014 " + result.summary.total_violations + " violations";

      return result;
    } catch (err) {
      slot.el.classList.remove("streaming");
      slot.el.classList.add("error");
      slot.label.textContent = agent.name + " \u2014 failed";
      return null;
    }
  }

  // ─── Progress slot helper ─────────────────────────────────────────
  function createProgressSlot(name) {
    var el = document.createElement("div");
    el.className = "progress-slot";

    var dot = document.createElement("div");
    dot.className = "dot";

    var label = document.createElement("div");
    label.className = "label";
    label.textContent = name;

    el.appendChild(dot);
    el.appendChild(label);
    progressSlots.appendChild(el);

    return { el: el, label: label };
  }

  // ─── Render results ───────────────────────────────────────────────
  function renderResults(result) {
    showView(resultsView);
    while (resultsView.firstChild) resultsView.removeChild(resultsView.firstChild);

    var totalVars = result.summary.total_variables;
    var totalViolations = result.summary.total_violations;

    if (totalViolations === 0) {
      var passDiv = document.createElement("div");
      passDiv.className = "pass";

      var passTitle = document.createElement("div");
      passTitle.className = "pass-title";
      passTitle.textContent = "No violations";
      passDiv.appendChild(passTitle);

      var passSub = document.createElement("div");
      passSub.className = "pass-sub";
      passSub.textContent = totalVars + " variables checked";
      passDiv.appendChild(passSub);

      resultsView.appendChild(passDiv);
      addRerunButton(resultsView);
      return;
    }

    var summaryEl = document.createElement("div");
    summaryEl.className = "summary";
    var summarySpan = document.createElement("span");
    summarySpan.style.color = "var(--error)";
    summarySpan.textContent = totalVars + " variables \u00b7 " + totalViolations + " violations";
    summaryEl.appendChild(summarySpan);
    resultsView.appendChild(summaryEl);

    var groups = {};
    for (var v = 0; v < result.violations.length; v++) {
      var key = result.violations[v].collection.toLowerCase();
      if (!groups[key]) groups[key] = [];
      groups[key].push(result.violations[v]);
    }

    var sectionOrder = ["primitives", "themes", "components"];
    for (var s = 0; s < sectionOrder.length; s++) {
      var section = sectionOrder[s];
      if (groups[section] && groups[section].length > 0) {
        renderSection(section.toUpperCase(), groups[section]);
      }
    }

    var groupKeys = Object.keys(groups);
    for (var g = 0; g < groupKeys.length; g++) {
      if (sectionOrder.indexOf(groupKeys[g]) === -1) {
        renderSection(groupKeys[g].toUpperCase(), groups[groupKeys[g]]);
      }
    }

    addRerunButton(resultsView);
  }

  function addRerunButton(container) {
    var rerunBtn = document.createElement("button");
    rerunBtn.className = "primary-btn";
    rerunBtn.textContent = "Re-run audit";
    rerunBtn.style.marginTop = "16px";
    rerunBtn.addEventListener("click", function() {
      parent.postMessage({ pluginMessage: { type: "reload-variables" } }, "*");
      showView(defaultView);
      runBtn.disabled = false;
      runBtn.textContent = "Run audit";
    });
    container.appendChild(rerunBtn);
  }

  // ─── Registration ──────────────────────────────────────────────────
  async function registerUser(figmaUserId, figmaUserName) {
    try {
      var resp = await fetch(WORKER_URL + "/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ figmaUserId: figmaUserId, figmaUserName: figmaUserName }),
      });

      if (!resp.ok) {
        var errText = await resp.text();
        throw new Error("HTTP " + resp.status + ": " + errText.slice(0, 200));
      }

      var data = await resp.json();
      apiToken = data.token;
      parent.postMessage({ pluginMessage: { type: "store-token", token: data.token } }, "*");
      showView(defaultView);
    } catch (err) {
      parent.postMessage({ pluginMessage: { type: "registration-failed", message: err.message } }, "*");
      showView(defaultView);
      inventoryEl.textContent = "Registration failed. Restart the plugin.";
    }
  }

  function renderSection(title, violations) {
    var header = document.createElement("div");
    header.className = "section-header";
    header.textContent = title;
    resultsView.appendChild(header);

    for (var i = 0; i < violations.length; i++) {
      var v = violations[i];
      var row = document.createElement("div");
      row.className = "violation-row";
      if (v.variable_id) row.setAttribute("data-var-id", v.variable_id);

      var topLine = document.createElement("div");
      topLine.className = "violation-top";

      var nameEl = document.createElement("span");
      nameEl.className = "violation-name";
      nameEl.textContent = v.variable;

      var fixBtn = document.createElement("button");
      fixBtn.className = "fix-btn";
      fixBtn.textContent = "Fix";

      (function(violation, btn) {
        if (violation.variable_id) {
          btn.addEventListener("click", function() {
            parent.postMessage({ pluginMessage: { type: "rename-variable", id: violation.variable_id, newName: violation.suggestion } }, "*");
            btn.textContent = "Fixing\u2026";
            btn.disabled = true;
          });
        } else {
          btn.addEventListener("click", function() {
            navigator.clipboard.writeText(violation.suggestion).then(function() {
              btn.textContent = "Copied";
              setTimeout(function() { btn.textContent = "Fix"; }, 2000);
            });
          });
        }
      })(v, fixBtn);

      topLine.appendChild(nameEl);
      topLine.appendChild(fixBtn);
      row.appendChild(topLine);

      var ruleEl = document.createElement("div");
      ruleEl.className = "violation-rule";
      ruleEl.textContent = v.rule;
      row.appendChild(ruleEl);

      var explEl = document.createElement("div");
      explEl.className = "violation-explanation";
      explEl.textContent = v.explanation;
      row.appendChild(explEl);

      var sugEl = document.createElement("div");
      sugEl.className = "violation-suggestion";
      sugEl.textContent = "\u2192 " + v.suggestion;
      row.appendChild(sugEl);

      resultsView.appendChild(row);
    }
  }

  parent.postMessage({ pluginMessage: { type: "ui-ready" } }, "*");
</script>
```

- [ ] **Step 2: Build and verify**

Run: `cd apps/figma-plugin && node build-ui.mjs`
Expected: Build succeeds, `dist/ui.html` created with substituted WORKER_URL and MODEL.

- [ ] **Step 3: Commit**

```bash
git add apps/figma-plugin/ui.html
git commit -m "feat: rewrite UI with orchestrator, parallel streaming, and fix flow"
```

---

## Task 8: Run migration and full build

- [ ] **Step 1: Apply the migration locally**

Run: `cd apps/worker && pnpm db:migrate:local`
Expected: Migration 0002 applied successfully.

- [ ] **Step 2: Run all worker tests**

Run: `cd apps/worker && pnpm test`
Expected: All tests pass.

- [ ] **Step 3: Build all apps**

Run: `pnpm run build`
Expected: Build succeeds for both worker and figma-plugin.

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A && git commit -m "chore: apply D1 migration and verify full build"
```

---

## Task 9: End-to-end manual test

No code changes — verification only.

- [ ] **Step 1: Start the worker locally**

Run: `cd apps/worker && pnpm dev`
Expected: Worker starts on localhost:8787.

- [ ] **Step 2: Build and load the Figma plugin**

Run: `cd apps/figma-plugin && node build-ui.mjs`
Then load the plugin in Figma from the `apps/figma-plugin` directory.

- [ ] **Step 3: Test happy path**

In a Figma file with correctly structured collections (primitives, themes, components):
1. Open the plugin
2. Verify inventory shows correctly
3. Click "Run audit"
4. Verify progress slots appear with pulsing dots
5. Verify results render as each agent completes
6. Verify "Fix" buttons work on violations
7. Verify "Re-run audit" reloads and returns to default view

- [ ] **Step 4: Test architecture failure path**

In a Figma file with incorrectly named collections:
1. Open the plugin
2. Click "Run audit"
3. Verify architecture failure screen shows with specific issues
4. Click "Fix it" — verify fix suggestions stream in
5. Click "Fix" on a suggestion — verify it applies
6. Click "Re-run audit" — verify fresh start
7. Test "Run generic check" — verify full audit runs and results render
