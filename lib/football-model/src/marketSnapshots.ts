/**
 * 市場スナップショットの索引（`football/market/<sport>/<取得時刻>.json`）。
 *
 * **なぜ要るか**: 予想行の `market` は**発行時点**の市場である。2026-09-16 に発行範囲を
 * 48 時間 → 720 時間へ広げた結果、オッズが先まで出るリーグ（E0 / I1 / D1 / F1 は実測で
 * 25.8 日先まで）は**キックオフの 3 週間以上前に封緘される**ようになった。予想は
 * 1 試合 1 回で書き換えないので、その市場値も 3 週間前のまま台帳に固定される。
 *
 * 市場はキックオフに近づくほど良くなる（同一試合集合での実測・2026-09-17）:
 *
 * | スナップショットの時点 | n | 市場 RPS | 直前比 |
 * |---|---|---|---|
 * | 0-1 日前（直前） | 151 | 0.2010 | — |
 * | 1-3 日前 | 146 | 0.2027 | +0.0002 |
 * | 3-7 日前 | 109 | 0.2012 | +0.0004 |
 * | 7 日以上前 | 49 | 0.1981 | +0.0051 |
 *
 * 差は単調ではなく n=49 では有意でもない（t=1.38）が、**符号は一貫して「古いほど悪い」**で、
 * 大きさ（+0.005）はモデルと市場の差（約 0.009）の半分に達する。発行が 3 週間前になった今、
 * 発行時点の市場だけで対照し続けると**ベンチマークが year を追うごとに甘くなり、
 * モデルを不当に良く見せる**。よって決済では「キックオフ直前の最新スナップショット」を使う。
 *
 * **台帳の写しを作らない**（CLAUDE.md の二重管理の禁止）。`football/market/` は取得ごとに
 * 1 ファイルの追記専用で、それ自体が時系列である。ここはその索引を作るだけで、
 * 新しい ndjson は増やさない。
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ProbabilityTriple } from "./scoring.ts";

export interface MarketSnapshot {
  /** 取得時刻（ファイル名由来・ISO） */
  fetchedAt: string;
  market: ProbabilityTriple;
}

/** ファイル名 `20260917T002649Z.json` → `2026-09-17T00:26:49Z`。読めなければ null */
export function fetchedAtOfFilename(name: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.json$/.exec(name);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

/**
 * providerId → スナップショットの列（取得時刻の昇順）。
 * 壊れたファイルは**飛ばす**（1 ファイルの破損で決済を止めない。台帳ではなく写しなので、
 * 欠けても「その時点の市場が分からない」だけで済む）。
 */
export function indexMarketSnapshots(marketDir: string): Map<string, MarketSnapshot[]> {
  const out = new Map<string, MarketSnapshot[]>();
  if (!existsSync(marketDir)) return out;
  for (const sport of readdirSync(marketDir, { withFileTypes: true })) {
    if (!sport.isDirectory()) continue;
    const dir = join(marketDir, sport.name);
    for (const file of readdirSync(dir)) {
      const fetchedAt = fetchedAtOfFilename(file);
      if (fetchedAt === null) continue;
      let rows: unknown;
      try {
        rows = JSON.parse(readFileSync(join(dir, file), "utf8"));
      } catch {
        continue;
      }
      if (!Array.isArray(rows)) continue;
      for (const r of rows as Array<{ providerId?: unknown; market?: unknown }>) {
        if (typeof r.providerId !== "string") continue;
        const m = r.market;
        if (!Array.isArray(m) || m.length !== 3 || m.some((x) => typeof x !== "number")) continue;
        const list = out.get(r.providerId);
        const snap: MarketSnapshot = { fetchedAt, market: [m[0], m[1], m[2]] as ProbabilityTriple };
        if (list) list.push(snap);
        else out.set(r.providerId, [snap]);
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  return out;
}

/**
 * キックオフより前の最新スナップショット（＝クロージングに最も近い市場）。
 * キックオフ以降のスナップショットは**使わない**。試合が始まった後のオッズは
 * 試合内容を織り込んでおり、予想の対照に使えば後知恵になる。
 */
export function closingBefore(
  index: Map<string, MarketSnapshot[]>,
  providerId: string,
  kickoffAt: string,
): MarketSnapshot | null {
  const list = index.get(providerId);
  if (!list) return null;
  let best: MarketSnapshot | null = null;
  for (const s of list) {
    if (s.fetchedAt >= kickoffAt) break; // 昇順なので以降は全て試合後
    best = s;
  }
  return best;
}

/** 決済に渡す解決子。Ledger にディレクトリの知識を持たせないための関数型 */
export type ClosingMarketResolver = (providerId: string, kickoffAt: string) => MarketSnapshot | null;

export function closingMarketResolver(marketDir: string): ClosingMarketResolver {
  const index = indexMarketSnapshots(marketDir);
  return (providerId, kickoffAt) => closingBefore(index, providerId, kickoffAt);
}
