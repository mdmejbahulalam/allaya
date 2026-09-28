/** Sortable-ish unique id with a readable prefix, e.g. `task_2f6c…`. */
export function newId(prefix?: string): string {
  const uuid = globalThis.crypto.randomUUID().replace(/-/g, '');
  return prefix ? `${prefix}_${uuid}` : uuid;
}
