// Tiny schema combinators. Everything crossing a trust boundary (RPC params,
// imported backups, records read back from IndexedDB) goes through these.

export type Parser<T> = (value: unknown, path?: string) => T;

export class ValidationError extends Error {
  constructor(path: string, expected: string) {
    super(`Invalid value at ${path || 'root'}: expected ${expected}`);
    this.name = 'ValidationError';
  }
}

const fail = (path: string | undefined, expected: string): never => {
  throw new ValidationError(path ?? '', expected);
};

export const string =
  (max = 100_000): Parser<string> =>
  (v, p) => {
    if (typeof v !== 'string') fail(p, 'string');
    return (v as string).slice(0, max);
  };

export const nonEmpty =
  (max = 500): Parser<string> =>
  (v, p) => {
    const s = string(max)(v, p).trim();
    if (!s) fail(p, 'non-empty string');
    return s;
  };

export const number: Parser<number> = (v, p) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'number');
  return v as number;
};

export const integer: Parser<number> = (v, p) => {
  const n = number(v, p);
  if (!Number.isInteger(n)) fail(p, 'integer');
  return n;
};

export const boolean: Parser<boolean> = (v, p) => {
  if (typeof v !== 'boolean') fail(p, 'boolean');
  return v as boolean;
};

export const oneOf =
  <const T extends readonly unknown[]>(values: T): Parser<T[number]> =>
  (v, p) => {
    if (!values.includes(v)) fail(p, `one of ${values.join(', ')}`);
    return v as T[number];
  };

export const optional =
  <T>(inner: Parser<T>): Parser<T | undefined> =>
  (v, p) =>
    v === undefined || v === null ? undefined : inner(v, p);

export const withDefault =
  <T>(inner: Parser<T>, fallback: T): Parser<T> =>
  (v, p) =>
    v === undefined || v === null ? fallback : inner(v, p);

export const array =
  <T>(inner: Parser<T>, maxLength = 100_000): Parser<T[]> =>
  (v, p) => {
    if (!Array.isArray(v)) fail(p, 'array');
    if ((v as unknown[]).length > maxLength) fail(p, `at most ${maxLength} entries`);
    return (v as unknown[]).map((item, i) => inner(item, `${p ?? ''}[${i}]`));
  };

export const record =
  <T>(inner: Parser<T>): Parser<Record<string, T>> =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'object');
    const out: Record<string, T> = {};
    for (const [k, val] of Object.entries(v as object)) {
      if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
      out[k] = inner(val, `${p ?? ''}.${k}`);
    }
    return out;
  };

type Shape = Record<string, Parser<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends ReturnType<S[K]> ? K : never }[keyof S];
type Infer<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: ReturnType<S[K]> } & {
  [K in OptionalKeys<S>]?: ReturnType<S[K]>;
};

/** Unknown keys are dropped so stored records can't accumulate junk. */
export const object =
  <S extends Shape>(shape: S): Parser<Infer<S>> =>
  (v, p) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(p, 'object');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(shape)) {
      const parsed = shape[key]!((v as Record<string, unknown>)[key], p ? `${p}.${key}` : key);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out as Infer<S>;
  };

export const union =
  <T>(...parsers: Parser<T>[]): Parser<T> =>
  (v, p) => {
    for (const parser of parsers) {
      try {
        return parser(v, p);
      } catch {
        // try next
      }
    }
    return fail(p, 'a valid variant');
  };

/** Run a parser and return null instead of throwing. */
export function tryParse<T>(parser: Parser<T>, value: unknown): T | null {
  try {
    return parser(value);
  } catch {
    return null;
  }
}
