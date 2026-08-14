/**
 * Small builders for the path modules.
 *
 * These exist because an OpenAPI document written out longhand is ~80% repeated
 * boilerplate — `content: { 'application/json': { schema: ... } }` around every
 * body, the same four error responses on every authenticated route. Repeating
 * it by hand is how a spec ends up with one endpoint documenting a 401 and the
 * next one silently forgetting to.
 */

type Json = Record<string, unknown>;

/** `$ref` to a schema in components. */
export const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** `$ref` to a reusable response in components. */
export const resp = (name: string) => ({ $ref: `#/components/responses/${name}` });

/** A JSON response body. */
export function json(description: string, schema: Json, example?: unknown): Json {
  return {
    description,
    content: {
      'application/json': {
        schema,
        ...(example === undefined ? {} : { example }),
      },
    },
  };
}

/** A required JSON request body. */
export function body(schema: Json, options: { required?: boolean; description?: string } = {}): Json {
  return {
    required: options.required ?? true,
    ...(options.description ? { description: options.description } : {}),
    content: { 'application/json': { schema } },
  };
}

/** An inline object schema. Every property should carry a description and an example. */
export function object(properties: Json, required?: string[]): Json {
  return {
    type: 'object',
    ...(required?.length ? { required } : {}),
    properties,
  };
}

export function arrayOf(schema: Json, description?: string): Json {
  return { type: 'array', items: schema, ...(description ? { description } : {}) };
}

/** A path or query parameter. */
export function param(
  name: string,
  location: 'path' | 'query' | 'header',
  schema: Json,
  description: string,
  options: { required?: boolean; example?: unknown } = {},
): Json {
  return {
    name,
    in: location,
    required: options.required ?? location === 'path',
    description,
    schema,
    ...(options.example === undefined ? {} : { example: options.example }),
  };
}

/**
 * The offset/limit pair used by most list endpoints. `max` differs per endpoint
 * (50 in most places, 100 on preference history, 20 on discovery feeds) and
 * getting it wrong is a 400, so it is a required argument rather than a default.
 */
export function pagination(max: number, defaultLimit = 20): Json[] {
  return [
    param('limit', 'query', { type: 'integer', minimum: 1, maximum: max, default: defaultLimit },
      `How many items to return (1–${max}).`),
    param('offset', 'query', { type: 'integer', minimum: 0, default: 0 },
      'How many items to skip. Combine with `total` in the response to paginate.'),
  ];
}

/** The 200 `{ success: true }` body returned by the many write endpoints that have nothing to say. */
export const successResponse = json(
  'Done.',
  object({ success: { type: 'boolean', example: true } }),
  { success: true },
);

/**
 * Standard responses for an authenticated endpoint. Spread this and add the
 * successes and any endpoint-specific failures on top.
 */
export const authErrors = {
  401: resp('Unauthorized'),
  429: resp('RateLimited'),
  500: resp('ServerError'),
} as const;

/** As above, plus the 402 every Plus-gated route can return. */
export const plusErrors = {
  401: resp('Unauthorized'),
  402: resp('PlusRequired'),
  429: resp('RateLimited'),
  500: resp('ServerError'),
} as const;

/** Marks an operation as requiring no authentication, overriding the document default. */
export const publicEndpoint = { security: [] };
