/** JSON serialization with recursively sorted object keys and stable array order. */
export function canonicalJsonStringify(value: unknown): string {
  const encode = (item: unknown): string | undefined => {
    if (item === null || typeof item !== "object") return JSON.stringify(item);
    if (Array.isArray(item)) return `[${item.map((entry) => encode(entry) ?? "null").join(",")}]`;
    const record = item as Record<string, unknown>;
    const fields = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(record[key]) ?? "null"}`);
    return `{${fields.join(",")}}`;
  };
  return encode(value) ?? "null";
}
