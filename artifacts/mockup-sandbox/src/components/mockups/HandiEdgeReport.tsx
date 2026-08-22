/**
 * HandiEdge cumulative report viewer — the record screen over
 * GET /api/report (aggregateHistory output + learned calibration state).
 *
 * Shows what the slate screen cannot: the running record and its
 * decompositions — P&L significance, calibration by stated band, the
 * confidence ladder, and the per-day history. Honesty rules carry over from
 * the pipeline: the "not yet distinguishable from luck" verdict is shown as
 * prominently as the units won, and a band the record indicts is flagged, not
 * smoothed away.
 */

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Bucket {
  lo: number;
  hi: number;
  n: number;
  statedMean: number;
  actualRate: number;
  gap: number;
  flag: "overconfident" | "underconfident" | null;
}

interface ConfidenceRow {
  confidence: "S" | "A" | "B" | "C";
  n: number;
  wins: number;
  losses: number;
  rate: number | null;
  profit: number;
  staked: number;
}

interface Report {
  summary: {
    dates: number;
    gamesSettled: number;
    gamesPassed: number;
    winnerRecord: { wins: number; losses: number };
    handicapRecord: { wins: number; losses: number };
    totalRecord: { wins: number; losses: number };
    winnerRate: number | null;
    meanBrier: number | null;
    statedMean: number | null;
    actualRate: number | null;
    handicapProfitTotal: number | null;
    handicapRoi: number | null;
    handicapProfitAssessment: {
      n: number;
      meanProfit: number;
      z: number;
      verdict: "ahead" | "behind" | "inconclusive";
    } | null;
    winnerBuckets: Bucket[];
    handicapBuckets: Bucket[];
    byConfidence: ConfidenceRow[];
    perDate: Array<{
      date: string;
      settled: number;
      passed: number;
      winnerRecord: { wins: number; losses: number };
      meanBrier: number | null;
    }>;
  };
  calibration: {
    shrink: number;
    tailShrink: number;
    farTailShrink: number;
    handicapShrink: number;
    handicapTailShrink: number;
    handicapFarTailShrink: number;
    totalShrink: number;
    totalTailShrink: number;
    totalFarTailShrink: number;
    gamesSettled: number;
  };
}

const CONF_STYLE: Record<ConfidenceRow["confidence"], string> = {
  S: "bg-purple-600 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-sky-600 text-white",
  C: "bg-zinc-400 text-white",
};

const VERDICT_LABEL: Record<string, string> = {
  ahead: "運では説明できない優位",
  behind: "有意にマイナス",
  inconclusive: "まだ運と区別できない",
};

const pct = (p: number | null | undefined, digits = 1) =>
  p == null ? "—" : `${(p * 100).toFixed(digits)}%`;

const units = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

function BucketTable({ title, buckets }: { title: string; buckets: Bucket[] }) {
  if (buckets.length === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">{title}</CardTitle>
        <p className="text-xs text-muted-foreground">
          全体の差が小さくても、1つの帯だけ崩れていることがある — それを見る表
        </p>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="py-1 font-normal">宣言帯</th>
              <th className="py-1 text-right font-normal">n</th>
              <th className="py-1 text-right font-normal">宣言</th>
              <th className="py-1 text-right font-normal">実績</th>
              <th className="py-1 text-right font-normal">差</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.lo} className="border-t">
                <td className="py-1">
                  {pct(b.lo, 0)}–{pct(b.hi, 0)}
                  {b.flag && (
                    <span
                      className={
                        b.flag === "overconfident"
                          ? "ml-2 text-xs text-red-600"
                          : "ml-2 text-xs text-amber-600"
                      }
                    >
                      ⚠ {b.flag === "overconfident" ? "過信" : "過小評価"}
                    </span>
                  )}
                </td>
                <td className="py-1 text-right">{b.n}</td>
                <td className="py-1 text-right">{pct(b.statedMean)}</td>
                <td className="py-1 text-right">{pct(b.actualRate)}</td>
                <td
                  className={`py-1 text-right ${
                    b.gap <= -0.1 ? "font-semibold text-red-600" : ""
                  }`}
                >
                  {b.gap >= 0 ? "+" : ""}
                  {(b.gap * 100).toFixed(1)}pt
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  );
}

