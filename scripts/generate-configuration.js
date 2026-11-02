'use strict';

/**
 * Generates the native VS Code settings contribution from the official
 * OpenCode JSON schema.
 *
 * VS Code does not support `$ref` in `contributes.configuration`, so the
 * schema is dereferenced and reduced to the subset that the Settings editor
 * can render. Structured values that VS Code cannot render are still
 * contributed, but only as "edit in settings.json" entries.
 *
 * Run: node scripts/generate-configuration.js
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SCHEMA_PATH = path.join(ROOT, 'src', 'schema', 'config.schema.json');
const PACKAGE_PATH = path.join(ROOT, 'package.json');
const GENERATED_PATH = path.join(ROOT, 'src', 'generated', 'opencode-settings.json');

const PREFIX = 'opencode';

/**
 * Fields that are documented as deprecated but are not marked as such in the
 * published schema.
 */
const DEPRECATED_PATHS = new Set(['experimental.policies']);

/**
 * The only OpenCode settings this extension contributes.
 *
 * The rule is whether the value changes what happens inside an extension
 * session: the model and agent that answer, the tools and permissions they may
 * use, the MCP servers, skills, commands, instructions and references they
 * load, how tool output, images and context compaction are handled, and the
 * shell/formatter/language servers they run. Values that only affect the
 * OpenCode client or the sharing service (`update`, `share`, `enterprise`,
 * `username`, `timezone`, `warming`, `worktree`, `snapshots` — the extension
 * has no undo UI) and unstable `experimental.*` switches are left to
 * `opencode.json(c)`, where the bundled schema still validates and completes
 * them.
 */
const KEEP_PATHS = [
  'shell',
  'model',
  'default_agent',
  'permissions',
  'policies',
  'agents',
  'watcher.ignore',
  'formatter',
  'lsp',
  'media.image.auto_resize',
  'media.image.max_width',
  'media.image.max_height',
  'media.image.max_base64_bytes',
  'tool_output.max_lines',
  'tool_output.max_bytes',
  'mcp.timeout.startup',
  'mcp.timeout.catalog',
  'mcp.timeout.execution',
  'mcp.servers',
  'compaction.auto',
  'compaction.keep.tokens',
  'compaction.buffer',
  'skills',
  'commands',
  'instructions',
  'references',
  'websearch',
  'plugins',
  'providers',
];

const LABELS = {
  shell: 'Shell',
  model: 'Default model',
  default_agent: 'Default agent',
  permissions: 'Permissions',
  policies: 'Policies',
  agents: 'Agents',
  'watcher.ignore': 'Ignored paths',
  formatter: 'Formatting',
  lsp: 'Language servers',
  'media.image.auto_resize': 'Auto-resize images',
  'media.image.max_width': 'Maximum image width',
  'media.image.max_height': 'Maximum image height',
  'media.image.max_base64_bytes': 'Maximum image size (bytes)',
  'tool_output.max_lines': 'Maximum output lines',
  'tool_output.max_bytes': 'Maximum output bytes',
  'mcp.timeout.startup': 'MCP startup timeout',
  'mcp.timeout.catalog': 'MCP catalog timeout',
  'mcp.timeout.execution': 'MCP execution timeout',
  'mcp.servers': 'MCP servers',
  'compaction.auto': 'Automatic compaction',
  'compaction.keep.tokens': 'Retained context tokens',
  'compaction.buffer': 'Compaction buffer',
  skills: 'Skill paths',
  commands: 'Commands',
  instructions: 'Instruction files',
  references: 'References',
  websearch: 'Web search',
  plugins: 'Plugins',
  providers: 'Providers',
};

const DESCRIPTIONS = {
  model:
    'Model used for new sessions unless the session or agent selects another one. ' +
    'The list is filled from the installed models when the extension starts; ' +
    'after adding or enabling a model, run **Developer: Reload Window** to refresh it.',
  default_agent:
    'Primary agent used for new sessions unless the session selects another one. ' +
    'The list is filled from the installed agents when the extension starts; ' +
    'after adding an agent, run **Developer: Reload Window** to refresh it.',
  permissions: 'Ordered tool permission rules applied to agent tool use.',
  policies: 'Ordered policies controlling access to providers, tools, and integrations.',
  agents: 'Named built-in agent overrides and custom agent definitions.',
  commands: 'Named slash command definitions.',
  references: 'Named local directories or Git repositories available as supporting context.',
  plugins: 'Ordered plugin enablement directives and external package declarations.',
  providers: 'Configure providers and add or override their models and request settings.',
  websearch: 'Choose how OpenCode searches the web.',
  'mcp.servers': 'Configure local and remote Model Context Protocol servers.',
  skills: 'Additional paths or URLs to discover skills from.',
  instructions: 'Additional instruction files, globs, or HTTP(S) URLs.',
  formatter: 'Enable built-in formatters or configure formatter overrides.',
  lsp: 'Enable built-in language servers or configure server overrides.',
};

