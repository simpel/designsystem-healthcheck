# Prompt Customization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to replace any of the 6 audit system prompts on a per-Figma-file basis, stored in the Figma document root and shared across all users of that file.

**Architecture:** Custom prompts are stored as a JSON object in `figma.root.getPluginData("customPrompts")`, keyed by prompt name. On audit, the UI optionally passes `systemPrompt` in the request body; the worker uses it instead of the hardcoded constant if present. The Settings tab in the plugin UI provides a list + editor interface.

**Tech Stack:** TypeScript (code.ts), vanilla JS (ui.html), Cloudflare Workers (index.ts)

---

### Task 1: Worker — accept optional `systemPrompt` in all audit handlers

**Files:**
- Modify: `apps/worker/src/index.ts`

The worker has 4 audit handlers that use hardcoded prompts. We extend their request body types to accept an optional `systemPrompt` string, and pass it through to `createStreamingProxy` if non-empty.

- [ ] **Step 1: Update `AuditRequestBody` interface**

In `apps/worker/src/index.ts`, find the `AuditRequestBody` interface at line 92 and add the optional field:

```typescript
interface AuditRequestBody {
  model: string;
  collectionData: unknown;
  referenceNames?: string[];
  unreferencedNames?: string[];
  auditGroupId: string;
  variablesCount: number;
  systemPrompt?: string;
}
```

- [ ] **Step 2: Use `systemPrompt` in `handleCollectionAudit`**

Find `handleCollectionAudit` (line 105). Change the `createStreamingProxy` call's `systemPrompt` argument:

```typescript
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
```

- [ ] **Step 3: Update `handleComponentHealth` body type and prompt**

Find `handleComponentHealth` (line 169). Add `systemPrompt?: string` to its local body type and use it:

```typescript
  let body: { model: string; componentData: unknown; auditGroupId: string; componentCount: number; systemPrompt?: string };
```

Then in the `createStreamingProxy` call:

```typescript
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : COMPONENT_HEALTH_SYSTEM_PROMPT,
```

- [ ] **Step 4: Update `handleFix` body type and prompt**

Find `handleFix` (line 221). Add `systemPrompt?: string` to its local body type and use it:

```typescript
  let body: { model: string; collectionStructure: unknown; auditGroupId: string; systemPrompt?: string };
```

Then in the `createStreamingProxy` call:

```typescript
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : FIX_SYSTEM_PROMPT,
```

- [ ] **Step 5: Update `handleGeneric` body type and prompt**

Find `handleGeneric` (line 249). Add `systemPrompt?: string` to its local body type and use it:

```typescript
  let body: { model: string; variableData: unknown; auditGroupId: string; variablesCount: number; systemPrompt?: string };
```

Then in the `createStreamingProxy` call:

```typescript
    systemPrompt: (body.systemPrompt && body.systemPrompt.trim()) ? body.systemPrompt : GENERIC_SYSTEM_PROMPT,
```

- [ ] **Step 6: Build and verify no TypeScript errors**

```bash
pnpm --filter worker build
```

Expected: build succeeds with no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat: accept optional systemPrompt override in all audit endpoints"
```

---

### Task 2: Plugin `code.ts` — load and persist custom prompts

**Files:**
- Modify: `apps/figma-plugin/code.ts`

`code.ts` needs to read `figma.root.getPluginData("customPrompts")` on init and send it to the UI, and handle two new message types for reading and saving.

- [ ] **Step 1: Add `save-custom-prompts` and `get-custom-prompts` to the message handler type**

In `code.ts`, find the `figma.ui.onmessage` handler at line 645. The `msg` type destructures specific fields. Add `customPrompts` to the type:

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
  customPrompts?: Record<string, string>;
}) => {
```

- [ ] **Step 2: Add `save-custom-prompts` handler**

After the `notify` handler near line 803, add:

```typescript
  if (msg.type === "save-custom-prompts" && msg.customPrompts !== undefined) {
    figma.root.setPluginData("customPrompts", JSON.stringify(msg.customPrompts));
    figma.ui.postMessage({ type: "custom-prompts-saved" });
  }

  if (msg.type === "get-custom-prompts") {
    const raw = figma.root.getPluginData("customPrompts");
    let prompts: Record<string, string> = {};
    try { prompts = raw ? JSON.parse(raw) : {}; } catch (_) {}
    figma.ui.postMessage({ type: "custom-prompts", data: prompts });
  }
```

