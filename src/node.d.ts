/**
 * Minimal ambient declarations for the Node.js built-ins and web globals this
 * project uses. Declaring them in-repo keeps `typescript` the only
 * devDependency (no `@types/node`); the surface below is intentionally
 * restricted to exactly what `src/` calls, so a typo against a real Node API
 * still fails to compile.
 */

declare module "node:fs" {
  export function readFileSync(path: string | number, encoding: "utf8"): string;
  export function writeFileSync(path: string, data: string): void;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function renameSync(oldPath: string, newPath: string): void;
  export function existsSync(path: string): boolean;
}

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function dirname(p: string): string;
  export function basename(p: string, ext?: string): string;
}

declare var process: {
  argv: string[];
  cwd(): string;
  exitCode: number | undefined;
  exit(code?: number): never;
  stdout: {
    write(chunk: string): boolean;
    on(event: "error", listener: (err: Error & { code?: string }) => void): void;
  };
  stderr: { write(chunk: string): boolean };
  env: Record<string, string | undefined>;
  stdin: {
    setEncoding(encoding: "utf8"): void;
    on(event: "data", listener: (chunk: string) => void): void;
    on(event: "end", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
  };
};

declare class URL {
  constructor(input: string, base?: string);
  readonly origin: string;
  readonly protocol: string;
  readonly host: string;
  readonly pathname: string;
}

declare class TextEncoder {
  encode(input: string): Uint8Array;
}

declare class TextDecoder {
  constructor(label?: "utf-8", options?: { fatal?: boolean });
  decode(input: Uint8Array): string;
}

/** Minimal fetch surface for the default (real) transport. */
declare function fetch(
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
  },
): Promise<{ status: number; headers: { get(name: string): string | null } }>;
