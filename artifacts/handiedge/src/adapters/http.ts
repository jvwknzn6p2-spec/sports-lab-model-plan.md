/**
 * Live HTTP IntakeSource. Fully functional: it fetches from a configured base
 * URL and validates every response against the same schemas the fixtures use.
 *
 * When real API access lands, the ONLY change needed is here — map each
 * provider's raw response into our schema inside the `map*` methods below (they
 * currently expect the endpoint to already return our shape). Business logic in
 * the stages never changes.
 */
import {
  controlTowerSchema,
  handicapSchema,
  resultsSchema,
  scheduleSchema,
  type ControlTower,
  type Handicap,
  type Results,
  type Schedule,
} from "../schemas.js";
import type { IntakeSource } from "./types.js";

export interface HttpSourceConfig {
  baseUrl: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

export class HttpSource implements IntakeSource {
  readonly kind = "http";
  constructor(private readonly config: HttpSourceConfig) {
    if (!config.baseUrl) throw new Error("HttpSource requires a baseUrl");
  }

  private async getJson(path: string): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 20000);
    try {
      const res = await fetch(`${this.config.baseUrl}${path}`, {
        headers: this.config.headers,
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${path}`);
      return await res.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  async loadSchedule(date: string): Promise<Schedule> {
    return scheduleSchema.parse(await this.getJson(`/schedule?date=${date}`));
  }
  async loadHandicap(date: string): Promise<Handicap> {
    return handicapSchema.parse(await this.getJson(`/handicap?date=${date}`));
  }
  async loadControlTower(runLabel: string): Promise<ControlTower> {
    return controlTowerSchema.parse(await this.getJson(`/control-tower?run=${runLabel}`));
  }
  async loadResults(date: string): Promise<Results> {
    return resultsSchema.parse(await this.getJson(`/results?date=${date}`));
  }
}
