/**
 * Tiny JSON-file persistence shared by the subscription store and the
 * delivery queue: versioned envelope, atomic writes (write-then-rename so a
 * crash never leaves a half-written subscriber list), loud errors on foreign
 * or corrupt files.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Envelope<T> {
  pushforge: string;
  version: 1;
  data: T;
}

/** Load a versioned pushforge JSON file, or return `empty` if absent. */
export function loadJsonFile<T>(path: string, kind: string, empty: T): T {
  if (!existsSync(path)) return empty;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${path} is not valid JSON: ${(err as Error).message}`);
  }
  const envelope = parsed as Partial<Envelope<T>>;
  if (envelope === null || typeof envelope !== "object" || envelope.pushforge !== kind) {
    throw new Error(`${path} is not a pushforge ${kind} file`);
  }
  if (envelope.version !== 1) {
    throw new Error(`${path} has unsupported version ${String(envelope.version)} (this build reads version 1)`);
  }
  if (envelope.data === undefined) {
    throw new Error(`${path} is missing its data section`);
  }
  return envelope.data;
}

/** Atomically persist a versioned pushforge JSON file. */
export function saveJsonFile<T>(path: string, kind: string, data: T): void {
  const envelope: Envelope<T> = { pushforge: kind, version: 1, data };
  const dir = dirname(path);
  if (dir !== "" && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(envelope, null, 2) + "\n");
  renameSync(tmp, path);
}
