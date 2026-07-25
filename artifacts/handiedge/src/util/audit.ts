/**
 * Append-only audit log. Every stage records what it consumed and produced
 * (by content hash) so a run can be reconstructed and verified after the fact.
 */
import { appendJsonl } from "./io.js";
import { sha256 } from "./hash.js";

export interface AuditEvent {
  ts: string;
  stage: string;
  event: string;
  detail?: Record<string, unknown>;
  inputHash?: string;
  outputHash?: string;
}

export class AuditLogger {
  constructor(
    private readonly path: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  log(event: Omit<AuditEvent, "ts">): void {
    const record: AuditEvent = { ts: this.clock().toISOString(), ...event };
    appendJsonl(this.path, record);
  }

  stage(stage: string, input: unknown, output: unknown, detail?: Record<string, unknown>): void {
    this.log({
      stage,
      event: "completed",
      detail,
      inputHash: sha256(input),
      outputHash: sha256(output),
    });
  }

  error(stage: string, message: string, detail?: Record<string, unknown>): void {
    this.log({ stage, event: "error", detail: { message, ...detail } });
  }
}
