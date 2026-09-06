import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Ledger } from "../src/ledger.ts";

/** 空の台帳（一時ディレクトリ） */
export function fresh(): Ledger {
  return new Ledger(mkdtempSync(join(tmpdir(), "ledger-")));
}
