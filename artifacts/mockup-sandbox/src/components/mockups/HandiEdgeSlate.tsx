/**
 * HandiEdge daily slate viewer — the first real screen over the read-only
 * prediction API (GET /api/predictions, /api/predictions/:date, /api/report).
 *
 * Renders exactly what the pipeline locked: picks, stated probabilities,
 * confidence badges, handicap/total markets, and the day's data-quality
 * flags. PASS games are shown greyed rather than hidden — an honest slate
 * includes what the model declined to bet.
 */

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface Prediction {
  gamePk: number;
  gameDate: string | null;
  home: string;
  away: string;
  pass: boolean;
  predictedWinner: string | null;
  winProbability: number;
  confidence: "S" | "A" | "B" | "C";
  expectedRuns?: { home: number; away: number };
  handicap?: {
    pick: string | null;
    coverProbability: number | null;
    ev: number | null;
    marketProbability?: number | null;
    recommendedStake?: number | null;
    noValue?: boolean;
  };
  total?: {
    line: number | null;
    predicted: number;
    pick: "OVER" | "UNDER" | null;
    probability: number | null;
  };
  reasons?: string[];
  flags?: string[];
}

interface ReportSummary {
  summary: {
    gamesSettled: number;
    winnerRecord: { wins: number; losses: number };
    winnerRate: number | null;
    handicapProfitTotal?: number | null;
    meanBrier: number | null;
  };
}

const CONF_STYLE: Record<Prediction["confidence"], string> = {
  S: "bg-purple-600 text-white",
  A: "bg-emerald-600 text-white",
  B: "bg-sky-600 text-white",
  C: "bg-zinc-400 text-white",
};

const pct = (p: number | null | undefined) =>
  p == null ? "—" : `${(p * 100).toFixed(1)}%`;