- [ ] **Step 3: Send custom prompts during `initPlugin`**

In `initPlugin` (line 821), after the existing auth/data loading, add a call to read and send custom prompts:

```typescript
async function initPlugin(): Promise<void> {
  // Auth: check for existing token or trigger registration
  const existingToken = await figma.clientStorage.getAsync("api_token") as string | undefined;
  if (existingToken) {
    figma.ui.postMessage({ type: "auth-ready", token: existingToken });
  } else {
    const user = figma.currentUser;
    if (user && user.id) {
      figma.ui.postMessage({
        type: "register-user",
        figmaUserId: user.id,
        figmaUserName: user.name || "Unknown",
      });
    }
  }

  // Load variable, style, and component data
  await loadVariableData();
  await loadStyleData();
  await loadAndSendComponentData();

  // Send file-level custom prompts to UI
  const rawPrompts = figma.root.getPluginData("customPrompts");
  let customPrompts: Record<string, string> = {};
  try { customPrompts = rawPrompts ? JSON.parse(rawPrompts) : {}; } catch (_) {}
  figma.ui.postMessage({ type: "custom-prompts", data: customPrompts });
}
```

- [ ] **Step 4: Build and verify no TypeScript errors**

```bash
pnpm --filter figma-plugin build
```

Expected: build succeeds with no errors and `code.js` is updated.

- [ ] **Step 5: Commit**

```bash
git add apps/figma-plugin/code.ts
git commit -m "feat: load and persist custom prompts via figma.root plugin data"
```

---

### Task 3: Plugin UI — in-memory state and Settings tab

**Files:**
- Modify: `apps/figma-plugin/ui.html`
- Modify: `apps/figma-plugin/ui.css`

This task adds the Settings nav tab and wires up the `custom-prompts` message from `code.ts` into an in-memory `customPrompts` variable.

The 6 prompt keys match what the worker expects: `primitives`, `themes`, `components`, `component-health`, `generic`, `fix`.

- [ ] **Step 1: Add `customPrompts` state variable**

In `ui.html`, in the `// ─── Configuration` section near line 72, add after the other state variables (`variableData`, `componentData`, etc.):

```javascript
  var customPrompts = {};
```

- [ ] **Step 2: Add "Settings" button to the nav**

Find the nav HTML near line 6:

```html
  <div id="nav">
    <button class="active" data-nav="audit">Audit</button>
    <button data-nav="guide">Guide</button>
  </div>
```

Change to:

```html
  <div id="nav">
    <button class="active" data-nav="audit">Audit</button>
    <button data-nav="guide">Guide</button>
    <button data-nav="settings">Settings</button>
  </div>
```

- [ ] **Step 3: Handle `custom-prompts` message from code.ts**

In the `window.onmessage` handler (around line 199), add after the existing `component-data` handler:

```javascript
    if (msg.type === "custom-prompts") {
      customPrompts = msg.data || {};
    }
```

- [ ] **Step 4: Add settings view rendering function**

After the `showDefaultView` function, add `showSettingsView`:

```javascript
  var PROMPT_LABELS = [
    { key: "primitives",       label: "Primitives" },
    { key: "themes",           label: "Themes" },
    { key: "components",       label: "Components" },
    { key: "component-health", label: "Component Health" },
    { key: "generic",          label: "Generic (full audit)" },
    { key: "fix",              label: "Architecture Fix" },
  ];

  function showSettingsView() {
    var list = document.createElement("div");
    list.className = "prompt-list";

    for (var i = 0; i < PROMPT_LABELS.length; i++) {
      (function (entry) {
        var row = document.createElement("div");
        row.className = "prompt-row";

        var nameEl = document.createElement("span");
        nameEl.className = "prompt-row-name";
        nameEl.textContent = entry.label;

        var right = document.createElement("div");
        right.className = "prompt-row-right";

        if (customPrompts[entry.key]) {
          var badge = document.createElement("span");
          badge.className = "prompt-badge";
          badge.textContent = "customized";
          right.appendChild(badge);
        }

        var editBtn = document.createElement("button");
        editBtn.textContent = "Edit";
        editBtn.addEventListener("click", function () {
          showPromptEditor(entry);
        });
        right.appendChild(editBtn);

        row.appendChild(nameEl);
        row.appendChild(right);
        list.appendChild(row);
      })(PROMPT_LABELS[i]);
    }

    setSlots(null, list, null);
  }
```

