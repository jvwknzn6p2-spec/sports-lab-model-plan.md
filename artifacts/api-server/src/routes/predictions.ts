/**
 * Read-only prediction endpoints, serving the exact files the daily
 * pipeline commits under lib/sports-data/data. No fabrication layer: what
 * predict locked is what this returns, byte-for-byte semantics.
 */

import { Router, type IRouter } from "express";
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  aggregateHistory,
  normalizeCalibration,
  type SettlementReport,
} from "@workspace/sports-data";
import { sportsDataDir, type League } from "../lib/data-dir";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The same three read-only endpoints for either league's store. Mounted at
 * the root for MLB (the historical paths keep their exact meaning) and
 * under /npb for NPB — each serves only its own committed record.
 */
export function predictionsRouter(league: League): IRouter {
  const router: IRouter = Router();

router.get("/predictions", async (_req, res, next) => {
  try {
    const dir = join(sportsDataDir(league), "predictions");
    const files = existsSync(dir) ? await readdir(dir) : [];
    const dates = files
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.slice(0, 10))
      .sort()
      .reverse();
    res.json({ dates });
  } catch (err) {
    next(err);
  }
});

router.get("/predictions/:date", async (req, res, next) => {
  try {
    const { date } = req.params;
    if (!DATE_RE.test(date)) {
      res.status(404).json({ error: `Not a date: ${date}` });
      return;
    }
    const path = join(sportsDataDir(league), "predictions", `${date}.json`);
    if (!existsSync(path)) {
      res.status(404).json({ error: `No prediction lock for ${date}` });
      return;
    }
    const lock = JSON.parse(await readFile(path, "utf8")) as {
      lockedAt: string;
      predictions: unknown[];
      controlTower?: { date?: string };
    };
    res.json({
      date,
      lockedAt: lock.lockedAt,
      // A lock is final once its own deadline passed; every stored lock is.
      final: true,
      predictions: lock.predictions,
    });
  } catch (err) {
    next(err);
  }
});

router.get("/report", async (_req, res, next) => {
  try {
    const dataDir = sportsDataDir(league);
    const historyPath = join(dataDir, "history.jsonl");
    const raw = existsSync(historyPath)
      ? await readFile(historyPath, "utf8")
      : "";
    const reports = raw
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as SettlementReport);
    const calibrationPath = join(dataDir, "calibration.json");
    const calibration = normalizeCalibration(
      existsSync(calibrationPath)
        ? JSON.parse(await readFile(calibrationPath, "utf8"))
        : {},
    );
    res.json({ summary: aggregateHistory(reports), calibration });
  } catch (err) {
    next(err);
  }
});

  return router;
}

export default predictionsRouter("mlb");
