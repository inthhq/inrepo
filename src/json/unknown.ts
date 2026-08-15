export type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonObject | JsonPrimitive | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";

export const isFunction = (
  value: unknown
): value is (...args: never[]) => unknown => typeof value === "function";

export const isNumber = (value: unknown): value is number =>
  typeof value === "number";

export const isString = (value: unknown): value is string =>
  typeof value === "string";

export const isUndefined = (value: unknown): value is undefined =>
  value === undefined;

export const isJsonObject = (value: unknown): value is JsonObject =>
  value != null && typeof value === "object" && !Array.isArray(value);
