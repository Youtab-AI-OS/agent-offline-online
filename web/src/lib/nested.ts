function configPathParts(path: string): string[] {
  const parts = path.split(".");
  if (parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype")) {
    throw new TypeError("Unsafe config path");
  }
  return parts;
}

export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = configPathParts(path);
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object" || !Object.hasOwn(cur, p)) return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}

export function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const parts = configPathParts(path);
  const clone = structuredClone(obj);
  let cur: Record<string, unknown> = clone;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!Object.hasOwn(cur, parts[i]) || cur[parts[i]] == null || typeof cur[parts[i]] !== "object") {
      cur[parts[i]] = {};
    }
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
  return clone;
}