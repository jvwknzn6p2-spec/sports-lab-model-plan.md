/**
 * 取込と決済の健全性（純粋関数。I/O は cli/football.ts）。
 *
 * **なぜ要るか（2026-09-16〜17 の実発生）**: 結果の取得元 3 経路が同時に落ち、
 * 9/15 以降の結果が 1 件も入らないまま日次が 2 回「成功」で終わった。取得は
 * 「欠けても止めない」設計（予想を取得元の生死から切り離すため・2026-09-09）なので、
 * 落ちても緑になる。つまり**記録が凍っていることは、緑のログからは見えない**。
 *
 * VORTE EV の `ingest_health` と同じ考え方で、判断を足す前に**生の事実**を出す:
 *   - 直近で結果を何時間取り込めていないか（`hoursSinceRecord`）
 *   - 開始済みなのに決済されていない予想（`backlog`）
 *
 * 閾値の根拠（本番台帳 155 決済の実測・2026-09-17）:
 *   決済ラグ（キックオフ→決済）は 中央値 13.9h / 90%点 97.5h / 最大 118.5h。
 *   **バックログの古さで警報を出すと、正常な遅れ（〜5 日）と区別が付かない。**
 *   よって警報の主軸は「結果を 1 件も取り込めていない時間」にする。
 *
 * **ただし「そもそも仕事が無かった」は必ず起きる**（2026-09-25 に判明。当初の
 * 「毎日どこかのリーグで試合がある」という前提は誤りだった）。国際試合週間は
 * 10 リーグすべてが同時に止まり、2026-09-22〜10-09 は**17 日間 1 試合も無い**。
 * 時間だけで測ると日次が 2 週間赤くなる。実測でも、健全に動いていた期間の取込間隔は
 * 中央値 24.4h に対し **最大 127.6h**（9/04→9/09）・**96.6h**（9/18→9/22）あり、
 * 現行の 72h は**平常運転でも鳴っていた**。VORTE EV の `expected_24h`（NPB の月曜
 * 休養日）と同じ形で、**沈黙を数える前に「結果が出ているはずの試合があるか」を見る**。
 */
import type { LedgerEvaluation, LedgerMatch, LedgerPrediction, LedgerResult } from "./ledger.ts";

/** 取り込みが止まっている、と判断するまでの時間（警告）。日次 1 回なので 24h では毎回出る */
export const INGEST_WARN_HOURS = 36;
/**
 * 失敗させるまでの時間。72h ＝ 日次 3 回連続で 1 件も取り込めていない。
 * VORTE EV の `archive-freshness`（72 時間＝3 回連続で CI を落とす）と同じ基準。
 */
export const INGEST_FAIL_HOURS = 72;
/**
 * 試合が終わってから「結果はもう入っているはずだ」と言えるまでの猶予。
 *
 * 実測（台帳が日次で回り始めた 2026-09-10 以降の結果 189 件・キックオフ日 00:00Z からの
 * 取込までの時間）: 中央値 48.7h / p75 72.7h / p95 96.3h / **最大 111.5h**。
 * 取得元（football-data.co.uk の CSV）が週明けにまとめて更新されるためで、
 * **4 日以上かかるのは異常ではない**。111.5 をそのまま書かないのは標本 189 件に対して
 * 精度を詐称しないため。この猶予より新しい試合は「まだ来ていないだけ」として数えない。
 *
 * 履歴の全期間（9/03〜9/23）で、この猶予を使うと**誤警報は 0 件**になる（実測）。
 */
export const RESULT_DUE_HOURS = 120;

export interface IngestHealth {
  /** 結果を最後に台帳へ書いた時刻（ISO）。1 件も無ければ null */
  lastRecordedAt: string | null;
  /** そこからの経過時間。lastRecordedAt が無ければ null */
  hoursSinceRecord: number | null;
  /** 取り込めている最新の試合日（YYYY-MM-DD）。1 件も無ければ null */
  lastMatchDate: string | null;
  /** 台帳の結果の件数 */
  results: number;
}