- [ ] **Step 5: Handle Settings nav tab switching**

In the nav click handler (around line 99), extend the `if/else` chain that currently handles `guide`:

```javascript
      if (target === "guide") {
        // Save current audit content, show guide
        auditMiddleContent = document.createDocumentFragment();
        while (slotMiddle.firstChild) auditMiddleContent.appendChild(slotMiddle.firstChild);
        slotMiddle.appendChild(guideContent);
        guideContent.style.display = "";
      } else if (target === "settings") {
        // Save current audit content, show settings
        auditMiddleContent = document.createDocumentFragment();
        while (slotMiddle.firstChild) auditMiddleContent.appendChild(slotMiddle.firstChild);
        showSettingsView();
      } else {
        // Restore audit content
        guideContent.style.display = "none";
        slotMiddle.appendChild(guideContent); // park it
        clearEl(slotMiddle);
        slotMiddle.appendChild(guideContent); // keep in DOM but hidden
        if (auditMiddleContent) {
          slotMiddle.insertBefore(auditMiddleContent, guideContent);
          auditMiddleContent = null;
        }
      }
```

- [ ] **Step 6: Add CSS for settings UI**

In `apps/figma-plugin/ui.css`, append at the end:

```css
/* ─── Settings / Prompt list ───────────────────────────────────── */

.prompt-list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  overflow-y: auto;
}

.prompt-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}

.prompt-row-name {
  font-weight: 500;
  color: var(--text-primary);
}

.prompt-row-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.prompt-badge {
  font-size: 10px;
  font-weight: 600;
  color: var(--note);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
```

- [ ] **Step 7: Build and smoke-test**

```bash
pnpm --filter figma-plugin build
```

Load the plugin in Figma. Verify:
- The Settings tab appears in the nav
- Clicking Settings shows a list of 6 prompt rows
- Each row has an "Edit" button
- Rows for un-customized prompts show no badge

- [ ] **Step 8: Commit**

```bash
git add apps/figma-plugin/ui.html apps/figma-plugin/ui.css
git commit -m "feat: add Settings tab with prompt list to plugin UI"
```

---

### Task 4: Plugin UI — prompt editor

**Files:**
- Modify: `apps/figma-plugin/ui.html`
- Modify: `apps/figma-plugin/ui.css`

This task implements the editor view: a full-panel dark textarea with save/reset/back controls.

The editor needs access to the default prompt text. Because prompts live in `apps/worker/src/prompts.ts` (TypeScript, server-side), the UI cannot import them directly. We embed the defaults as a JS object in `ui.html`.

- [ ] **Step 1: Embed default prompts in `ui.html`**

In the `// ─── Configuration` section, after `var customPrompts = {};`, add the default prompt texts as a constant. These are copied verbatim from `apps/worker/src/prompts.ts` (the exported string values, without the TS export syntax):

