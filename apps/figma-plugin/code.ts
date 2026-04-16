figma.showUI(__html__, { width: 800, height: 800 });

interface SerializedVariableValue {
  aliasId: string | null;
  value: string | null;
}

interface SerializedVariable {
  id: string;
  name: string;
  type: string;
  valuesByMode: Record<string, SerializedVariableValue>;
}

interface SerializedCollection {
  name: string;
  modes: string[];
  variables: SerializedVariable[];
}

interface RawValueEntry {
  layerName: string;
  layerPath: string;
  property: string;
  value: string;
}

interface SerializedComponentVariant {
  type: string;
  defaultValue: string;
  options: string[];
}

interface SerializedComponent {
  id: string;
  name: string;
  key: string;
  description: string;
  publishStatus: string;
  isComponentSet: boolean;
  variantCount: number;
  variantProperties: Record<string, SerializedComponentVariant>;
  tokenCoverage: {
    total: number;
    bound: number;
    raw: number;
  };
  rawValues: RawValueEntry[];
}

interface BrokenReference {
  variableId: string;
  variableName: string;
  collection: string;
  mode: string;
  brokenAliasId: string;
  source: "variable" | "style";
  styleType?: string;
  property?: string;
}

interface UnboundStyleProperty {
  styleName: string;
  styleType: "PAINT" | "TEXT" | "EFFECT" | "GRID";
  property: string;
  currentValue: string;
}

function stringifyValue(
  value: unknown,
  type: VariableResolvedDataType,
): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value);
  }
  if (type === "COLOR" && typeof value === "object") {
    const c = value as { r: number; g: number; b: number; a?: number };
    const r = Math.round((c.r || 0) * 255);
    const g = Math.round((c.g || 0) * 255);
    const b = Math.round((c.b || 0) * 255);
    const a = c.a !== undefined ? c.a : 1;
    if (a < 1) {
      return `rgba(${r}, ${g}, ${b}, ${a.toFixed(2)})`;
    }
    return (
      "#" +
      r.toString(16).padStart(2, "0") +
      g.toString(16).padStart(2, "0") +
      b.toString(16).padStart(2, "0")
    ).toUpperCase();
  }
  return JSON.stringify(value);
}

async function checkBoundVariable(variableAlias: {
  type: string;
  id: string;
}): Promise<boolean> {
  const resolved = await figma.variables.getVariableByIdAsync(variableAlias.id);
  return resolved === null;
}

async function scanStyleBoundVariables(
  brokenReferences: BrokenReference[],
): Promise<void> {
  // Paint styles (fill/stroke colors)
  const paintStyles = await figma.getLocalPaintStylesAsync();
  for (const style of paintStyles) {
    for (let i = 0; i < style.paints.length; i++) {
      const paint = style.paints[i];
      const bound = (paint as any).boundVariables;
      if (!bound) continue;
      for (const prop of Object.keys(bound)) {
        const alias = bound[prop];
        if (alias && alias.type === "VARIABLE_ALIAS") {
          const isBroken = await checkBoundVariable(alias);
          if (isBroken) {
            brokenReferences.push({
              variableId: style.id,
              variableName: style.name,
              collection: "Paint styles",
              mode: "paint[" + i + "]." + prop,
              brokenAliasId: alias.id,
              source: "style",
              styleType: "PAINT",
              property: prop,
            });
          }
        }
      }
    }
  }

  // Text styles
  const textStyles = await figma.getLocalTextStylesAsync();
  for (const style of textStyles) {
    const bound = (style as any).boundVariables;
    if (!bound) continue;
    for (const prop of Object.keys(bound)) {
      const alias = bound[prop];
      if (alias && alias.type === "VARIABLE_ALIAS") {
        const isBroken = await checkBoundVariable(alias);
        if (isBroken) {
          brokenReferences.push({
            variableId: style.id,
            variableName: style.name,
            collection: "Text styles",
            mode: prop,
            brokenAliasId: alias.id,
            source: "style",
            styleType: "TEXT",
            property: prop,
          });
        }
      }
    }
  }

  // Effect styles (shadows, blurs)
  const effectStyles = await figma.getLocalEffectStylesAsync();
  for (const style of effectStyles) {
    for (let i = 0; i < style.effects.length; i++) {
      const effect = style.effects[i];
      const bound = (effect as any).boundVariables;
      if (!bound) continue;
      for (const prop of Object.keys(bound)) {
        const alias = bound[prop];
        if (alias && alias.type === "VARIABLE_ALIAS") {
          const isBroken = await checkBoundVariable(alias);
          if (isBroken) {
            brokenReferences.push({
              variableId: style.id,
              variableName: style.name,
              collection: "Effect styles",
              mode: "effect[" + i + "]." + prop,
              brokenAliasId: alias.id,
              source: "style",
              styleType: "EFFECT",
              property: prop,
            });
          }
        }
      }
    }
  }

  // Grid styles
  const gridStyles = await figma.getLocalGridStylesAsync();
  for (const style of gridStyles) {
    for (let i = 0; i < style.layoutGrids.length; i++) {
      const grid = style.layoutGrids[i];
      const bound = (grid as any).boundVariables;
      if (!bound) continue;
      for (const prop of Object.keys(bound)) {
        const alias = bound[prop];
        if (alias && alias.type === "VARIABLE_ALIAS") {
          const isBroken = await checkBoundVariable(alias);
          if (isBroken) {
            brokenReferences.push({
              variableId: style.id,
              variableName: style.name,
              collection: "Grid styles",
              mode: "grid[" + i + "]." + prop,
              brokenAliasId: alias.id,
              source: "style",
              styleType: "GRID",
              property: prop,
            });
          }
        }
      }
    }
  }
}