export function ingestHealth(results: LedgerResult[], nowIso: string): IngestHealth {
  let lastRecordedAt: string | null = null;
  let lastMatchDate: string | null = null;
  for (const r of results) {
    if (lastRecordedAt === null || r.recordedAt > lastRecordedAt) lastRecordedAt = r.recordedAt;
    if (lastMatchDate === null || r.date > lastMatchDate) lastMatchDate = r.date;
  }
  const hoursSinceRecord = lastRecordedAt === null ? null : (Date.parse(nowIso) - Date.parse(lastRecordedAt)) / 3_600_000;
  return { lastRecordedAt, hoursSinceRecord, lastMatchDate, results: results.length };
}

export interface BacklogEntry {
  predictionId: string;
  providerId: string;
  league: string;
  kickoffAt: string;
  /** キックオフからの経過時間 */
  ageHours: number;
}

/**
 * 開始済みなのに決済されていない予想（古い順）。`minAgeHours` より新しいものは
 * 「まだ結果が出ていないだけ」なので数えない（既定 6 時間＝試合時間 + 余裕）。
 *
 * これは**警報ではなく内訳**である。上の実測どおり、正常でも 5 日かかる決済があるため、
 * 古さだけで故障とは言えない。何が止まっているかを人が読むための一覧として出す。
 */
export function settlementBacklog(
  predictions: LedgerPrediction[],
  evaluations: LedgerEvaluation[],
  nowIso: string,
  minAgeHours = 6,
): BacklogEntry[] {
  const done = new Set(evaluations.map((e) => e.predictionId));
  const now = Date.parse(nowIso);
  const out: BacklogEntry[] = [];
  for (const p of predictions) {
    if (done.has(p.id)) continue;
    const ageHours = (now - Date.parse(p.kickoffAt)) / 3_600_000;
    if (ageHours < minAgeHours) continue;
    out.push({ predictionId: p.id, providerId: p.providerId, league: p.league, kickoffAt: p.kickoffAt, ageHours });
  }
  return out.sort((a, b) => b.ageHours - a.ageHours);
}

export type HealthLevel = "ok" | "warn" | "fail";

/** 結果が入っているはずなのに入っていない試合（最古の 1 件） */
export interface DueMatch {
  league: string;
  kickoffAt: string;
  /** キックオフからの経過時間 */
  ageHours: number;
}

/**
 * **沈黙の期待**（VORTE EV の `expected_24h` と同じ役割）。
 *
 * 最後に結果を書いた時刻より後にキックオフし、かつ `dueHours` 以上経った試合を返す
 * （最古の 1 件。無ければ null）。**最後の取込より後に始まった試合の結果は、定義上
 * まだ台帳に無い**（書き込みはキックオフより前に終わっているため）ので、結果の照合は要らない。
 *
 * null は「取り込むべきものが無い」＝沈黙は期待どおり、という意味であり、
 * **取込が健全であることの証明ではない**。生の事実（`hoursSinceRecord`）は
 * `ingestHealth` にそのまま残す。判断を足すのはこちら側だけにする。
 */
export function ingestDue(
  matches: Iterable<LedgerMatch>,
  lastRecordedAt: string | null,
  nowIso: string,
  dueHours = RESULT_DUE_HOURS,
): DueMatch | null {
  if (lastRecordedAt === null) return null;
  const now = Date.parse(nowIso);
  const since = Date.parse(lastRecordedAt);
  let oldest: DueMatch | null = null;
  for (const m of matches) {
    const kickoff = Date.parse(m.kickoffAt);
    if (kickoff <= since) continue;
    const ageHours = (now - kickoff) / 3_600_000;
    if (ageHours < dueHours) continue;
    if (oldest === null || m.kickoffAt < oldest.kickoffAt) {
      oldest = { league: m.league, kickoffAt: m.kickoffAt, ageHours };
    }
  }
  return oldest;
}