```javascript
  var DEFAULT_PROMPTS = {
    "primitives": "You are a Figma variable auditor for the PRIMITIVES collection.\n\nGolden rule: a primitive name must never imply how, where, or why a value is used. If you can tell from the name how or where something will be used, it is a violation.\n\nCanonical naming framework:\n- Most categories are flat: category/scale (e.g. spacing/4, radius/sm, font-size/md)\n- Color is the exception — it has multiple families (hues), so it uses three segments: color/family/scale (e.g. color/blue/500, color/gray/100)\n- No other category should use a family segment; spacing/padding/4 or font-size/body/md are violations\n\nStructure: two or three lowercase segments separated by \"/\".\n- Two segments: category/scale — required for all non-color categories\n- Three segments: category/family/scale — required for color, invalid for all other categories\n\nCategory: must describe a raw value type (color, spacing, radius, font-size, opacity, shadow, border-width, line-height, font-weight). Flag any category that implies a role, component, or usage context. Categories like \"layout\" are borderline — layout/content-max describes a raw dimension value and is acceptable, but flag it as a warning so the team can decide.\n\nFamily (color only): must be a raw hue or material name (blue, red, green, gray, slate, zinc…) — it describes what the color IS, not how it is used. Words that imply usage or role — \"brand\", \"danger\", \"primary\", \"button\", \"default\" — are violations. A family segment on any non-color category is also a violation.\n\nScale: must use one of these numeric conventions:\n- T-shirt sizes: xs, sm, md, lg, xl, 2xl, 3xl…\n- Tailwind-style color steps: 50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950\n- Direct numeric values for non-color primitives: 4, 13, 1.5…\nDescriptive words like \"large\", \"heavy\", \"dark\", \"light\" are violations. Scale values must always be their own standalone segment — never hyphenated into an adjacent word. \"paragraph-lg\" or \"heading-sm\" as a single segment is always an error; the scale must be split into a separate segment (e.g. \"paragraph/lg\"). All scales within a category must be consistent — do not mix t-shirt sizes with numeric steps in the same category.\n\nAliasing: primitives must have raw hardcoded values. A primitive where aliasId is not null is a violation.\n\nConsistency: identify the dominant pattern across the collection and flag any variable that deviates from it in structure or naming style.\n\nUnused variables: you will receive a list of \"unreferenced\" primitive variable names — these are not aliased by any theme variable. Flag each as a warning with rule \"Unused variable\" and suggest removal.\nSeverity levels — every violation must have a \"level\" field:\n- \"error\": clear structural violations that break the architecture. Examples: aliasing in primitives, semantic/role names (brand, danger, primary), hardcoded values in themes, wrong alias target.\n- \"warning\": borderline issues that may be intentional but deviate from best practice. Examples: unusual but defensible category names (e.g. layout/content-max — describes a raw value but is less conventional), unused variables, inconsistency with the dominant pattern.\n- \"note\": minor style suggestions that are not wrong per se. Examples: minor casing inconsistencies, a valid name that could be slightly more descriptive, missing states that are optional for the component type.\n\nAlways include the variable's id field in each violation so it can be used to apply fixes programmatically.\n\nYou must also return a \"passed\" array listing every variable that has NO violations. Each entry needs only: variable_id, variable (the name), and collection (\"primitives\").\n\nEvery violation must have:\n- collection: \"primitives\"\n- variable_id: the variable's id string\n- variable: the full variable name\n- level: \"error\", \"warning\", or \"note\"\n- rule: short label\n- explanation: one specific sentence explaining exactly what is wrong and why\n- options: array of 1–3 fix options, best first. Each option has \"name\" (the exact corrected variable name, e.g. \"color/blue/500\" — empty string for non-rename fixes), \"description\" (short human-readable reason, e.g. \"Matches the existing blue scale\"), and optionally \"action\": set to \"delete-variable\" when the fix is to delete the variable. Multiple options when more than one valid name exists (e.g. \"color/blue/500\" vs \"color/navy/500\").",
    "themes": "You are a Figma variable auditor for the THEMES collection.\n\nGolden rule: every theme variable must imply usage — it must answer \"how or where is this used?\"\n\nMode names: all lowercase, single word or hyphenated, no spaces. A file with one mode must name it \"default\". Theme modes represent semantic context switches — light, dark, brand variants, or similar. Viewport/responsive sizes (xs, sm, md, lg, xl, 2xl) are NOT valid theme mode names; they belong exclusively as modes in the components collection. Flag any theme mode named with a t-shirt size as an error.\n\nCanonical naming framework: category/role[/tone]\n- category: the kind of element or surface this value styles — e.g. surface, text, border, icon, action, feedback\n- role: what the value IS within that category — prefer \"background\" (fill/surface color) and \"foreground\" (content/text color placed on that surface) as the primary role names. Other valid roles: border, shadow, outline, ring\n- tone (optional third segment): a modifier that adjusts intensity or context — e.g. subtle, strong, inverse, on-brand. Must NOT be a viewport size.\n\nExamples of well-named theme variables:\n  surface/background, surface/foreground\n  text/foreground, text/foreground/subtle, text/foreground/inverse\n  action/background, action/foreground, action/border\n  feedback/error/background, feedback/error/foreground\n  border/default, border/strong, border/focus\n\nVariable names: must be semantic. Flag any name that looks like a primitive — contains a raw colour name, a numeric scale, or describes a raw value rather than a usage context. Size suffixes must never be embedded in a segment (e.g. \"paragraph-lg\", \"heading-sm\") — responsive variation is handled entirely through component modes, not through variable names. Flag any variable whose name encodes a viewport or size suffix as an error.\n\nAliasing: every theme variable must alias a primitive. You will receive a list of valid primitive variable names. A hardcoded value (aliasId is null) is a violation. An alias pointing to a variable NOT in the primitives list is a violation.\n\nConsistency: identify the dominant segment depth and style and flag deviations.\n\nUnused variables: you will receive a list of \"unreferenced\" theme variable names — these are not aliased by any component variable. Flag each as a violation with rule \"Unused variable\" and suggest removal.\n\nUnused variables: flag each as a warning.\nSeverity levels — every violation must have a \"level\" field:\n- \"error\": clear structural violations that break the architecture.\n- \"warning\": borderline issues that may be intentional but deviate from best practice.\n- \"note\": minor style suggestions that are not wrong per se.\n\nAlways include the variable's id field in each violation.\n\nYou must also return a \"passed\" array listing every variable that has NO violations. Each entry needs only: variable_id, variable (the name), and collection (\"themes\").\n\nEvery violation must have:\n- collection: \"themes\"\n- variable_id: the variable's id string\n- variable: the full variable name\n- level: \"error\", \"warning\", or \"note\"\n- rule: short label\n- explanation: one specific sentence explaining exactly what is wrong and why\n- options: array of 1–3 fix options, best first.",
    "components": "You are a Figma variable auditor for the COMPONENTS collection.\n\nGolden rule: every variable must be traceable to a specific component, a specific property, and a specific state.\n\nCanonical naming framework — mixed depth:\n- Atomic components (single-element): component/property/state — e.g. badge/background/default, tag/foreground/default\n- Composite components (named sub-elements): component/element/property/state — e.g. card/header/background/default, input/icon/foreground/disabled\n- The rule: if the component has distinct named sub-elements (header, footer, icon, label, item, trigger, overlay), use 4 segments. If it is atomic, use 3. Mixing depths within the same component is a violation.\n- Property names should use background, foreground, border, shadow, outline, radius — mirroring the theme layer convention.\n\nComponent name: the first segment must match a real component name in the design system, lowercase. Flag abbreviations or capitalisation differences.\n\nAliasing: component variables must alias a theme variable. You will receive a list of valid theme variable names. Aliasing a primitive directly is a violation. A hardcoded value is a violation. An alias pointing to a variable NOT in the themes list is a violation.\n\nMode names: only t-shirt sizes allowed (xs, sm, md, lg, xl, 2xl…), lowercase. This is the designated layer for viewport/responsive variation — size differences between breakpoints are expressed here as modes, not in variable names. Flag any descriptive mode names. Variable names within a mode must not repeat or encode the size (e.g. a variable named \"button/label-lg\" inside an \"lg\" mode is a violation — the size is already captured by the mode).\n\nStates: check each component's variable set against common interaction states: default, hover, focus, active, disabled, error, loading, selected, pressed, visited. Flag missing states that would be expected for the component type as a \"note\". Check consistency — if most interactive components define hover, flag any that do not as a \"warning\".\nSeverity levels — every violation must have a \"level\" field:\n- \"error\": clear structural violations.\n- \"warning\": borderline issues.\n- \"note\": minor style suggestions.\n\nAlways include the variable's id field in each violation.\n\nYou must also return a \"passed\" array listing every variable that has NO violations. Each entry needs only: variable_id, variable (the name), and collection (\"components\").\n\nEvery violation must have:\n- collection: \"components\"\n- variable_id: the variable's id string\n- variable: the full variable name\n- level: \"error\", \"warning\", or \"note\"\n- rule: short label\n- explanation: one specific sentence explaining exactly what is wrong and why\n- options: array of 1–3 fix options, best first.",
    "component-health": "You are a Figma component health auditor. You receive serialized data about every component and component set in a Figma file. Your job is to evaluate each component's quality, completeness, and token adoption.\n\nFor each component you receive:\n- name, description, key\n- publishStatus: \"UNPUBLISHED\", \"CHANGED\", or \"CURRENT\"\n- isComponentSet: whether it is a multi-variant component set\n- variantProperties: the variant dimensions and their options (e.g. State: [Default, Hover, Pressed, Disabled])\n- tokenCoverage: { total, bound, raw } — how many inspectable properties exist, how many use variable/token bindings, how many use raw hardcoded values\n- rawValues: sample list of raw values found (layer path, property, value)\n\nRules:\n\n**Interaction states** (error if missing critical states, warning for nice-to-have):\n- Interactive components (buttons, inputs, links, toggles, checkboxes, radio buttons, selects, tabs, switches) MUST have a \"State\" (or similarly named) variant property. If they do, check for these states:\n  - Required (error if missing): default, hover, disabled\n  - Expected (warning if missing): focus, pressed/active\n  - Nice to have (note if missing): error, loading\n- Non-interactive components (cards, badges, avatars, dividers, icons) do NOT need state variants — do not flag them.\n- Use the component name to infer whether it is interactive.\n\n**Token adoption** (error for high raw value count):\n- If tokenCoverage.raw > 0 and tokenCoverage.total > 0:\n  - Raw ratio > 50%: error — \"Low token adoption\"\n  - Raw ratio 20–50%: warning — \"Partial token adoption\"\n  - Raw ratio < 20%: note — \"Minor raw values remaining\"\n\n**Publication status**:\n- publishStatus \"UNPUBLISHED\": warning\n- publishStatus \"CHANGED\": note\n\n**Description**: empty description: note\n\n**Naming**: PascalCase or Title Case expected.\nSeverity levels — every violation must have a \"level\" field:\n- \"error\": clear structural violations.\n- \"warning\": borderline issues.\n- \"note\": minor style suggestions.\n\nUse the component node ID as the variable_id field. Use \"component-health\" as the collection.\n\nYou must also return a \"passed\" array listing every component that has NO violations.\n\nEvery violation must have: collection, variable_id, variable, level, rule, explanation, options.",
    "generic": "You are a Figma variable architecture auditor. You receive a structured JSON object containing all variable collections from a Figma file, including each variable's id, name, type, and whether its value is aliased or hardcoded. You must audit every collection and every variable against the rules below and return only violations — do not mention passing variables.\n\nAlways include the variable's id field in each violation so it can be used to apply fixes programmatically.\n\n**Collection: primitives (if present)**\nGolden rule: a primitive name must never imply how, where, or why a value is used.\nFramework: category/scale (e.g. spacing/4) or color/family/scale (e.g. color/blue/500). No other category may use a family segment.\nAliasing: primitives must have raw hardcoded values.\n\n**Collection: themes (if present)**\nGolden rule: every theme variable must imply usage.\nFramework: category/role[/tone]. Theme modes: lowercase, semantic context switches only (light, dark). No t-shirt size mode names.\nAliasing: every theme variable must alias a primitive.\n\n**Collection: components (if present)**\nGolden rule: every variable must be traceable to a specific component, property, and state.\nFramework: component/property/state (atomic) or component/element/property/state (composite).\nAliasing: component variables must alias a theme variable.\nMode names: only t-shirt sizes.\n\nFor all collections: identify dominant naming pattern and flag deviations. Flag unused variables.\nSeverity levels — every violation must have a \"level\" field: \"error\", \"warning\", or \"note\".\n\nYou must also return a \"passed\" array listing every variable that has NO violations. Each entry needs only: variable_id, variable (the name), and collection.\n\nEvery violation must have: collection, variable_id, variable, level, rule, explanation, options.",
    "fix": "You are a Figma variable architecture advisor. The user's file has architecture violations — the expected structure is exactly three collections: \"primitives\", \"themes\", \"components\" (all lowercase).\n\nYou will receive the current collection structure (names, variable counts, and variable names with their types). Analyze the issues and suggest concrete fixes.\n\nAvailable fix actions:\n- rename-collection: rename a collection (provide collectionId and newName)\n- move-variables: move variables from one collection to another (provide variableIds and targetCollectionId)\n- create-collection: create a new empty collection (provide name)\n- delete-collection: delete a collection (provide collectionId)\n- delete-variable: remove a variable (provide variableId)\n\nFor each fix, provide:\n- action: one of the action types above\n- description: human-readable explanation of what this fix does\n- params: the parameters needed (use the exact IDs provided in the input)\n\nOrder fixes logically — create collections before moving variables into them. Be specific about which variables should move where based on their names and types.",
  };
```

