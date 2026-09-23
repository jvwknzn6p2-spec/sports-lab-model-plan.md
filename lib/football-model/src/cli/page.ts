/**
 * 公開ページ（VORTE FT）の生成。**台帳を読むだけで、一切書かない。**
 *
 *   node --experimental-strip-types src/cli/page.ts \
 *     --ledger football/ledger --out /path/vorte-ft-soccer.html \
 *     [--preview-ledger DIR] [--notice HTML] [--notice-tone alert|info] [--now ISO]
 *
 * 以前この生成器はスクラッチパッドにしか無く、コンテナが作り直されると毎日のページ更新が
 * 止まる状態だった。リポジトリに入れて恒久化したのが本ファイル（2026-09-23）。
 *
 * `--preview-ledger` は試算用。台帳を差し替えて描くが、**本物の台帳に無い予想行は
 * 「試算・台帳未発行」と明示する**（発行済みと見分けが付かなくなると記録の意味が消える）。
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction } from "../ledger.ts";
import { renderPage } from "../page/render.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function readNdjson<T>(dir: string, file: string): T[] {
  const text = readFileSync(join(dir, file), "utf8").trim();
  if (!text) return [];
  return text.split("\n").map((line) => JSON.parse(line) as T);
}

function main(): void {
  const ledgerDir = arg("ledger", process.env.LEDGER_DIR ?? "football/ledger")!;
  const previewDir = arg("preview-ledger", process.env.PREVIEW_LEDGER);
  const out = arg("out", process.env.OUT);
  if (!out) {
    console.error("--out（出力先の HTML パス）が要る");
    process.exit(2);
  }
  const readFrom = previewDir ?? ledgerDir;
  const isPreview = readFrom !== ledgerDir;

  const predictions = readNdjson<LedgerPrediction>(readFrom, "predictions.ndjson");
  const matches = readNdjson<LedgerMatch>(readFrom, "matches.ndjson");
  const evaluations = readNdjson<LedgerEvaluation>(readFrom, "evaluations.ndjson");
  // 発行済みの権威は常に本物の台帳。試算はここに入らない
  const publishedProviderIds = new Set(
    readNdjson<LedgerPrediction>(ledgerDir, "predictions.ndjson").map((p) => p.providerId),
  );

  const noticeTone = arg("notice-tone", process.env.NOTICE_TONE) === "info" ? "info" : "alert";
  const { html, stats } = renderPage({
    predictions,
    matches,
    evaluations,
    publishedProviderIds,
    isPreview,
    now: new Date(arg("now", process.env.NOW) ?? Date.now()),
    notice: arg("notice", process.env.NOTICE) ?? "",
    noticeTone,
  });

  writeFileSync(out, html);
  console.log(JSON.stringify({ out, ...stats }));
}

main();