function GameCard({ p }: { p: Prediction }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className={p.pass ? "opacity-60" : ""}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base font-semibold">
            {p.away} @ {p.home}
          </CardTitle>
          <div className="flex items-center gap-2">
            {p.pass ? (
              <Badge variant="outline">PASS</Badge>
            ) : (
              <Badge className={CONF_STYLE[p.confidence]}>
                {p.confidence}
              </Badge>
            )}
          </div>
        </div>
        {p.gameDate && (
          <p className="text-xs text-muted-foreground">
            {new Date(p.gameDate).toLocaleString()}
          </p>
        )}
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            勝者:{" "}
            <strong>{p.pass ? "見送り" : (p.predictedWinner ?? "—")}</strong>{" "}
            <span className="text-muted-foreground">
              {pct(p.winProbability)}
            </span>
          </span>
          {p.expectedRuns && (
            <span className="text-muted-foreground">
              予想スコア {p.expectedRuns.away.toFixed(1)}–
              {p.expectedRuns.home.toFixed(1)}
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <span>
            ハンデ:{" "}
            {p.handicap?.pick ? (
              <>
                <strong>{p.handicap.pick}</strong>{" "}
                <span className="text-muted-foreground">
                  {pct(p.handicap.coverProbability)}
                  {p.handicap.ev != null &&
                    ` / EV ${(p.handicap.ev * 100).toFixed(1)}%`}
                  {p.handicap.marketProbability != null &&
                    ` / 市場 ${pct(p.handicap.marketProbability)}`}
                  {p.handicap.recommendedStake != null &&
                    ` / 推奨 ${p.handicap.recommendedStake}u`}
                </span>
              </>
            ) : p.handicap?.coverProbability != null ? (
              // A line was quoted and priced but the pick is withheld
              // (no-value price, C informational-only, or PASS). Showing
              // the price without the pick IS the point — hiding it as
              // 市場なし would misreport a real quote.
              <span className="text-muted-foreground">
                {p.handicap?.noValue ? "価値なし（見送り）" : "保留（賭けなし）"}
                {" — "}
                {pct(p.handicap.coverProbability)}
                {p.handicap.ev != null &&
                  ` / EV ${(p.handicap.ev * 100).toFixed(1)}%`}
                {p.handicap.marketProbability != null &&
                  ` / 市場 ${pct(p.handicap.marketProbability)}`}
              </span>
            ) : (
              <span className="text-muted-foreground">市場なし</span>
            )}
          </span>
          <span>
            トータル:{" "}
            {p.total?.pick && p.total.line != null ? (
              <>
                <strong>
                  {p.total.pick} {p.total.line}
                </strong>{" "}
                <span className="text-muted-foreground">
                  {pct(p.total.probability)}
                </span>
              </>
            ) : p.total?.line != null ? (
              <span className="text-muted-foreground">
                線 {p.total.line} / 予測 {p.total.predicted.toFixed(1)}
                （ピック保留）
              </span>
            ) : (
              <span className="text-muted-foreground">
                {p.total ? `予測 ${p.total.predicted.toFixed(1)}（線なし）` : "—"}
              </span>
            )}
          </span>
        </div>
        {(p.reasons?.length || p.flags?.length) && (
          <button
            type="button"
            className="text-xs text-sky-700 underline"
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "根拠を隠す" : "根拠を見る"}
          </button>
        )}
        {open && (
          <div className="space-y-1 rounded-md bg-muted p-2 text-xs">
            {p.reasons?.map((r) => <p key={r}>• {r}</p>)}
            {p.flags && p.flags.length > 0 && (
              <p className="text-muted-foreground">flags: {p.flags.join(", ")}</p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function HandiEdgeSlate() {
  const [league, setLeague] = useState<"mlb" | "npb">("mlb");
  const [dates, setDates] = useState<string[]>([]);
  const [date, setDate] = useState<string | null>(null);
  const [day, setDay] = useState<{
    lockedAt: string;
    predictions: Prediction[];
  } | null>(null);
  const [report, setReport] = useState<ReportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Each league is its own store server-side (/api vs /api/npb) — switching
  // resets everything and refetches; a cancelled flag keeps a slow response
  // from the previous league from landing on the new one's screen.
  const apiBase = league === "npb" ? "/api/npb" : "/api";
  useEffect(() => {
    let cancelled = false;
    setDates([]);
    setDate(null);
    setDay(null);
    setReport(null);
    setError(null);
    fetch(`${apiBase}/predictions`)
      .then((r) => r.json())
      .then((d: { dates: string[] }) => {
        if (cancelled) return;
        setDates(d.dates);
        setDate(d.dates[0] ?? null);
      })
      .catch((e) => !cancelled && setError(String(e)));
    fetch(`${apiBase}/report`)
      .then((r) => r.json())
      .then((r) => !cancelled && setReport(r))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiBase]);

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    setDay(null);
    fetch(`${apiBase}/predictions/${date}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((d) => !cancelled && setDay(d))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [apiBase, date]);

  const picks = day?.predictions.filter((p) => !p.pass) ?? [];
  const passes = day?.predictions.filter((p) => p.pass) ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">HandiEdge — 本日のスレート</h1>
          {report?.summary && (
            <p className="text-xs text-muted-foreground">
              通算 {report.summary.winnerRecord.wins}-
              {report.summary.winnerRecord.losses}（
              {pct(report.summary.winnerRate)}） / Brier{" "}
              {report.summary.meanBrier ?? "—"} /{" "}
              {report.summary.gamesSettled} 試合精算済み
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
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
          <Select value={date ?? undefined} onValueChange={setDate}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="日付" />
            </SelectTrigger>
            <SelectContent>
              {dates.map((d) => (
                <SelectItem key={d} value={d}>
                  {d}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {error && (
        <p className="rounded-md bg-red-50 p-3 text-sm text-red-700">
          読み込みエラー: {error}（APIサーバーは起動していますか?
          `pnpm --filter @workspace/api-server dev`）
        </p>
      )}

      {day && (
        <p className="text-xs text-muted-foreground">
          ロック時刻 {new Date(day.lockedAt).toLocaleString()} — ピック{" "}
          {picks.length} / 見送り {passes.length}
        </p>
      )}

      <div className="space-y-3">
        {picks.map((p) => (
          <GameCard key={p.gamePk} p={p} />
        ))}
        {passes.map((p) => (
          <GameCard key={p.gamePk} p={p} />
        ))}
      </div>
    </div>
  );
}