async function isBindingValid(binding: unknown): Promise<boolean> {
  if (!binding) return false;

  // TextStyle boundVariables are arrays: [{ type: "VARIABLE_ALIAS", variableId: "..." }]
  // Paint/Effect boundVariables are objects: { type: "VARIABLE_ALIAS", id: "..." }
  let varId: string | null = null;

  if (Array.isArray(binding)) {
    const first = binding[0];
    if (!first) return false;
    varId = first.variableId || first.id || null;
  } else if (typeof binding === "object") {
    const obj = binding as any;
    if (obj.type !== "VARIABLE_ALIAS") return false;
    varId = obj.variableId || obj.id || null;
  }

  if (!varId) return false;
  const resolved = await figma.variables.getVariableByIdAsync(varId);
  return resolved !== null;
}

async function scanUnboundStyleProperties(): Promise<UnboundStyleProperty[]> {
  const unbound: UnboundStyleProperty[] = [];

  // Paint styles — check each paint for color binding
  const paintStyles = await figma.getLocalPaintStylesAsync();
  for (const style of paintStyles) {
    for (let i = 0; i < style.paints.length; i++) {
      const paint = style.paints[i];
      const bound = (paint as any).boundVariables || {};
      if (paint.type === "SOLID") {
        const valid = await isBindingValid(bound.color);
        if (!valid) {
          const c = (paint as SolidPaint).color;
          const r = Math.round(c.r * 255);
          const g = Math.round(c.g * 255);
          const b = Math.round(c.b * 255);
          unbound.push({
            styleName: style.name,
            styleType: "PAINT",
            property:
              style.paints.length > 1 ? "color (paint " + i + ")" : "color",
            currentValue:
              "#" +
              r.toString(16).padStart(2, "0") +
              g.toString(16).padStart(2, "0") +
              b.toString(16).padStart(2, "0"),
          });
        }
      }
    }
  }

  // Text styles — check all bindable properties
  const textStyles = await figma.getLocalTextStylesAsync();
  const textProps: Array<{
    key: string;
    label: string;
    format: (style: TextStyle) => string;
  }> = [
    {
      key: "fontSize",
      label: "fontSize",
      format: function (s) {
        return s.fontSize + "px";
      },
    },
    {
      key: "lineHeight",
      label: "lineHeight",
      format: function (s) {
        var lh = s.lineHeight as any;
        if (lh.unit === "AUTO") return "AUTO";
        return lh.unit === "PERCENT" ? lh.value + "%" : lh.value + "px";
      },
    },
    {
      key: "letterSpacing",
      label: "letterSpacing",
      format: function (s) {
        var ls = s.letterSpacing as any;
        return ls.unit === "PERCENT" ? ls.value + "%" : ls.value + "px";
      },
    },
    {
      key: "paragraphSpacing",
      label: "paragraphSpacing",
      format: function (s) {
        return s.paragraphSpacing + "px";
      },
    },
    {
      key: "fontFamily",
      label: "fontFamily",
      format: function (s) {
        return s.fontName.family;
      },
    },
    {
      key: "fontStyle",
      label: "fontStyle",
      format: function (s) {
        return s.fontName.style;
      },
    },
  ];

  for (const style of textStyles) {
    const bound = (style as any).boundVariables || {};
    for (const prop of textProps) {
      const valid = await isBindingValid(bound[prop.key]);
      if (!valid) {
        unbound.push({
          styleName: style.name,
          styleType: "TEXT",
          property: prop.label,
          currentValue: prop.format(style),
        });
      }
    }
  }

  // Effect styles — check color, spread, radius on each effect
  const effectStyles = await figma.getLocalEffectStylesAsync();
  for (const style of effectStyles) {
    for (let i = 0; i < style.effects.length; i++) {
      const effect = style.effects[i];
      const bound = (effect as any).boundVariables || {};
      const prefix = style.effects.length > 1 ? "effect[" + i + "]." : "";

      if ("color" in effect && !(await isBindingValid(bound.color))) {
        const c = (effect as any).color;
        if (c) {
          const r = Math.round((c.r || 0) * 255);
          const g = Math.round((c.g || 0) * 255);
          const b = Math.round((c.b || 0) * 255);
          unbound.push({
            styleName: style.name,
            styleType: "EFFECT",
            property: prefix + "color",
            currentValue:
              "#" +
              r.toString(16).padStart(2, "0") +
              g.toString(16).padStart(2, "0") +
              b.toString(16).padStart(2, "0"),
          });
        }
      }
      if (
        "radius" in effect &&
        (effect as any).radius !== 0 &&
        !(await isBindingValid(bound.radius))
      ) {
        unbound.push({
          styleName: style.name,
          styleType: "EFFECT",
          property: prefix + "radius",
          currentValue: (effect as any).radius + "px",
        });
      }
      if (
        "spread" in effect &&
        (effect as any).spread !== 0 &&
        !(await isBindingValid(bound.spread))
      ) {
        unbound.push({
          styleName: style.name,
          styleType: "EFFECT",
          property: prefix + "spread",
          currentValue: (effect as any).spread + "px",
        });
      }
    }
  }

  return unbound;
}