/**
 * 警報の段階。次の 2 つはどちらも **ok** とする。
 *  - `lastRecordedAt` が無い（結果が 1 件も無い）台帳 — 立ち上げ直後を故障と呼ばない
 *  - `due` が null — 結果が出ているはずの試合が 1 件も無い（国際試合週間・オフ）。
 *    ここを見ないと、試合が 1 試合も無い 17 日間ずっと赤になる
 *
 * **検知は遅くなる**（取得元が全部落ちた場合、気付くのは試合日から `RESULT_DUE_HOURS`
 * ＝ 5 日後）。それでも旧実装より良い: 旧実装の 72h は平常運転の取込間隔
 * （実測 最大 127.6h）を下回っており、**鳴っても故障と区別が付かなかった**。
 */
export function ingestLevel(
  h: IngestHealth,
  due: DueMatch | null,
  warnHours = INGEST_WARN_HOURS,
  failHours = INGEST_FAIL_HOURS,
): HealthLevel {
  if (h.hoursSinceRecord === null) return "ok";
  if (due === null) return "ok";
  if (h.hoursSinceRecord >= failHours) return "fail";
  if (h.hoursSinceRecord >= warnHours) return "warn";
  return "ok";
}

/* ────────────────────────────────────────────────────────────────────────────
 * 発行の沈黙（2026-09-22・Founder 承認 1-1）
 *
 * **なぜ要るか（2026-09-19〜22 の実発生）**: The Odds API のクレジットが尽き、日程の
 * 取得元が 1 本しか無かったため、**4 日間まったく予想が発行されなかった**。その間
 * 日次は毎回緑で、`ingestHealth` は結果しか見ていないので何も鳴らなかった。
 * 決済が 72 時間で赤くなる仕組みはあるのに、**商品そのもの（予想）が止まっても緑**だった。
 *
 * **台帳からは検知できない**（実測）。`recordFixtures` は内容が変わったときだけ追記する
 * ので、「取得元が同じ日程を返した」と「取得元が何も返さなかった」は台帳上で同じに見える。
 * 実際、日程を書いた回の間隔は 中央値 53.9h・最大 103.9h あり、ここに時間の閾値を
 * 置くと平常運転でも鳴る。
 *
 * そこで**日次に 1 回分の実績（`RunReport`）を書かせ、health がそれを読む**。
 * 取得元が返した試合数はその回にしか存在しない事実で、書き残さないと永久に失われる。
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * 日程が 0 件の回がこれだけ続いたら失敗させる。
 *
 * **2 にしたのは実測の結果**（2026-09-22）。事故（9/19〜）を再現すると、在季の 0 件は
 * **9/19 と 9/20 の 2 回で止まった** — 9/21 以降は国際試合週間に入り、次のキックオフが
 * 18 日先になって「季が動いていない」扱いになるため。**3 回にすると事故そのものを
 * 取り逃がす**ので、この失敗様式に合わせて 2 回にする。
 *
 * 偽陽性の側: 在季（3 日以内にキックオフがある）で 0 件ということは、The Odds API と
 * 無料の fixtures.csv の**両方**が試合を 1 件も返さなかったということ。fixtures.csv は
 * 約 3 日先まで載るので、在季なら必ず何か返る。2 回連続 ≒ 48 時間の同時障害であり、
 * そのとき予想は 1 件も出せていない。赤くするのが正しい。
 */
