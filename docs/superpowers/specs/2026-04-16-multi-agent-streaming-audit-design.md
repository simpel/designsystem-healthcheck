# Multi-Agent Streaming Audit

## Problem

The audit sends all variables in one monolithic API call with no progress feedback. For large variable sets this takes a long time with no indication of progress.

## Solution

Replace the single API call with a multi-agent architecture: a client-side orchestrator that validates architecture and fails fast, then 3 parallel streaming LLM agents (one per collection) with specialized prompts. A generic fallback agent handles files with incorrect architecture. An LLM-powered fix agent suggests actionable fixes for architecture violations.

## Agents

| Agent | Type | Purpose |
|-------|------|---------|
| Orchestrator | Client-side JS | Validates architecture (3 collections, correct names), dispatches agents or shows failure UI |
| Primitives | Streaming LLM | Audits primitives collection with specialized prompt |
| Themes | Streaming LLM | Audits themes collection, receives primitive variable names as reference context |
| Components | Streaming LLM | Audits components collection, receives theme variable names as reference context |
| Generic | Streaming LLM | Full monolithic audit (current prompt), used when architecture is wrong |
| Fix | Streaming LLM | Analyzes architecture issues and returns structured fix actions |

## Flow

### Happy path

```
Click "Run audit"
  -> Orchestrator checks: 3 collections? names = primitives, themes, components?
  -> PASS -> fire 3 agents in parallel (streaming)
  -> UI shows progress slots, results render as each completes
```

### Unhappy path (architecture fails)

```
Click "Run audit"
  -> Orchestrator checks architecture
  -> FAIL -> Show failure screen:
      "Architecture check failed: [specific issues]"
      [Fix it]  [Run generic check]

  -> "Fix it" -> POST /audit/fix -> renders actionable fix list with [Fix] buttons
  -> "Run generic check" -> POST /audit/generic -> renders results same as current
```

## Worker API Routes

| Route | Purpose | Streaming |
|-------|---------|-----------|
| `POST /audit/fix` | Architecture fix suggestions | Yes |
| `POST /audit/primitives` | Primitives collection audit | Yes |
| `POST /audit/themes` | Themes collection audit | Yes |
| `POST /audit/components` | Components collection audit | Yes |
| `POST /audit/generic` | Full monolithic audit (fallback) | Yes |

Old `POST /audit` route is removed.

All routes share the same auth flow (bearer token -> D1 lookup).

### Route behavior

Each route:
1. Authenticates the user
2. Receives a tailored payload (relevant collection data + reference names)
3. Injects route-specific system prompt server-side (prompts live in the worker, not the client)
4. Forwards to Anthropic with `stream: true`
5. Pipes the SSE stream back to the client with CORS headers
6. Logs audit results to D1 after stream completes

### Audit logging

Each per-collection call logs its own row, with a shared `audit_group_id` so the 3 calls from one audit run can be correlated.

## Streaming Implementation

### Worker side

- Add `stream: true` to the Anthropic request body
- Pipe the SSE stream directly to the client (ReadableStream with CORS headers)
- After stream ends, parse accumulated response for D1 logging

### Client side

```
fetch("/audit/primitives", { ... })
  -> response.body.getReader()
  -> read SSE chunks
  -> parse "content_block_delta" events for text deltas
  -> accumulate full text
  -> on "message_stop": parse complete JSON, render violations
```

### Structured outputs + streaming

With `output_config` (JSON schema), streamed deltas are partial JSON not parseable until complete. Within a single agent's stream we show a pulsing "Analyzing..." indicator. Real progress comes from the batching: results render collection-by-collection as each agent completes.

## UI States

### 1. Auditing (happy path)

Button disabled, progress area with 3 slots:
- `[ ] Primitives` / `[...] Primitives` / `[done] Primitives - 4 violations`
- Same for Themes, Components
- As each completes, violations render below and slot updates

### 2. Architecture failure

Replaces default view:
- Explanation: "Architecture check failed" + bullet list of specific issues
- Two buttons side by side: `[Fix it]` and `[Run generic check]`

### 3. Fix it view

Replaces failure screen:
- List of LLM-suggested fix actions, each with a `[Fix]` button
- Fixes send messages to code.ts (rename collection, move variables, create collection)
- After applying fixes, `[Re-run audit]` button appears

### 4. Generic results

Same as current violation rendering (grouped by collection).

## System Prompts

Prompts live server-side in the worker. Each collection agent gets a tailored prompt covering only its rules:

- **Primitives prompt**: naming structure (category/scale or category/variant/scale), no semantic meaning, hardcoded values only, consistency checks
- **Themes prompt**: semantic naming, must alias primitives (reference list provided), mode name rules, consistency checks
- **Components prompt**: component/property/state structure, must alias themes (reference list provided), mode name rules (t-shirt sizes), state coverage checks
- **Generic prompt**: current monolithic prompt (all rules)
- **Fix prompt**: receives collection names, variable names, and counts; returns structured fix actions

## Fix Action Schema

The fix LLM returns structured JSON mapping to Figma API actions:

```json
{
  "fixes": [
    {
      "action": "rename-collection",
      "description": "Rename 'Tokens' to 'primitives'",
      "params": { "collectionId": "...", "newName": "primitives" }
    },
    {
      "action": "move-variables",
      "description": "Move color variables to primitives",
      "params": {
        "variableIds": ["id1", "id2"],
        "targetCollectionId": "..."
      }
    },
    {
      "action": "create-collection",
      "description": "Create missing 'components' collection",
      "params": { "name": "components" }
    },
    {
      "action": "delete-collection",
      "description": "Remove extra collection 'brand-tokens'",
      "params": { "collectionId": "..." }
    }
  ]
}
```

The LLM receives collection IDs and variable IDs so suggestions are directly actionable.

## code.ts Message Types

| Message type | Action |
|---|---|
| `rename-variable` | Existing - renames a variable |
| `rename-collection` | Rename a collection |
| `move-variables` | Move variables between collections |
| `create-collection` | Create a new empty collection |
| `delete-collection` | Delete a collection |
| `reload-variables` | Re-run loadVariableData() and send fresh data to UI |

## Cross-Collection Context

Per-collection agents need reference data from sibling collections:

- **Themes agent** receives: list of primitive variable names (to verify alias targets)
- **Components agent** receives: list of theme variable names (to verify alias targets)
- **Primitives agent** receives: no cross-references needed

This is just variable names, not full data, keeping payloads small.
