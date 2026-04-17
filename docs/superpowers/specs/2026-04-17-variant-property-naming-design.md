# Variant Property Naming Check

**Date:** 2026-04-17  
**Status:** Approved

## Summary

Add variant property naming rules to the existing `COMPONENT_HEALTH_SYSTEM_PROMPT` in `apps/worker/src/prompts.ts`. No changes to `code.ts` — `variantProperties` is already collected and sent to the AI.

## Rules

The AI will enforce the following rules against each component's `variantProperties`:

### Canonical property names

Valid names and their expected value formats:

| Property | Expected values |
|---|---|
| `state` | default, hover, focus, active, disabled, pressed, error, loading, selected |
| `variant` | any (component-specific, e.g. primary, secondary, ghost) |
| `viewport` | xs, sm, md, lg, xl, 2xl only |
| `theme` | light, dark, or custom brand names |
| `size` | xs, sm, md, lg, xl, 2xl |
| `shape` | rounded, square, pill, circle |
| `orientation` | horizontal, vertical |
| `alignment` | left, center, right, start, end |
| `density` | compact, comfortable, spacious |
| `layout` | stacked, inline, grid |

Component-specific descriptive names (e.g. `icon-position`) are acceptable and should not be flagged.

### Violations

**Error:**
- Default Figma names: `Property 1`, `Property 2`, etc.
- Any property name or value containing spaces or uppercase letters
- `mode` as a property name — must be `theme`
- Generic non-descriptive names: `type`, `style`
- `viewport` property with non-t-shirt-size values (e.g. `mobile`, `desktop`, `tablet`)

**Warning:**
- Unrecognized property names that aren't obviously bad (may be intentional but deviate from convention)

**Note:**
- Values that could be more conventional (e.g. `on`/`off` when `true`/`false` or `enabled`/`disabled` would be clearer)

## Approach

Option A: extend `COMPONENT_HEALTH_SYSTEM_PROMPT` with a new **"Variant property naming"** section. No code changes beyond the prompt.

## Violation format

Same as existing component health violations:
- `collection`: `"component-health"`
- `variable_id`: component node id
- `variable`: component name
- `level`: error / warning / note
- `rule`: short label (e.g. `"Invalid property name"`, `"Wrong viewport values"`, `"Use theme not mode"`)
- `explanation`: one sentence
- `options`: rename suggestions