export const ZERO_FIXTURE_FAIL_RUNS = 2;
/** 「季が動いている」と見なすキックオフまでの日数。これ以内の試合が台帳に無い回は数えない */
export const SEASON_LIVE_DAYS = 3;
/** 取りこぼしを数える窓。古い取りこぼしで永久に赤くしない */
export const MISSED_SEAL_WINDOW_DAYS = 14;
/**
 * この時刻より前の取りこぼしは**報告するが赤くしない**（この仕組みの記録開始日）。
 *
 * 導入時に実測したところ、**2026-09-13 封緘の 31 件が既に取りこぼされていた**
 * （日次が 9/12 23:55Z の次は 9/14 00:04Z で、9/13 の回が存在しない）。原因は未特定
 * （UNKNOWN）。これらは既に起きてしまったことで、いま直せるものではない。
 * **過去の分で赤を出し続けると、新しい取りこぼしが埋もれる。** VORTE EV の
 * `handiedge_record_start()` と同じ考え方で、記録開始日より後のものだけを判定に使い、
 * 過去の分は参考として一覧に出す。
 */
export const PUBLISH_HEALTH_START = "2026-09-22T00:00:00Z";

export interface RunLeague {
  league: string;
  /**
   * 取得元が返した試合のうち**キックオフが未来のもの**（The Odds API + 無料の
   * fixtures.csv の合計・重複込み）。
   *
   * **行数で数えてはいけない**（2026-09-22 実測）。football-data.co.uk が凍結すると
   * fixtures.csv は過去の試合だけを返し続ける。行数だと 81 件返ってきて「取得元は
   * 生きている」に見えるのに、発行できる試合は 1 件も無い。
   */
  fixtures: number;
  /** 台帳へ新しく入った日程の行数 */
  added: number;
  /** この回で発行した予想 */
  published: number;
  /** 市場が無くて見送った（封緘まで余裕がある） */
  deferred: number;
  /** この回の時点で封緘前だった試合 */
  openBeforeCutoff: number;
}

export interface RunReport {
  at: string;
  /** 日程が 0 件だった回が何回続いているか（季が動いている回だけ数える） */
  zeroFixtureRuns: number;
  leagues: RunLeague[];
}

/** 合計を出す（表示と判定の両方で使う） */
export function runTotals(r: RunReport): Omit<RunLeague, "league"> {
  const z = { fixtures: 0, added: 0, published: 0, deferred: 0, openBeforeCutoff: 0 };
  for (const l of r.leagues) {
    z.fixtures += l.fixtures;
    z.added += l.added;
    z.published += l.published;
    z.deferred += l.deferred;
    z.openBeforeCutoff += l.openBeforeCutoff;
  }
  return z;
}

/**
 * 季が動いているか＝台帳に `SEASON_LIVE_DAYS` 日以内のキックオフがあるか。
 *
 * **これが「そもそも仕事が無かった」を除く装置**（VORTE EV の `expected_24h` と同じ役割）。
 * 国際試合週間やオフシーズンは fixtures.csv も空になるが、その期間は直近のキックオフも
 * 無いので 0 件の回として数えない。2026-09-19〜21 の事故では次のキックオフが 1 日以内に
 * あったため、3 回とも数えられて 9/21 の回で赤くなる。
 */
export function seasonLive(kickoffs: Iterable<string>, nowIso: string, days = SEASON_LIVE_DAYS): boolean {
  const now = Date.parse(nowIso);
  const until = now + days * 86_400_000;
  for (const k of kickoffs) {
    const t = Date.parse(k);
    if (t > now && t <= until) return true;
  }
  return false;
}

/** 次の回の `zeroFixtureRuns`。季が動いていない回は据え置く（増やしも減らしもしない） */
export function nextZeroFixtureRuns(prev: number, fixtures: number, live: boolean): number {
  if (fixtures > 0) return 0;
  if (!live) return prev;
  return prev + 1;
}

export interface MissedSeal {
  providerId: string;
  league: string;
  kickoffAt: string;
  cutoffAt: string;
  /** その試合が台帳に最初に入った時刻 */
  firstRecordedAt: string;
  /** 両チームとも学習データにあるか。false なら予想を出しようがない（欠陥ではない） */
  predictable: boolean;
}