// ─── Component health scanning ──────────────────────────────────────

function countBoundVariables(
  node: SceneNode,
  rawValues: RawValueEntry[],
  path: string,
): { total: number; bound: number } {
  let total = 0;
  let bound = 0;
  const bv = (node as any).boundVariables || {};

  // Check fills
  if ("fills" in node && Array.isArray(node.fills)) {
    for (let i = 0; i < node.fills.length; i++) {
      total++;
      if (bv.fills && bv.fills[i]) {
        bound++;
      } else {
        const fill = node.fills[i] as Paint;
        if (fill.type === "SOLID") {
          const c = (fill as SolidPaint).color;
          const r = Math.round(c.r * 255);
          const g = Math.round(c.g * 255);
          const b = Math.round(c.b * 255);
          rawValues.push({
            layerName: node.name,
            layerPath: path,
            property: "fill",
            value:
              `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase(),
          });
        }
      }
    }
  }

  // Check strokes
  if ("strokes" in node && Array.isArray(node.strokes)) {
    for (let i = 0; i < node.strokes.length; i++) {
      total++;
      if (bv.strokes && bv.strokes[i]) {
        bound++;
      } else {
        const stroke = node.strokes[i] as Paint;
        if (stroke.type === "SOLID") {
          const c = (stroke as SolidPaint).color;
          const r = Math.round(c.r * 255);
          const g = Math.round(c.g * 255);
          const b = Math.round(c.b * 255);
          rawValues.push({
            layerName: node.name,
            layerPath: path,
            property: "stroke",
            value:
              `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`.toUpperCase(),
          });
        }
      }
    }
  }

  // Check effects
  if ("effects" in node && Array.isArray(node.effects)) {
    for (let i = 0; i < node.effects.length; i++) {
      total++;
      if (bv.effects && bv.effects[i]) {
        bound++;
      } else {
        rawValues.push({
          layerName: node.name,
          layerPath: path,
          property: "effect",
          value: node.effects[i].type,
        });
      }
    }
  }

  // Check spacing properties (padding, gap, border radius, etc.)
  const spacingProps = [
    "paddingTop",
    "paddingRight",
    "paddingBottom",
    "paddingLeft",
    "itemSpacing",
    "counterAxisSpacing",
    "topLeftRadius",
    "topRightRadius",
    "bottomLeftRadius",
    "bottomRightRadius",
    "strokeWeight",
  ] as const;

  for (const prop of spacingProps) {
    if (
      prop in node &&
      typeof (node as any)[prop] === "number" &&
      (node as any)[prop] !== 0
    ) {
      total++;
      if (bv[prop]) {
        bound++;
      } else {
        rawValues.push({
          layerName: node.name,
          layerPath: path,
          property: prop,
          value: String((node as any)[prop]),
        });
      }
    }
  }

  return { total, bound };
}

function scanNodeRecursive(
  node: SceneNode,
  rawValues: RawValueEntry[],
  path: string,
): { total: number; bound: number } {
  // Skip instances of other components
  if (node.type === "INSTANCE") {
    return { total: 0, bound: 0 };
  }

  const counts = countBoundVariables(node, rawValues, path);
  let total = counts.total;
  let bound = counts.bound;

  if ("children" in node) {
    for (const child of (node as ChildrenMixin).children) {
      const childPath = path + " / " + child.name;
      const childCounts = scanNodeRecursive(
        child as SceneNode,
        rawValues,
        childPath,
      );
      total += childCounts.total;
      bound += childCounts.bound;
    }
  }

  return { total, bound };
}

async function loadComponentData(): Promise<SerializedComponent[]> {
  const result: SerializedComponent[] = [];
  const pages = figma.root.children;

  for (const page of pages) {
    await page.loadAsync();
    const components = page.findAllWithCriteria({
      types: ["COMPONENT_SET", "COMPONENT"],
    });

    for (const node of components) {
      // Skip standalone components that are children of a component set
      // (they're variants — the set itself covers them)
      if (
        node.type === "COMPONENT" &&
        node.parent &&
        node.parent.type === "COMPONENT_SET"
      ) {
        continue;
      }

      const isSet = node.type === "COMPONENT_SET";
      const compNode = node as ComponentSetNode | ComponentNode;

      // Variant properties
      const variantProperties: Record<string, SerializedComponentVariant> = {};
      let variantCount = 0;
      const propDefs = compNode.componentPropertyDefinitions;
      for (const [name, def] of Object.entries(propDefs)) {
        if (def.type === "VARIANT") {
          variantProperties[name] = {
            type: "VARIANT",
            defaultValue: String(def.defaultValue),
            options: (def as any).variantOptions || [],
          };
          const opts = (def as any).variantOptions;
          variantCount += opts && opts.length ? opts.length : 0;
        }
      }

      // Token coverage — scan all children recursively
      const rawValues: RawValueEntry[] = [];
      let totalProps = 0;
      let boundProps = 0;

      if (isSet) {
        // Scan each variant child
        for (const child of (compNode as ComponentSetNode).children) {
          const counts = scanNodeRecursive(
            child as SceneNode,
            rawValues,
            compNode.name + " / " + child.name,
          );
          totalProps += counts.total;
          boundProps += counts.bound;
        }
      } else {
        const counts = scanNodeRecursive(
          compNode as SceneNode,
          rawValues,
          compNode.name,
        );
        totalProps += counts.total;
        boundProps += counts.bound;
      }

      // Publish status
      let publishStatus = "UNPUBLISHED";
      try {
        const status = await (compNode as any).getPublishStatusAsync();
        publishStatus = status || "UNPUBLISHED";
      } catch (_) {
        // API may not be available in all contexts
      }

      result.push({
        id: compNode.id,
        name: compNode.name,
        key: (compNode as any).key || "",
        description: compNode.description || "",
        publishStatus,
        isComponentSet: isSet,
        variantCount,
        variantProperties,
        tokenCoverage: {
          total: totalProps,
          bound: boundProps,
          raw: totalProps - boundProps,
        },
        rawValues: rawValues.slice(0, 50), // Cap at 50 to avoid huge payloads
      });
    }
  }

  return result;
}

async function loadVariableData(): Promise<void> {
  const collections = await figma.variables.getLocalVariableCollectionsAsync();
  const result: SerializedCollection[] = [];
  const brokenReferences: BrokenReference[] = [];

  for (const collection of collections) {
    const collectionData: SerializedCollection = {
      name: collection.name,
      modes: collection.modes.map((m) => m.name),
      variables: [],
    };

    for (const varId of collection.variableIds) {
      const variable = await figma.variables.getVariableByIdAsync(varId);
      if (!variable) continue;

      const valuesByMode: Record<string, SerializedVariableValue> = {};
      for (const mode of collection.modes) {
        const value = variable.valuesByMode[mode.modeId];
        let aliasId: string | null = null;
        let resolvedValue: string | null = null;

        if (
          value &&
          typeof value === "object" &&
          "type" in value &&
          (value as unknown as { type: string }).type === "VARIABLE_ALIAS"
        ) {
          const alias = value as unknown as { type: string; id: string };
          const referencedVar = await figma.variables.getVariableByIdAsync(
            alias.id,
          );
          if (referencedVar) {
            aliasId = referencedVar.name;
          } else {
            aliasId = alias.id;
            brokenReferences.push({
              variableId: variable.id,
              variableName: variable.name,
              collection: collection.name,
              mode: mode.name,
              brokenAliasId: alias.id,
              source: "variable",
            });
          }
        } else {
          resolvedValue = stringifyValue(value, variable.resolvedType);
        }

        valuesByMode[mode.name] = { aliasId, value: resolvedValue };
      }

      collectionData.variables.push({
        id: variable.id,
        name: variable.name,
        type: variable.resolvedType,
        valuesByMode,
      });
    }

    result.push(collectionData);
  }

  // Also scan styles for broken variable bindings
  await scanStyleBoundVariables(brokenReferences);

  figma.ui.postMessage({
    type: "variable-data",
    data: { collections: result, brokenReferences },
  });
}

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
  if (msg.type === "rename-variable" && msg.id && msg.newName) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(msg.id);
      if (!variable) {
        figma.ui.postMessage({
          type: "rename-error",
          id: msg.id,
          error: "Variable not found",
        });
        return;
      }
      variable.name = msg.newName;
      figma.ui.postMessage({
        type: "rename-success",
        id: msg.id,
        newName: msg.newName,
      });
      figma.notify(`Renamed to "${msg.newName}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({
        type: "rename-error",
        id: msg.id,
        error: message,
      });
      figma.notify(`Rename failed: ${message}`, { error: true, timeout: 2500 });
    }
  }

  if (msg.type === "rename-collection" && msg.collectionId && msg.newName) {
    try {
      const collections =
        await figma.variables.getLocalVariableCollectionsAsync();
      const collection = collections.find((c) => c.id === msg.collectionId);
      if (!collection) {
        figma.ui.postMessage({
          type: "fix-error",
          action: "rename-collection",
          error: "Collection not found",
        });
        return;
      }
      collection.name = msg.newName;
      figma.ui.postMessage({
        type: "fix-success",
        action: "rename-collection",
        collectionId: msg.collectionId,
        newName: msg.newName,
      });
      figma.notify(`Renamed collection to "${msg.newName}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({
        type: "fix-error",
        action: "rename-collection",
        error: message,
      });
    }
  }

  if (
    msg.type === "move-variables" &&
    msg.variableIds &&
    msg.targetCollectionId
  ) {
    try {
      const collections =
        await figma.variables.getLocalVariableCollectionsAsync();
      const targetCollection = collections.find(
        (c) => c.id === msg.targetCollectionId,
      );
      if (!targetCollection) {
        figma.ui.postMessage({
          type: "fix-error",
          action: "move-variables",
          error: "Target collection not found",
        });
        return;
      }
      let moved = 0;
      for (const varId of msg.variableIds) {
        const variable = await figma.variables.getVariableByIdAsync(varId);
        if (!variable) continue;

        const sourceCollection = collections.find((c) =>
          c.variableIds.includes(varId),
        );
        if (!sourceCollection) continue;

        const newVar = figma.variables.createVariable(
          variable.name,
          targetCollection,
          variable.resolvedType,
        );
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

      figma.ui.postMessage({
        type: "fix-success",
        action: "move-variables",
        moved,
      });
      figma.notify(`Moved ${moved} variables`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({
        type: "fix-error",
        action: "move-variables",
        error: message,
      });
    }
  }

  if (msg.type === "create-collection" && msg.name) {
    try {
      const collection = figma.variables.createVariableCollection(msg.name);
      figma.ui.postMessage({
        type: "fix-success",
        action: "create-collection",
        collectionId: collection.id,
        name: msg.name,
      });
      figma.notify(`Created collection "${msg.name}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({
        type: "fix-error",
        action: "create-collection",
        error: message,
      });
    }
  }

  if (msg.type === "delete-collection" && msg.collectionId) {
    try {
      const collections =
        await figma.variables.getLocalVariableCollectionsAsync();
      const collection = collections.find((c) => c.id === msg.collectionId);
      if (!collection) {
        figma.ui.postMessage({
          type: "fix-error",
          action: "delete-collection",
          error: "Collection not found",
        });
        return;
      }
      collection.remove();
      figma.ui.postMessage({
        type: "fix-success",
        action: "delete-collection",
        collectionId: msg.collectionId,
      });
      figma.notify("Deleted collection", { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({
        type: "fix-error",
        action: "delete-collection",
        error: message,
      });
    }
  }

  if (msg.type === "delete-variable" && msg.variableId) {
    try {
      const variable = await figma.variables.getVariableByIdAsync(
        msg.variableId,
      );
      if (!variable) {
        figma.ui.postMessage({
          type: "fix-error",
          action: "delete-variable",
          error: "Variable not found",
        });
        return;
      }
      const name = variable.name;
      variable.remove();
      figma.ui.postMessage({
        type: "fix-success",
        action: "delete-variable",
        variableId: msg.variableId,
        name,
      });
      figma.notify(`Deleted variable "${name}"`, { timeout: 2000 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      figma.ui.postMessage({
        type: "fix-error",
        action: "delete-variable",
        error: message,
      });
    }
  }

  if (msg.type === "reload-variables") {
    await loadVariableData();
    await loadStyleData();
    await loadAndSendComponentData();
  }

  if (msg.type === "load-components") {
    await loadAndSendComponentData();
  }

  if (msg.type === "ui-ready") {
    await initPlugin();
  }

  if (msg.type === "clear-token") {
    await figma.clientStorage.deleteAsync("api_token");
  }

  if (msg.type === "store-token" && msg.token) {
    await figma.clientStorage.setAsync("api_token", msg.token);
    figma.ui.postMessage({ type: "auth-ready", token: msg.token });
  }

  if (msg.type === "registration-failed") {
    figma.notify("Registration failed: " + (msg.message || "Unknown error"), {
      error: true,
      timeout: 2500,
    });
  }

  if (msg.type === "notify" && msg.message) {
    figma.notify(msg.message, { error: !!msg.error, timeout: 2500 });
  }

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
};

async function loadStyleData(): Promise<void> {
  const unboundStyles = await scanUnboundStyleProperties();
  figma.ui.postMessage({
    type: "style-data",
    data: unboundStyles,
  });
}

async function loadAndSendComponentData(): Promise<void> {
  const components = await loadComponentData();
  figma.ui.postMessage({ type: "component-data", data: components });
}

async function initPlugin(): Promise<void> {
  // Auth: check for existing token or trigger registration
  const existingToken = (await figma.clientStorage.getAsync("api_token")) as
    | string
    | undefined;
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
