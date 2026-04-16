# Prompt Customization — Design Spec

**Date:** 2026-04-16

## Overview

Allow users to replace any of the 6 audit system prompts on a per-Figma-file basis. Custom prompts are stored in the Figma document root (shared across all users of that file) and optionally sent to the worker at audit time.

## Prompts

There are 6 prompts, each keyed by name:

| Key | Used by |
|---|---|
| `primitives` | `/audit/primitives` |
| `themes` | `/audit/themes` |
| `components` | `/audit/components` |
| `component-health` | `/audit/component-health` |
| `generic` | `/audit/generic` |
| `fix` | `/audit/fix` |

## Storage

- **Location:** `figma.root.getPluginData("customPrompts")` / `figma.root.setPluginData("customPrompts", ...)`
- **Format:** JSON string of `Record<string, string>` — only keys with custom values are present. Missing keys = use default.
- **Scope:** File-level, shared across all users of that Figma file.

## Data Flow

1. On plugin init, `code.js` reads `figma.root.getPluginData("customPrompts")` and sends it to the UI as a `custom-prompts` message alongside existing init data.
2. When the UI runs an audit, it checks if a custom prompt exists for that collection. If yes, it includes `systemPrompt: <string>` in the request body sent to the worker.
3. The worker checks for `systemPrompt` in the request body. If present and non-empty, it uses it instead of the hardcoded prompt.
4. When the user saves a prompt in the editor, the UI sends a `save-custom-prompts` message to `code.js`, which writes the updated object back to `figma.root.setPluginData`.

## Worker Changes

- Each audit endpoint's request body interface gains `systemPrompt?: string`.
- In `handleCollectionAudit`, `handleComponentHealth`, `handleGeneric`, and `handleFix`: if `body.systemPrompt` is present and non-empty, pass it to `createStreamingProxy` instead of the hardcoded constant.
- No DB changes. No new endpoints.

## Plugin `code.js` Changes

Two new message handlers:

- `get-custom-prompts` → `figma.root.getPluginData("customPrompts")` → send back to UI
- `save-custom-prompts` (receives updated `Record<string, string>`) → `figma.root.setPluginData("customPrompts", JSON.stringify(data))`

On init, send `customPrompts` data to UI alongside existing init messages.

## Plugin UI Changes

### New "Settings" tab

Added to the existing nav alongside Audit and Guide.

**Prompt list view** (default settings view):
- One row per prompt (6 total)
- Each row: prompt name + "customized" badge if a custom version is saved + "Edit" button
- No other content

**Prompt editor view** (replaces settings list when Edit is clicked):
- Header: prompt name | "Reset to default" button (only if customized) | "Back" link
- `<textarea>` filling the remaining panel height:
  - `font-family: monospace`
  - `background: #1e1e1e`, `color: #d4d4d4`
  - `resize: none`, `border: none`, `outline: none`
  - Pre-populated with the current custom prompt, or the default prompt if none saved
- Footer: "Save" button
- "Back" without saving: if content differs from what was loaded, show a native `confirm()` discard dialog before navigating away
- "Reset to default": deletes this key from the custom prompts object, saves, returns to list
- "Save": writes updated prompts object via `save-custom-prompts` message, returns to list, updates "customized" badge

## UI State

The UI holds `customPrompts: Record<string, string>` in memory (initialized from the `custom-prompts` init message). All reads/writes go through this in-memory object; saves persist it via `code.js`.

## Out of Scope

- Syntax highlighting or line numbers
- Per-user prompt overrides
- Exporting/importing prompt sets
- Validating prompt content before saving
