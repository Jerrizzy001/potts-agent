import { loadSchema, validateSchema, type JsonSchema } from '../../src/core/index.ts';
export * from '../../src/memory/index.ts';

/** Validates a value against the `memory` section of config/potts.schema.json. */
export function validateSchemaForMemory(value: unknown) {
  const schema = loadSchema();
  const sub = (schema.properties as Record<string, JsonSchema>).memory!;
  return validateSchema(value, sub, schema);
}
