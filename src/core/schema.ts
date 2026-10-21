/**
 * Minimal JSON Schema (2020-12 subset) validator. Supported keywords:
 * type, const, enum, properties, required, additionalProperties (bool|schema),
 * items, minItems, maxItems, uniqueItems, minLength, maxLength, pattern,
 * minimum, maximum, $ref (local "#/..." pointers only). Annotation keywords
 * ($schema, $id, title, description) are ignored. Unknown keywords throw, so
 * a schema can never silently rely on unsupported validation.
 */
export type JsonSchema = Record<string, unknown>;
export interface SchemaIssue {
  path: string;
  message: string;
}

const SUPPORTED = new Set([
  'type', 'const', 'enum', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', '$ref', '$schema', '$id', '$defs',
  'title', 'description',
]);

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function resolvePointer(root: JsonSchema, ref: string): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`schema: only local $ref supported (${ref})`);
  let cur: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    cur = (cur as Record<string, unknown> | undefined)?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
  }
  if (!cur || typeof cur !== 'object') throw new Error(`schema: unresolved $ref ${ref}`);
  return cur as JsonSchema;
}

export function validateSchema(value: unknown, schema: JsonSchema, root: JsonSchema = schema): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const walk = (v: unknown, s: JsonSchema, path: string, depth: number): void => {
    if (depth > 64) throw new Error('schema: recursion too deep');
    for (const k of Object.keys(s)) if (!SUPPORTED.has(k)) throw new Error(`schema: unsupported keyword "${k}" at ${path}`);
    if (typeof s.$ref === 'string') {
      walk(v, resolvePointer(root, s.$ref), path, depth + 1);
    }
    const t = typeOf(v);
    if (s.type !== undefined) {
      const types = Array.isArray(s.type) ? (s.type as string[]) : [s.type as string];
      const okType = types.some((ty) => ty === t || (ty === 'number' && t === 'integer'));
      if (!okType) {
        issues.push({ path, message: `expected ${types.join('|')}, got ${t}` });
        return;
      }
    }
    if ('const' in s && JSON.stringify(v) !== JSON.stringify(s.const)) issues.push({ path, message: `must equal ${JSON.stringify(s.const)}` });
    if (Array.isArray(s.enum) && !s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v)))
      issues.push({ path, message: `must be one of ${s.enum.map((e) => JSON.stringify(e)).join(', ')}` });
    if (t === 'string') {
      const str = v as string;
      if (typeof s.minLength === 'number' && str.length < s.minLength) issues.push({ path, message: `shorter than ${s.minLength}` });
      if (typeof s.maxLength === 'number' && str.length > s.maxLength) issues.push({ path, message: `longer than ${s.maxLength}` });
      if (typeof s.pattern === 'string' && !new RegExp(s.pattern, 'u').test(str)) issues.push({ path, message: `does not match ${s.pattern}` });
    }
    if (t === 'number' || t === 'integer') {
      const n = v as number;
      if (typeof s.minimum === 'number' && n < s.minimum) issues.push({ path, message: `below minimum ${s.minimum}` });
      if (typeof s.maximum === 'number' && n > s.maximum) issues.push({ path, message: `above maximum ${s.maximum}` });
    }
    if (t === 'array') {
      const arr = v as unknown[];
      if (typeof s.minItems === 'number' && arr.length < s.minItems) issues.push({ path, message: `fewer than ${s.minItems} items` });
      if (typeof s.maxItems === 'number' && arr.length > s.maxItems) issues.push({ path, message: `more than ${s.maxItems} items` });
      if (s.uniqueItems === true && new Set(arr.map((x) => JSON.stringify(x))).size !== arr.length) issues.push({ path, message: 'items not unique' });
      if (s.items && typeof s.items === 'object') arr.forEach((x, i) => walk(x, s.items as JsonSchema, `${path}[${i}]`, depth + 1));
    }
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      for (const r of (s.required ?? []) as string[]) if (!(r in obj)) issues.push({ path, message: `missing required property "${r}"` });
      for (const [k, val] of Object.entries(obj)) {
        const p = `${path}.${k}`;
        if (props[k]) walk(val, props[k], p, depth + 1);
        else if (s.additionalProperties === false) issues.push({ path: p, message: 'unknown property' });
        else if (s.additionalProperties && typeof s.additionalProperties === 'object') walk(val, s.additionalProperties as JsonSchema, p, depth + 1);
      }
    }
  };
  walk(value, schema, '$', 0);
  return issues;
}
