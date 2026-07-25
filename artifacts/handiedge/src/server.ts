/**
 * HandiEdge HTTP API — a thin wrapper over the same pipeline the CLI uses.
 *
 *   GET  /healthz            → liveness
 *   POST /predict {date}     → run predictions, return the locked slate
 *   POST /settle  {date}     → grade + analyze + self-learn, return the report
 *
 * The API and CLI share one code path (pipeline.ts); neither owns business logic.
 */
import express, { type Express, type Request, type Response } from "express";
import { runPredict, runSettle } from "./pipeline.js";

export function createApp(): Express {
  const app = express();
  app.use(express.json());

  app.get("/healthz", (_req: Request, res: Response) => {
    res.json({ status: "ok", service: "handiedge" });
  });

  app.post("/predict", async (req: Request, res: Response) => {
    const date = String(req.body?.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "body.date must be YYYY-MM-DD" });
      return;
    }
    try {
      const lock = await runPredict(date);
      res.json(lock);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/settle", async (req: Request, res: Response) => {
    const date = String(req.body?.date ?? "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({ error: "body.date must be YYYY-MM-DD" });
      return;
    }
    try {
      const result = await runSettle(date);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  return app;
}

// Entry point when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8080);
  createApp().listen(port, () => {
    console.log(`HandiEdge API listening on :${port}`);
  });
}
