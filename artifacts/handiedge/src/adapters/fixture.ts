/** Fixture-backed IntakeSource — reads recorded JSON from the fixtures dir. */
import { fixturePath } from "../config.js";
import { readValidated } from "../util/io.js";
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

export class FixtureSource implements IntakeSource {
  readonly kind = "fixture";
  constructor(private readonly baseDir: string = fixturePath()) {}

  private path(name: string): string {
    return `${this.baseDir}/${name}`;
  }

  async loadSchedule(date: string): Promise<Schedule> {
    return readValidated(this.path(`schedule_${date}.json`), scheduleSchema);
  }
  async loadHandicap(date: string): Promise<Handicap> {
    return readValidated(this.path(`handicap_${date}.json`), handicapSchema);
  }
  async loadControlTower(runLabel: string): Promise<ControlTower> {
    // A single control_tower.json steers every run; runLabel selects nothing
    // here but is threaded through for the HTTP adapter and audit trail.
    void runLabel;
    return readValidated(this.path("control_tower.json"), controlTowerSchema);
  }
  async loadResults(date: string): Promise<Results> {
    return readValidated(this.path(`results_${date}.json`), resultsSchema);
  }
}
