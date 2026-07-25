/**
 * Adapter contract. All external data enters through an IntakeSource, so
 * switching from fixtures to live APIs later touches only this layer — the
 * stages consume validated domain objects and never know the source.
 */
import type { ControlTower, Handicap, Results, Schedule } from "../schemas.js";

export interface IntakeSource {
  readonly kind: string;
  loadSchedule(date: string): Promise<Schedule>;
  loadHandicap(date: string): Promise<Handicap>;
  loadControlTower(runLabel: string): Promise<ControlTower>;
  loadResults(date: string): Promise<Results>;
}
