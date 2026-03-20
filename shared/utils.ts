export function nowIso() {
  return new Date().toISOString();
}

export function makeId(prefix: string) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${String(x)}`);
}
