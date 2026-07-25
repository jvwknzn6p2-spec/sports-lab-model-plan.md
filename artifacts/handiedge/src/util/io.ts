/** Schema-validated file IO. Reads fail loudly if the data doesn't match. */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ZodType } from "zod/v4";

export function readValidated<T>(path: string, schema: ZodType<T>): T {
  if (!existsSync(path)) {
    throw new Error(`input file not found: ${path}`);
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`schema validation failed for ${path}: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function writeValidated<T>(path: string, schema: ZodType<T>, data: T): void {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`refusing to write invalid output to ${path}: ${parsed.error.message}`);
  }
  writeJson(path, parsed.data);
}

export function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), "utf-8");
}

export function appendJsonl(path: string, record: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n", "utf-8");
}