export default function HandiEdgeReport() {
  const [league, setLeague] = useState<"mlb" | "npb">("mlb");
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  const apiBase = league === "npb" ? "/api/npb" : "/api";
  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    fetch(`${apiBase}/report`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((r) => !cancelled && setReport(r))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  const leagueToggle = (
    <div className="flex overflow-hidden rounded-md border">
      {(["mlb", "npb"] as const).map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => setLeague(l)}
          className={`px-3 py-1.5 text-xs font-semibold uppercase ${
            league === l
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:bg-muted"
          }`}
        >
          {l}
        </button>
      ))}
    </div>
  );

  if (error) {
    return (
      <div className="m-6 space-y-3">
        {leagueToggle}
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          読み込みエラー: {error}（APIサーバーは起動していますか?
          `pnpm --filter @workspace/api-server dev`）
        </p>
      </div>
    );
  }
  if (!report) {
    return <p className="m-6 text-sm text-muted-foreground">読み込み中…</p>;
  }

  const s = report.summary;
  const c = report.calibration;
  const profit = s.handicapProfitAssessment;
  const recentDays = [...s.perDate].reverse();

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">HandiEdge — 通算成績</h1>
          <p className="text-xs text-muted-foreground">
            {s.dates} 日間 / {s.gamesSettled} 試合精算 / {s.gamesPassed} 見送り
          </p>
        </div>
        {leagueToggle}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">勝敗（勝者）</p>
            <p className="text-lg font-bold">
              {s.winnerRecord.wins}-{s.winnerRecord.losses}
            </p>
            <p className="text-xs text-muted-foreground">{pct(s.winnerRate)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">ハンデ収支</p>
            <p
              className={`text-lg font-bold ${
                (s.handicapProfitTotal ?? 0) >= 0
                  ? "text-emerald-700"
                  : "text-red-700"
              }`}
            >
              {s.handicapProfitTotal == null
                ? "—"
                : `${units(s.handicapProfitTotal)}u`}
            </p>
            <p className="text-xs text-muted-foreground">
              ROI {pct(s.handicapRoi)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Brier（0.25=コイン投げ）</p>
            <p className="text-lg font-bold">{s.meanBrier ?? "—"}</p>
            <p className="text-xs text-muted-foreground">低いほど良い</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">トータル（O/U）</p>
            <p className="text-lg font-bold">
              {s.totalRecord.wins + s.totalRecord.losses === 0
                ? "—"
                : `${s.totalRecord.wins}-${s.totalRecord.losses}`}
            </p>
            <p className="text-xs text-muted-foreground">
              {s.totalRecord.wins + s.totalRecord.losses === 0
                ? "未清算（ライン入力なし）"
                : "清算済み"}
            </p>
          </CardContent>
        </Card>
      </div>

      {profit && (
        <p
          className={`rounded-md p-3 text-sm ${
            profit.verdict === "ahead"
              ? "bg-emerald-50 text-emerald-800"
              : profit.verdict === "behind"
                ? "bg-red-50 text-red-800"
                : "bg-amber-50 text-amber-800"
          }`}
        >
          有意性: 1ベットあたり {pct(profit.meanProfit)}（{profit.n} stakes, z ={" "}
          {profit.z}）— <strong>{VERDICT_LABEL[profit.verdict]}</strong>
        </p>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">信頼度別（Sは上ほど強いはず）</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {s.byConfidence.map((r) => (
            <div key={r.confidence} className="flex items-center gap-3 text-sm">
              <Badge className={CONF_STYLE[r.confidence]}>{r.confidence}</Badge>
              <span className="w-16">
                {r.wins}-{r.losses}
              </span>
              <span className="w-16 text-muted-foreground">{pct(r.rate)}</span>
              <span
                className={
                  r.profit >= 0 ? "text-emerald-700" : "text-red-700"
                }
              >
                {units(r.profit)}u / {r.staked} stakes
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      <BucketTable title="バンド別校正（ハンデ）" buckets={s.handicapBuckets} />
      <BucketTable title="バンド別校正（勝者）" buckets={s.winnerBuckets} />

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">学習済み shrink（core / tail / far）</CardTitle>
          <p className="text-xs text-muted-foreground">
            1.0 = シミュレータを全面信頼、0.5 = エッジ半減。tail は raw ≥ 65%、far
            は raw ≥ 70% の帯に適用。
          </p>
        </CardHeader>
        <CardContent className="text-sm">
          <p>
            マネーライン {c.shrink} / {c.tailShrink} / {c.farTailShrink}
          </p>
          <p>
            ハンデ {c.handicapShrink} / {c.handicapTailShrink} /{" "}
            {c.handicapFarTailShrink}
          </p>
          <p>
            トータル {c.totalShrink} / {c.totalTailShrink} /{" "}
            {c.totalFarTailShrink}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {c.gamesSettled} 試合から学習
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">日別履歴（新しい順）</CardTitle>
        </CardHeader>
        <CardContent>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-muted-foreground">
                <th className="py-1 font-normal">日付</th>
                <th className="py-1 text-right font-normal">勝敗</th>
                <th className="py-1 text-right font-normal">見送り</th>
                <th className="py-1 text-right font-normal">Brier</th>
              </tr>
            </thead>
            <tbody>
              {recentDays.map((d) => (
                <tr key={d.date} className="border-t">
                  <td className="py-1">{d.date}</td>
                  <td className="py-1 text-right">
                    {d.winnerRecord.wins}-{d.winnerRecord.losses}
                  </td>
                  <td className="py-1 text-right">{d.passed}</td>
                  <td className="py-1 text-right">{d.meanBrier ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