- [ ] **Step 2: Add `showPromptEditor` function**

After `showSettingsView`, add:

```javascript
  function showPromptEditor(entry) {
    var isCustomized = !!customPrompts[entry.key];
    var initialText = isCustomized ? customPrompts[entry.key] : DEFAULT_PROMPTS[entry.key];

    var header = document.createElement("div");
    header.className = "editor-header";

    var backBtn = document.createElement("button");
    backBtn.className = "editor-back";
    backBtn.textContent = "\u2190 Back";

    var titleEl = document.createElement("span");
    titleEl.className = "editor-title";
    titleEl.textContent = entry.label;

    var headerRight = document.createElement("div");
    headerRight.className = "editor-header-right";

    var resetBtn = null;
    if (isCustomized) {
      resetBtn = document.createElement("button");
      resetBtn.className = "editor-reset";
      resetBtn.textContent = "Reset to default";
      headerRight.appendChild(resetBtn);
    }

    header.appendChild(backBtn);
    header.appendChild(titleEl);
    header.appendChild(headerRight);

    var textarea = document.createElement("textarea");
    textarea.className = "prompt-editor-textarea";
    textarea.value = initialText;
    textarea.spellcheck = false;

    var footer = document.createElement("div");
    footer.className = "editor-footer";

    var saveBtn = document.createElement("button");
    saveBtn.className = "primary-btn";
    saveBtn.textContent = "Save";
    footer.appendChild(saveBtn);

    // Back: discard confirmation if changed
    backBtn.addEventListener("click", function () {
      if (textarea.value !== initialText) {
        if (!confirm("Discard unsaved changes?")) return;
      }
      showSettingsView();
      // Switch nav to settings
      for (var j = 0; j < navBtns.length; j++) {
        navBtns[j].classList.toggle("active", navBtns[j].getAttribute("data-nav") === "settings");
      }
      activeNav = "settings";
    });

    // Reset: delete key and go back to list
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        if (!confirm("Reset this prompt to the default? Your custom version will be deleted.")) return;
        delete customPrompts[entry.key];
        parent.postMessage({ pluginMessage: { type: "save-custom-prompts", customPrompts: customPrompts } }, "*");
        showSettingsView();
        for (var j = 0; j < navBtns.length; j++) {
          navBtns[j].classList.toggle("active", navBtns[j].getAttribute("data-nav") === "settings");
        }
        activeNav = "settings";
      });
    }

    // Save: persist and go back to list
    saveBtn.addEventListener("click", function () {
      var text = textarea.value.trim();
      if (!text) return;
      customPrompts[entry.key] = text;
      parent.postMessage({ pluginMessage: { type: "save-custom-prompts", customPrompts: customPrompts } }, "*");
      showSettingsView();
      for (var j = 0; j < navBtns.length; j++) {
        navBtns[j].classList.toggle("active", navBtns[j].getAttribute("data-nav") === "settings");
      }
      activeNav = "settings";
    });

    // Render using setSlots: header in top, textarea in middle, footer in bottom
    clearEl(slotTop);
    clearEl(slotMiddle);
    clearEl(slotBottom);
    slotMiddle.appendChild(guideContent);
    guideContent.style.display = "none";
    slotTop.style.display = "";
    slotTop.appendChild(header);
    slotMiddle.insertBefore(textarea, guideContent);
    slotBottom.appendChild(footer);
    // switch nav highlight to settings
    for (var j = 0; j < navBtns.length; j++) {
      navBtns[j].classList.toggle("active", navBtns[j].getAttribute("data-nav") === "settings");
    }
    activeNav = "settings";
  }
```

