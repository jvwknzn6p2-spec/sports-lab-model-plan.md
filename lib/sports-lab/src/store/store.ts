/**
 * On-disk store. Plain JSON files under `dataDir`, one per day:
 *
 *   predictions/YYYY-MM-DD.json   what we predicted, including the input snapshot
 *   results/YYYY-MM-DD.json       what actually happened
 *   graded/YYYY-MM-DD.json        predictions scored against results
 *   analysis/YYYY-MM-DD.json      an analysis run's output
 *   reports/YYYY-MM-DD.{txt,html} the human-readable daily report
 *   calibration.json              the learned parameters (the loop's memory)
 *   cache/                        raw API responses with fetch timestamps
 *
 * Files, not Postgres, on purpose: the daily volume is a few hundred kilobytes,
 * the whole history stays greppable and diffable, and the pipeline runs with no
 * provisioning. `lib/db` is where this moves if it ever needs to be queried by
 * an API server.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type {
  AnalysisReport,
  Calibration,
  DailyPredictions,
  GameDate,
  GameResult,
  GradedGame,
} from "../core/types";
import { assertGameDate } from "../core/dates";
import { DEFAULT_CALIBRATION } from "../loop/calibration";

export interface GradedDay {
  date: GameDate;
  gradedAt: string;
  games: GradedGame[];
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT") return null;
    throw new Error(
      `Failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Write via a temp file and rename, so an interrupted run cannot truncate. */
async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tmp, file);
}

export class Store {
  constructor(private readonly dataDir: string) {}

  private file(...parts: string[]): string {
    return path.join(this.dataDir, ...parts);
  }

  // --- predictions ----------------------------------------------------------

  async savePredictions(predictions: DailyPredictions): Promise<string> {
    const file = this.file("predictions", `${assertGameDate(predictions.date)}.json`);
    await writeJson(file, predictions);
    return file;
  }

  async loadPredictions(date: GameDate): Promise<DailyPredictions | null> {
    return readJson<DailyPredictions>(this.file("predictions", `${assertGameDate(date)}.json`));
  }

  // --- results --------------------------------------------------------------

  async saveResults(date: GameDate, results: GameResult[]): Promise<string> {
    const file = this.file("results", `${assertGameDate(date)}.json`);
    await writeJson(file, { date, savedAt: new Date().toISOString(), results });
    return file;
  }

  async loadResults(date: GameDate): Promise<GameResult[] | null> {
    const payload = await readJson<{ results?: GameResult[] }>(
      this.file("results", `${assertGameDate(date)}.json`),
    );
    return payload?.results ?? null;
  }

  // --- graded ---------------------------------------------------------------

  async saveGraded(day: GradedDay): Promise<string> {
    const file = this.file("graded", `${assertGameDate(day.date)}.json`);
    await writeJson(file, day);
    return file;
  }

  async loadGraded(date: GameDate): Promise<GradedDay | null> {
    return readJson<GradedDay>(this.file("graded", `${assertGameDate(date)}.json`));
  }

  /** Every date with a graded file, ascending. */
  async gradedDates(): Promise<GameDate[]> {
    return this.datesIn("graded");
  }

  async predictionDates(): Promise<GameDate[]> {
    return this.datesIn("predictions");
  }

  private async datesIn(dir: string): Promise<GameDate[]> {
    try {
      const entries = await fs.readdir(this.file(dir));
      return entries
        .filter((name) => name.endsWith(".json"))
        .map((name) => name.slice(0, -5))
        .filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name))
        .sort();
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
  }

  // --- analysis -------------------------------------------------------------

  async saveAnalysis(report: AnalysisReport): Promise<string> {
    const file = this.file("analysis", `${report.from}_to_${report.to}.json`);
    await writeJson(file, report);
    return file;
  }

  // --- calibration ----------------------------------------------------------

  /** Never throws: a missing or unreadable file falls back to the defaults. */
  async loadCalibration(): Promise<Calibration> {
    const loaded = await readJson<Calibration>(this.file("calibration.json"));
    if (!loaded) return DEFAULT_CALIBRATION;
    // Merge so a file written by an older version still works.
    return {
      ...DEFAULT_CALIBRATION,
      ...loaded,
      moneyline: { ...DEFAULT_CALIBRATION.moneyline, ...loaded.moneyline },
      totals: { ...DEFAULT_CALIBRATION.totals, ...loaded.totals },
      confidenceThresholds: {
        ...DEFAULT_CALIBRATION.confidenceThresholds,
        ...loaded.confidenceThresholds,
      },
    };
  }

  async saveCalibration(calibration: Calibration): Promise<string> {
    const file = this.file("calibration.json");
    await writeJson(file, calibration);
    return file;
  }

  // --- reports --------------------------------------------------------------

  async saveReport(date: GameDate, extension: "txt" | "html", content: string): Promise<string> {
    const file = this.file("reports", `${assertGameDate(date)}.${extension}`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return file;
  }
}