/** Optional human labels for enum values; keys are OpenCode setting paths. */
const ENUM_DESCRIPTIONS = {};

/**
 * Defaults that are stated by the OpenCode documentation or by the schema
 * descriptions. OpenCode remains the source of truth for the actual file.
 */
const DEFAULTS = {
  formatter: false,
  'tool_output.max_lines': 2000,
  'tool_output.max_bytes': 51200,
  'compaction.auto': true,
};

/** True for a kept path and for every object that contains a kept path. */
function isKept(pathParts) {
  const key = pathParts.join('.');
  return KEEP_PATHS.some(
    (keep) => keep === key || keep.startsWith(`${key}.`) || key.startsWith(`${keep}.`)
  );
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function humanize(segment) {
  const words = String(segment).replace(/_/g, ' ').trim();
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stripDeprecated(node, pathParts) {
  if (!isPlainObject(node)) return node;
  if (node.deprecated === true) return null;
  if (DEPRECATED_PATHS.has(pathParts.join('.'))) return null;

  const result = { ...node };

  if (isPlainObject(result.properties)) {
    const properties = {};
    for (const [key, value] of Object.entries(result.properties)) {
      const next = stripDeprecated(value, [...pathParts, key]);
      if (next !== null) properties[key] = next;
    }
    result.properties = properties;
  }

  if (isPlainObject(result.additionalProperties)) {
    const next = stripDeprecated(result.additionalProperties, [...pathParts, '*']);
    if (next === null) delete result.additionalProperties;
    else result.additionalProperties = next;
  }

  for (const keyword of ['anyOf', 'oneOf', 'allOf']) {
    if (Array.isArray(result[keyword])) {
      result[keyword] = result[keyword]
        .map((entry, index) => stripDeprecated(entry, [...pathParts, `#${keyword}${index}`]))
        .filter((entry) => entry !== null);
    }
  }

  if (Array.isArray(result.items)) {
    result.items = result.items
      .map((entry, index) => stripDeprecated(entry, [...pathParts, `#items${index}`]))
      .filter((entry) => entry !== null);
  } else if (isPlainObject(result.items)) {
    const next = stripDeprecated(result.items, [...pathParts, '*']);
    if (next === null) delete result.items;
    else result.items = next;
  }

  return result;
}

function resolveRefs(node, root, stack = []) {
  if (Array.isArray(node)) return node.map((entry) => resolveRefs(entry, root, stack));
  if (!isPlainObject(node)) return node;

  if (typeof node.$ref === 'string') {
    const ref = node.$ref;
    if (!ref.startsWith('#/$defs/')) {
      throw new Error(`Unsupported $ref: ${ref}`);
    }
    const name = ref.slice('#/$defs/'.length);
    if (stack.includes(name)) {
      throw new Error(`Cyclic $ref: ${[...stack, name].join(' -> ')}`);
    }
    const definition = root.$defs && root.$defs[name];
    if (!definition) throw new Error(`Unknown $ref: ${ref}`);
    const resolved = resolveRefs(clone(definition), root, [...stack, name]);
    const { $ref, ...siblings } = node;
    return resolveRefs({ ...resolved, ...siblings }, root, stack);
  }

  const result = {};
  for (const [key, value] of Object.entries(node)) {
    result[key] = resolveRefs(value, root, stack);
  }
  return result;
}

function variantsOf(node) {
  if (!isPlainObject(node)) return [node];
  if (Array.isArray(node.anyOf)) return node.anyOf.flatMap(variantsOf);
  if (Array.isArray(node.oneOf)) return node.oneOf.flatMap(variantsOf);
  return [node];
}

function mergedTypes(node) {
  const types = new Set();
  for (const variant of variantsOf(node)) {
    if (!isPlainObject(variant)) continue;
    if (variant.type === undefined) {
      if (variant.properties || variant.additionalProperties) types.add('object');
      else if (variant.items) types.add('array');
      else if (variant.enum) {
        for (const value of variant.enum) types.add(typeof value);
      }
      continue;
    }
    for (const type of Array.isArray(variant.type) ? variant.type : [variant.type]) {
      if (type !== 'null') types.add(type);
    }
  }
  return [...types];
}

function scalarTypeOf(type) {
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean';
}

function isScalarNode(node) {
  const types = mergedTypes(node);
  if (types.length === 0) return false;
  if (!types.every(scalarTypeOf)) return false;
  return true;
}

function isPrimitiveArrayNode(node) {
  const types = mergedTypes(node);
  if (types.length !== 1 || types[0] !== 'array') return false;
  return Boolean(node.items) && isScalarNode(node.items);
}

function isPrimitiveMapNode(node) {
  const types = mergedTypes(node);
  if (types.length !== 1 || types[0] !== 'object') return false;
  return Boolean(node.additionalProperties) && isScalarNode(node.additionalProperties);
}

function isPlainObjectNode(node) {
  const types = mergedTypes(node);
  if (types.length !== 1 || types[0] !== 'object') return false;
  if (!isPlainObject(node.properties)) return false;
  const additional = node.additionalProperties;
  return additional === undefined || additional === false;
}

function enumValues(node) {
  if (!isPlainObject(node) || !Array.isArray(node.enum)) return undefined;
  return node.enum.filter((value) => typeof value !== 'object' && value !== null);
}

function describe(pathParts, node, complex) {
  const key = pathParts.join('.');
  const label = LABELS[key] || humanize(pathParts[pathParts.length - 1]);
  const description =
    DESCRIPTIONS[key] ||
    (isPlainObject(node) && typeof node.description === 'string' ? node.description : '');
  const lines = [`**${label}**`];
  if (description) lines.push(description);
  lines.push(`OpenCode key: \`${key}\``);

  if (complex) {
    lines.push(
      'VS Code does not render this structured value; use **Edit in settings.json** to set the full value.'
    );
  }
  return lines.join('\n\n');
}

function buildEntry(pathParts, node, order) {
  const key = pathParts.join('.');
  const complex =
    !isScalarNode(node) && !isPrimitiveArrayNode(node) && !isPrimitiveMapNode(node);
  const property = {
    scope: 'resource',
    markdownDescription: describe(pathParts, node, complex),
    order,
  };

  if (key.startsWith('experimental.')) {
    property.tags = ['experimental'];
  }

  if (key in DEFAULTS) {
    property.default = DEFAULTS[key];
  }

  const metadata = {
    id: `${PREFIX}.${key}`,
    path: pathParts,
    complex,
    scope: property.scope,
  };

  if (!complex) {
    const types = mergedTypes(node);
    if (types.length === 1) property.type = types[0];
    else property.type = types;
    metadata.types = types;

    const values = enumValues(node);
    if (values && values.length > 0) {
      property.enum = values;
      metadata.enum = values;
      const descriptions = ENUM_DESCRIPTIONS[key];
      if (descriptions) {
        property.enumDescriptions = values.map(
          (value) => descriptions[value] || String(value)
        );
      }
    }

    if (isPrimitiveArrayNode(node)) {
      property.items = { type: mergedTypes(node.items)[0] || 'string' };
      metadata.kind = 'array';
      metadata.itemType = mergedTypes(node.items)[0] || 'string';
    } else if (isPrimitiveMapNode(node)) {
      property.additionalProperties = {
        type: mergedTypes(node.additionalProperties)[0] || 'string',
      };
      metadata.kind = 'object';
    } else {
      metadata.kind = 'scalar';
    }

    if (typeof node.pattern === 'string') {
      property.pattern = node.pattern;
      metadata.pattern = node.pattern;
    }
    if (typeof node.minimum === 'number') {
      property.minimum = node.minimum;
      metadata.minimum = node.minimum;
    }
    if (typeof node.exclusiveMinimum === 'number') {
      metadata.exclusiveMinimum = node.exclusiveMinimum;
    }
    if (typeof node.maximum === 'number' && node.maximum < 9007199254740991) {
      property.maximum = node.maximum;
      metadata.maximum = node.maximum;
    }
    if (typeof node.minLength === 'number') property.minLength = node.minLength;
    if (typeof node.maxLength === 'number') property.maxLength = node.maxLength;
    if (typeof node.minItems === 'number') {
      property.minItems = node.minItems;
      metadata.minItems = node.minItems;
    }
    if (typeof node.maxItems === 'number') {
      property.maxItems = node.maxItems;
      metadata.maxItems = node.maxItems;
    }

    if (isPlainObject(node) && typeof node.description === 'string' && !property.markdownDescription.includes(node.description)) {
      // The description is already part of markdownDescription.
    }
  } else {
    const types = mergedTypes(node);
    if (types.length === 0) property.type = ['object', 'array', 'boolean', 'string'];
    else if (types.length === 1) property.type = types[0];
    else property.type = types;

    // `websearch` only accepts `false` or an object. Keep both in the type so a
    // `false` in opencode.json(c) can still be mirrored; the object form forces
    // the Settings editor to fall back to "Edit in settings.json" (no checkbox),
    // which prevents writing an invalid `true`.
    if (key === 'websearch') {
      property.type = ['object', 'boolean'];
      property.properties = {
        provider: {
          type: 'string',
          description: 'Web search provider ID, or "random" to pick one automatically.',
        },
      };
      property.additionalProperties = false;
      property.markdownDescription +=
        '\n\nSet `false` in `opencode.json(c)` to disable web search.';
      metadata.kind = 'complex';
      metadata.types = ['object', 'boolean'];
      return { property, metadata };
    }

    const typeSet = new Set(types);
    if (typeSet.has('object')) {
      // A nested object schema makes the Settings editor fall back to
      // "Edit in settings.json" instead of showing a lossy key/value grid.
      const additional = node.additionalProperties;
      const additionalTypes =
        isPlainObject(additional) && mergedTypes(additional).includes('object')
          ? ['object']
          : ['object'];
      property.additionalProperties = { type: additionalTypes[0] };
    }
    if (typeSet.has('array')) {
      const itemTypes = node.items ? mergedTypes(node.items) : [];
      if (itemTypes.length === 0) property.items = { type: 'object' };
      else if (itemTypes.length === 1) property.items = { type: itemTypes[0] };
      else property.items = { type: itemTypes };
    }
    metadata.kind = 'complex';
    metadata.types = types;
  }

  return { property, metadata };
}

function unwrapSingleVariant(node) {
  if (!isPlainObject(node)) return node;
  if (!Array.isArray(node.anyOf) && !Array.isArray(node.oneOf)) return node;
  const variants = variantsOf(node);
  if (variants.length !== 1) return node;
  const variant = variants[0];
  if (variant === node) return node;
  const merged = { ...variant };
  if (node.description && !merged.description) merged.description = node.description;
  return merged;
}

function nextOrder(counter) {
  const value = counter.value;
  counter.value += 10;
  return value;
}

function flatten(pathParts, node, out, counter) {
  if (!isPlainObject(node)) return;
  node = unwrapSingleVariant(node);

  // `model` is stored either as `provider/model#variant` or as the structured
  // `{ providerID, model, variant }` object that OpenCode itself writes. The
  // setting keeps the compact string form only, so the Settings editor can show
  // the dropdown filled at startup (`src/setting-enums.js`); the sync converts
  // a structured value from `opencode.json(c)` before mirroring it.
  if (pathParts.length === 1 && pathParts[0] === 'model' && !isScalarNode(node)) {
    const modelNode = {
      type: 'string',
      pattern: '^[^/#]+\\/[^#]+(?:#[^#]+)?$',
      description: node.description,
    };
    const { property, metadata } = buildEntry(pathParts, modelNode, nextOrder(counter));
    property.markdownDescription =
      describe(pathParts, modelNode, false) +
      '\n\nStored as `provider/model` or `provider/model#variant`.';
    metadata.kind = 'scalar';
    metadata.complex = false;
    metadata.types = ['string'];
    metadata.format = 'model-ref';
    metadata.pattern = modelNode.pattern;
    out.push({ property, metadata });
    return;
  }

  if (isPlainObjectNode(node)) {
    const entries = Object.entries(node.properties);
    entries.forEach(([key, child]) => {
      const childPath = [...pathParts, key];
      if (!isKept(childPath)) return;
      flatten(childPath, child, out, counter);
    });
    return;
  }

  const { property, metadata } = buildEntry(pathParts, node, nextOrder(counter));
  out.push({ property, metadata });
}

function buildSettings(schema) {
  const filtered = stripDeprecated(schema, []);

  const out = [];
  const counter = { value: 10 };
  const entries = Object.entries(filtered.properties || {});
  entries.forEach(([key, node]) => {
    if (key === '$schema') return;
    if (!isKept([key])) return;
    // Resolve only live top-level properties. Resolving the whole document
    // would also walk deprecated V1 definitions (and their external refs).
    const resolved = resolveRefs(node, schema);
    flatten([key], resolved, out, counter);
  });

  return out;
}

function buildConfiguration(settings, extensionProperties) {
  const properties = {};
  for (const { property, metadata } of settings) {
    properties[metadata.id] = property;
  }
  for (const [key, value] of Object.entries(extensionProperties)) {
    properties[key] = value;
  }

  return {
    title: 'OpenCode',
    properties,
  };
}

function extensionPropertiesFrom(pkg) {
  const configuration = pkg.contributes && pkg.contributes.configuration;
  const categories = Array.isArray(configuration) ? configuration : [configuration];
  const extensionProperties = {};
  for (const category of categories) {
    if (!category || !category.properties) continue;
    for (const [key, value] of Object.entries(category.properties)) {
      if (key.startsWith('opencodeSessions.')) {
        extensionProperties[key] = value;
      }
    }
  }
  if (Object.keys(extensionProperties).length > 0) {
    return extensionProperties;
  }

  // Migrate from the old single category with `opencode.command` and
  // `opencode.autoApprovePermissions`.
  for (const category of categories) {
    if (!category || !category.properties) continue;
    if (category.properties['opencode.command'] !== undefined) {
      const migrated = {};
      for (const [key, value] of Object.entries(category.properties)) {
        if (key === 'opencode.command') migrated['opencodeSessions.command'] = value;
        else if (key === 'opencode.autoApprovePermissions') {
          migrated['opencodeSessions.autoApprovePermissions'] = value;
        }
      }
      if (Object.keys(migrated).length > 0) return migrated;
    }
  }

  return {
    'opencodeSessions.command': {
      type: 'string',
      default: 'opencode',
      description: 'Command used to launch OpenCode.',
    },
    'opencodeSessions.autoApprovePermissions': {
      type: 'string',
      enum: ['ask', 'allowAll'],
      enumDescriptions: [
        'Ask for confirmation in chat.',
        'Automatically allow all agent requests.',
      ],
      default: 'ask',
      description: 'How to handle permission requests from OpenCode.',
    },
  };
}

function generate() {
  const schema = readJson(SCHEMA_PATH);
  const settings = buildSettings(schema);
  const pkg = readJson(PACKAGE_PATH);
  const extensionProperties = extensionPropertiesFrom(pkg);

  const configuration = buildConfiguration(settings, extensionProperties);
  const previousConfiguration = pkg.contributes && pkg.contributes.configuration;
  if (previousConfiguration) preserveRuntimeEnums(previousConfiguration, configuration);
  return {
    configuration,
    settings: settings.map(({ metadata }) => metadata),
  };
}

/** Properties of the `opencode` category, whether it is an object or an array. */
function configurationProperties(configuration) {
  const categories = Array.isArray(configuration) ? configuration : [configuration];
  let fallback = null;
  for (const category of categories) {
    if (!category || !category.properties) continue;
    if (category.properties['opencode.model'] || category.properties['opencode.default_agent']) {
      return category.properties;
    }
    if (!fallback) fallback = category.properties;
  }
  return fallback || {};
}

/**
 * The model and agent dropdowns are filled at runtime from the running
 * service, so a regeneration must not discard the lists written since.
 */
const RUNTIME_ENUM_IDS = ['opencode.model', 'opencode.default_agent'];
const RUNTIME_ENUM_KEYS = ['enum', 'enumDescriptions', 'markdownEnumDescriptions'];

function preserveRuntimeEnums(before, after) {
  const previous = configurationProperties(before);
  const next = configurationProperties(after);
  for (const id of RUNTIME_ENUM_IDS) {
    if (!previous[id] || !next[id]) continue;
    for (const key of RUNTIME_ENUM_KEYS) {
      if (previous[id][key] !== undefined) next[id][key] = previous[id][key];
    }
  }
}

function write() {
  const { configuration, settings } = generate();
  const pkg = readJson(PACKAGE_PATH);
  pkg.contributes = pkg.contributes || {};
  pkg.contributes.configuration = configuration;

  fs.writeFileSync(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  const generated = {
    note: 'Generated by scripts/generate-configuration.js. Do not edit by hand.',
    schema: 'https://opencode.ai/config.json',
    settings,
  };
  fs.mkdirSync(path.dirname(GENERATED_PATH), { recursive: true });
  fs.writeFileSync(GENERATED_PATH, `${JSON.stringify(generated, null, 2)}\n`);

  console.log(`Generated ${settings.length} OpenCode settings.`);
}

module.exports = {
  generate,
  write,
  buildSettings,
  resolveRefs,
  stripDeprecated,
  isKept,
  KEEP_PATHS,
  SCHEMA_PATH,
  PACKAGE_PATH,
  GENERATED_PATH,
};

if (require.main === module) {
  write();
}