- [ ] **Step 3: Fix `setSlots` to reset `slotTop` display**

The existing `setSlots` function hides `slotTop` (it's `display: none` in CSS by default). The editor uses `slotTop` directly — so when returning to the normal views, `slotTop` must be hidden again. In `showDefaultView` and `showSettingsView`, add `slotTop.style.display = "none";` at the top:

In `showDefaultView`:
```javascript
  function showDefaultView() {
    slotTop.style.display = "none";
    inventoryEl = document.createElement("div");
    // ... rest unchanged
```

In `showSettingsView`:
```javascript
  function showSettingsView() {
    slotTop.style.display = "none";
    var list = document.createElement("div");
    // ... rest unchanged
```

Also in `setSlots`, add `slotTop.style.display = "none";` at the top of the function:
```javascript
  function setSlots(top, middle, bottom) {
    slotTop.style.display = "none";
    clearEl(slotTop);
    // ... rest unchanged
```

- [ ] **Step 4: Add CSS for editor**

In `apps/figma-plugin/ui.css`, append after the prompt list styles:

```css
/* ─── Prompt editor ─────────────────────────────────────────────── */

.editor-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 10px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}

.editor-back {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--note);
  font-size: 12px;
  padding: 0;
  flex-shrink: 0;
}

.editor-title {
  font-weight: 600;
  flex: 1;
}

.editor-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.editor-reset {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 11px;
  padding: 0;
  text-decoration: underline;
}

.prompt-editor-textarea {
  width: 100%;
  height: 100%;
  font-family: monospace;
  font-size: 11px;
  line-height: 1.5;
  background: #1e1e1e;
  color: #d4d4d4;
  border: none;
  outline: none;
  resize: none;
  padding: 10px;
  border-radius: 4px;
  display: block;
}

.editor-footer {
  display: flex;
  justify-content: flex-end;
  padding-top: 10px;
}
```

- [ ] **Step 5: Build and smoke-test**

```bash
pnpm --filter figma-plugin build
```

Load the plugin in Figma. Verify:
- Clicking "Edit" on any prompt opens the editor view
- The textarea shows the default prompt text in dark monospace styling
- "Back" returns to the settings list (with discard confirmation if text was changed)
- "Save" writes to storage and returns to the list with "customized" badge shown

- [ ] **Step 6: Commit**

```bash
git add apps/figma-plugin/ui.html apps/figma-plugin/ui.css
git commit -m "feat: add prompt editor with dark textarea, save, reset, and back controls"
```

---

### Task 5: Plugin UI — pass custom prompts to audit requests

**Files:**
- Modify: `apps/figma-plugin/ui.html`

When running an audit, if `customPrompts` has an entry for the relevant collection key, include it as `systemPrompt` in the fetch body.

- [ ] **Step 1: Add `systemPrompt` to `runSingleAgent`**

In `runSingleAgent` (around line 881), find the `JSON.stringify` call that builds the request body. Change it to:

```javascript
        body: JSON.stringify({
          model: agent.model,
          collectionData: agent.collection,
          referenceNames: agent.referenceNames,
          unreferencedNames: agent.unreferencedNames,
          auditGroupId: auditGroupId,
          variablesCount: agent.collection.variables.length,
          systemPrompt: customPrompts[agent.name] || undefined,
        }),
```

- [ ] **Step 2: Add `systemPrompt` to `runComponentHealthAgent`**

Find `runComponentHealthAgent` in `ui.html` (search for `/audit/component-health`). In its fetch body, add:

```javascript
          systemPrompt: customPrompts["component-health"] || undefined,
```

- [ ] **Step 3: Add `systemPrompt` to `runGenericAudit`**

In `runGenericAudit` (around line 753), in the `JSON.stringify` body add:

```javascript
          systemPrompt: customPrompts["generic"] || undefined,
```

- [ ] **Step 4: Add `systemPrompt` to `runFixAgent`**

In `runFixAgent` (around line 663), in the `JSON.stringify` body add:

```javascript
          systemPrompt: customPrompts["fix"] || undefined,
```

- [ ] **Step 5: Build**

```bash
pnpm --filter figma-plugin build
```

Expected: no errors.

- [ ] **Step 6: End-to-end smoke test**

In Figma:
1. Open Settings → Edit the "Primitives" prompt → add a line like `// test custom prompt` at the top → Save
2. Return to Audit tab → Run audit
3. The primitives audit should still return valid JSON (the model still gets a valid-ish prompt). Confirm no crash.
4. Go back to Settings → "customized" badge is on Primitives → Reset to default → badge disappears.

- [ ] **Step 7: Commit**

```bash
git add apps/figma-plugin/ui.html
git commit -m "feat: pass custom systemPrompt to worker when file has customized prompts"
```

---

### Task 6: Deploy worker

- [ ] **Step 1: Deploy to Cloudflare**

```bash
pnpm --filter worker deploy
```

Expected: deployment succeeds, worker URL remains the same.

- [ ] **Step 2: Commit build artifacts if needed**

The worker deploys directly; no build artifacts are committed. This step is a no-op unless `wrangler.jsonc` changed.

---

## Self-Review

**Spec coverage:**
- ✅ 6 prompts selectable from a list
- ✅ Full replacement (not append)
- ✅ File-level storage via `figma.root.setPluginData`
- ✅ Shared across all users of the file
- ✅ Dark monospace textarea editor
- ✅ "customized" badge in the list
- ✅ Reset to default
- ✅ Discard confirmation on Back
- ✅ Worker uses custom `systemPrompt` if present
- ✅ Settings tab in nav

**Placeholder scan:** None found.

**Type consistency:**
- `customPrompts` is `Record<string, string>` throughout
- `entry.key` matches keys in `DEFAULT_PROMPTS` and `customPrompts`
- `agent.name` in `runSingleAgent` matches prompt keys: `primitives`, `themes`, `components`
- `component-health`, `generic`, `fix` are handled separately in their own fetch calls
