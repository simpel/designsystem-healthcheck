import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users } from "./schema";
import { createStreamingProxy } from "./stream";
import { logAudit } from "./audit-logger";
import {
  PRIMITIVES_SYSTEM_PROMPT,
  THEMES_SYSTEM_PROMPT,
  COMPONENTS_SYSTEM_PROMPT,
  COMPONENT_HEALTH_SYSTEM_PROMPT,
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
  PLUGIN_SECRET: string;
  DB: D1Database;
}

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, X-Audit-Group-Id, X-Plugin-Secret",
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
  const pluginSecret = request.headers.get("X-Plugin-Secret");
  if (!pluginSecret || pluginSecret !== env.PLUGIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

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
  systemPrompt?: string;
}

function getGatewayUrl(env: Env): string {
  return `https://gateway.ai.cloudflare.com/v1/${env.CF_ACCOUNT_ID}/${env.CF_GATEWAY_ID}/anthropic/v1/messages`;
}

async function handleCollectionAudit(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
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

  let userContent = `Audit the following Figma "${collectionName}" collection data:\n\n${JSON.stringify(body.collectionData)}`;

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
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : systemPrompt,
    userMessage: userContent,
    outputSchema: VIOLATIONS_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  // Log audit after stream completes (non-blocking)
  ctx.waitUntil(
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
    }).catch(() => {})
  );

  return response;
}

async function handleComponentHealth(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) return authResult;

  let body: { model: string; componentData: unknown; auditGroupId: string; componentCount: number; systemPrompt?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const userContent = `Audit the following Figma components for health and completeness:\n\n${JSON.stringify(body.componentData)}`;

  const { response, completion } = createStreamingProxy({
    gatewayUrl: getGatewayUrl(env),
    apiKey: env.ANTHROPIC_API_KEY,
    aigToken: env.CF_AIG_TOKEN,
    model: body.model || "claude-sonnet-4-5",
    maxTokens: 8192,
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : COMPONENT_HEALTH_SYSTEM_PROMPT,
    userMessage: userContent,
    outputSchema: VIOLATIONS_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  ctx.waitUntil(
    completion.then(async ({ text, inputTokens, outputTokens }) => {
      try {
        const parsed = JSON.parse(text);
        await logAudit(env.DB, {
          userId: authResult.userId,
          auditGroupId: body.auditGroupId,
          collectionName: "component-health",
          variablesCount: body.componentCount,
          violationsCount: parsed.summary?.total_violations ?? 0,
          inputTokens,
          outputTokens,
          violationsJson: JSON.stringify(parsed.violations ?? []),
        });
      } catch {
        // Best-effort logging
      }
    }).catch(() => {})
  );

  return response;
}

async function handleFix(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) return authResult;

  let body: { model: string; collectionStructure: unknown; auditGroupId: string; systemPrompt?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const userContent = `Analyze the following Figma file structure and suggest fixes to achieve the correct architecture (exactly 3 collections: primitives, themes, components):\n\n${JSON.stringify(body.collectionStructure)}`;

  const { response } = createStreamingProxy({
    gatewayUrl: getGatewayUrl(env),
    apiKey: env.ANTHROPIC_API_KEY,
    aigToken: env.CF_AIG_TOKEN,
    model: body.model || "claude-sonnet-4-5",
    maxTokens: 4096,
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : FIX_SYSTEM_PROMPT,
    userMessage: userContent,
    outputSchema: FIX_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  return response;
}

async function handleGeneric(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) return authResult;

  let body: { model: string; variableData: unknown; auditGroupId: string; variablesCount: number; systemPrompt?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  const userContent = `Audit the following Figma variable data:\n\n${JSON.stringify(body.variableData)}`;

  const { response, completion } = createStreamingProxy({
    gatewayUrl: getGatewayUrl(env),
    apiKey: env.ANTHROPIC_API_KEY,
    aigToken: env.CF_AIG_TOKEN,
    model: body.model || "claude-sonnet-4-5",
    maxTokens: 8192,
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : GENERIC_SYSTEM_PROMPT,
    userMessage: userContent,
    outputSchema: VIOLATIONS_SCHEMA,
    corsHeaders: CORS_HEADERS,
  });

  ctx.waitUntil(
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
    }).catch(() => {})
  );

  return response;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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
          return handleCollectionAudit(request, env, ctx, "primitives", PRIMITIVES_SYSTEM_PROMPT);
        case "/audit/themes":
          return handleCollectionAudit(request, env, ctx, "themes", THEMES_SYSTEM_PROMPT);
        case "/audit/components":
          return handleCollectionAudit(request, env, ctx, "components", COMPONENTS_SYSTEM_PROMPT);
        case "/audit/component-health":
          return handleComponentHealth(request, env, ctx);
        case "/audit/fix":
          return handleFix(request, env, ctx);
        case "/audit/generic":
          return handleGeneric(request, env, ctx);
        default:
          return json({ error: "Not found" }, 404);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Internal error";
      return json({ error: message }, 500);
    }
  },
};
