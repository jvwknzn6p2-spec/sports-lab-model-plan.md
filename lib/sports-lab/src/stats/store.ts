import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { GameStatBundle } from "./types";

/**
 * On-disk cache for assembled per-game stat bundles, mirroring
 * {@link DailyScheduleStore}. Keyed by `gamePk` so a day's games can be
 * assembled once and re-read for free. Validates on read and write so a
 * corrupted cache fails loudly instead of feeding bad data into the model.
 *
 * Layout under `rootDir`:  stats/<gamePk>.json
 */
export class GameStatsStore {
  readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = rootDir;
  }

  pathFor(gamePk: number): string {
    return join(this.rootDir, "stats", `${gamePk}.json`);
  }

  has(gamePk: number): boolean {
    return existsSync(this.pathFor(gamePk));
  }

  async save(bundle: GameStatBundle): Promise<string> {
    const validated = GameStatBundle.parse(bundle);
    const path = this.pathFor(validated.gamePk);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    return path;
  }

  async load(gamePk: number): Promise<GameStatBundle | null> {
    const path = this.pathFor(gamePk);
    if (!existsSync(path)) return null;
    const contents = await readFile(path, "utf8");
    return GameStatBundle.parse(JSON.parse(contents));
  }
}
