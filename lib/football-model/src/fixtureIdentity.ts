/**
 * 同じ試合の二重登録と、それが生む「1 試合 2 予想」「封緘後の予想」の扱い（純粋関数）。
 *
 * **なぜ要るか（2026-09-25 に台帳から実測）**: 日程の取得元が 2 つあり、日程変更もあるため、
 * 同じ対戦（リーグ・ホーム・アウェイ）が 1.1〜2.0 日ずれた別の providerId で 5 件
 * 二重に登録されていた。二重登録の検査（recordFixtures）は ±1 日しか見ていなかった。
 * その結果:
 *   - 4 試合で予想が 2 本立ち、**2 本とも決済されて 1 試合を 2 回数えていた**
 *     （Torino–Roma / Como–Parma / Osasuna–Espanol / Ath Bilbao–Elche）
 *   - うち 2 本は**実際の試合の封緘後**に発行されていた（古い日付の登録の封緘で通った）
 *   - Sevilla–Valencia は 9/11 に開催済みなのに、9/13 の登録に対して 9/12 00:08Z に
 *     **試合後の予想**が発行され、結果と結べずに決済待ちのまま残っていた
 * 規定は「予想は 1 試合 1 回だけ、封緘より前に発行」。台帳は追記専用なので行は消さず、
 * 発行時に止め、集計では数えない。
 *
 * 規則:
 *   - 同じリーグ・同じホーム・同じアウェイで、キックオフが SAME_FIXTURE_WINDOW_MS 以内の
 *     登録は**同じ試合**とみなす（リーグ戦で同じ本拠地の同一カードが 1 週間以内に
 *     組まれることは無い。スコットランドの 4 回戦制でも同じカードの間隔は数週間）
 *   - その試合の封緘は、登録のうち**最も早い封緘**（日程が前倒しされた場合に、古い後ろの
 *     日付の封緘で予想が通ってしまうのを防ぐ・安全側）
 *   - 数えるのは、その封緘より前に発行された予想のうち**最も早く発行された 1 本**
 */
import type { LedgerMatch, LedgerPrediction } from "./ledger.ts";

export const SAME_FIXTURE_WINDOW_MS = 7 * 86_400_000;

type Pairing = Pick<LedgerMatch, "league" | "home" | "away" | "kickoffAt">;

export function sameFixture(a: Pairing, b: Pairing): boolean {
  return (
    a.league === b.league &&
    a.home === b.home &&
    a.away === b.away &&
    Math.abs(Date.parse(a.kickoffAt) - Date.parse(b.kickoffAt)) <= SAME_FIXTURE_WINDOW_MS
  );
}

/** その試合の登録（自分を含む・現在有効な行）。 */
export function fixtureRegistrations(m: Pairing, matches: Iterable<LedgerMatch>): LedgerMatch[] {
  const out: LedgerMatch[] = [];
  for (const x of matches) if (sameFixture(m, x)) out.push(x);
  return out;
}

export interface CountedPredictions {
  /** 集計に数える予想の id */
  counted: Set<string>;
  /** 数えない予想の id → 理由（台帳には残っている） */
  excluded: Map<string, string>;
}

/**
 * どの予想を集計に数えるか。台帳の行は変えない。登録の無い予想（matches に無い
 * providerId）は同定できないので、そのまま数える（従来の挙動）。
 */
export function countedPredictions(
  predictions: LedgerPrediction[],
  matches: Map<string, LedgerMatch>,
): CountedPredictions {
  const all = [...matches.values()];
  const counted = new Set<string>();
  const excluded = new Map<string, string>();
  // 試合ごとに束ねる（予想の登録行を起点に、同じ試合の登録を集める）
  const groups = new Map<string, { preds: LedgerPrediction[]; cutoff: number; earliest: LedgerMatch }>();
  for (const p of predictions) {
    const m = matches.get(p.providerId);
    if (!m) {
      counted.add(p.id);
      continue;
    }
    const regs = fixtureRegistrations({ ...m, kickoffAt: p.kickoffAt }, all);
    const earliest = regs.reduce((a, b) => (Date.parse(b.cutoffAt) < Date.parse(a.cutoffAt) ? b : a), m);
    // 束ねる鍵は、同じ試合の登録のうち最も小さい providerId（順序に依らない）
    const key = [...regs.map((r) => r.providerId), m.providerId].sort()[0]!;
    // 読めない封緘（空・壊れた値）は判断に使わない。1 つも読めなければ「封緘後」とは言えない
    const cutoffs = [p.cutoffAt, ...regs.map((r) => r.cutoffAt)].map((c) => Date.parse(c)).filter((t) => Number.isFinite(t));
    const cutoff = cutoffs.length ? Math.min(...cutoffs) : Infinity;
    const g = groups.get(key);
    if (g) {
      g.preds.push(p);
      if (cutoff < g.cutoff) {
        g.cutoff = cutoff;
        g.earliest = earliest;
      }
    } else {
      groups.set(key, { preds: [p], cutoff, earliest });
    }
  }
  for (const g of groups.values()) {
    const inTime = g.preds
      .filter((p) => Date.parse(p.publishedAt) < g.cutoff)
      .sort((a, b) => a.publishedAt.localeCompare(b.publishedAt) || a.id.localeCompare(b.id));
    for (const p of g.preds) {
      if (Date.parse(p.publishedAt) >= g.cutoff) {
        excluded.set(p.id, `同じ試合の早い登録（${g.earliest.kickoffAt}）の封緘 ${new Date(g.cutoff).toISOString()} より後の発行`);
      } else if (p !== inTime[0]) {
        excluded.set(p.id, `同じ試合の 2 本目の予想（数えるのは ${inTime[0]!.id}）`);
      } else {
        counted.add(p.id);
      }
    }
  }
  return { counted, excluded };
}
