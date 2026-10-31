export function newId(): string {
  return crypto.randomUUID();
}

/** Small, stable, non-cryptographic hash (FNV-1a) used for change detection only. */
export function fnv1a(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}