/**
 * **取りこぼし**＝封緘より前に台帳へ入っていたのに、封緘を過ぎても予想が無い試合。
 *
 * 「出せたのに出さなかった」だけを数える。封緘後に初めて台帳へ入った試合（無料の
 * fixtures.csv は約 3 日先までしか載らないので当日登録が起こりうる）は対象外にする。
 * 学習データに無いチーム（昇格直後など）は `predictable=false` として分け、判定に使わない。
 */
export function missedSeals(
  matches: Array<{ providerId: string; league: string; kickoffAt: string; cutoffAt: string; recordedAt: string }>,
  publishedProviderIds: Set<string>,
  knownTeamsOf: (m: { providerId: string }) => boolean,
  nowIso: string,
  windowDays = MISSED_SEAL_WINDOW_DAYS,
): MissedSeal[] {
  const now = Date.parse(nowIso);
  const since = now - windowDays * 86_400_000;
  /** providerId ごとに最初の登録時刻と最新の行 */
  const first = new Map<string, string>();
  const latest = new Map<string, (typeof matches)[number]>();
  for (const m of matches) {
    const f = first.get(m.providerId);
    if (f === undefined || m.recordedAt < f) first.set(m.providerId, m.recordedAt);
    latest.set(m.providerId, m);
  }
  const out: MissedSeal[] = [];
  for (const [providerId, m] of latest) {
    if (publishedProviderIds.has(providerId)) continue;
    const cutoff = Date.parse(m.cutoffAt);
    if (cutoff > now || cutoff < since) continue; // まだ封緘前 / 古すぎる
    const firstRecordedAt = first.get(providerId)!;
    if (Date.parse(firstRecordedAt) >= cutoff) continue; // 封緘後に初めて入った試合
    out.push({ providerId, league: m.league, kickoffAt: m.kickoffAt, cutoffAt: m.cutoffAt, firstRecordedAt, predictable: knownTeamsOf(m) });
  }
  return out.sort((a, b) => b.cutoffAt.localeCompare(a.cutoffAt));
}

export interface PublishHealth {
  level: HealthLevel;
  /** 赤・黄にした理由（空なら ok） */
  reasons: string[];
  zeroFixtureRuns: number;
  /** 出せたのに出していない試合（予想可能・記録開始日より後）。判定に使う */
  missed: MissedSeal[];
  /** 記録開始日より前の取りこぼし（参考。判定には使わない） */
  missedBeforeStart: MissedSeal[];
  /** 学習データが無く出しようがなかった試合（参考。判定には使わない） */
  unpredictable: MissedSeal[];
}

/**
 * 発行側の警報。**report が無い回は ok**（この仕組みより前の台帳・初回実行を故障と呼ばない）。
 */
export function publishLevel(report: RunReport | null, missed: MissedSeal[], startIso = PUBLISH_HEALTH_START): PublishHealth {
  const reasons: string[] = [];
  const predictable = missed.filter((m) => m.predictable);
  const can = predictable.filter((m) => m.cutoffAt >= startIso);
  const before = predictable.filter((m) => m.cutoffAt < startIso);
  const cannot = missed.filter((m) => !m.predictable);
  const zero = report?.zeroFixtureRuns ?? 0;
  if (zero >= ZERO_FIXTURE_FAIL_RUNS) {
    reasons.push(`日程の取得元が ${zero} 回連続で 1 件も試合を返していない（The Odds API / 無料の fixtures.csv の両方）`);
  }
  if (can.length > 0) {
    reasons.push(`封緘前に台帳へ入っていたのに予想が無い試合が ${can.length} 件ある`);
  }
  const level: HealthLevel = reasons.length ? "fail" : zero >= 1 ? "warn" : "ok";
  return { level, reasons, zeroFixtureRuns: zero, missed: can, missedBeforeStart: before, unpredictable: cannot };
}
