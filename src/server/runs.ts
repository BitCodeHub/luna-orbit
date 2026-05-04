/**
 * Run registry — tracks every test run the server kicks off.
 *
 * Storage model (intentionally simple for v0.1):
 *   <data-dir>/index.json                     ← list of all run records
 *   <data-dir>/runs/<run-id>/report.json      ← full per-run report
 *   <data-dir>/runs/<run-id>/report.html      ← rendered HTML
 *   <data-dir>/runs/<run-id>/screenshots/     ← per-step screenshots
 *   <data-dir>/runs/<run-id>/plan.md          ← snapshot of the plan that ran
 *
 * In-memory cache mirrors index.json so list/status are O(1). Persisted on
 * every status transition so a crash doesn't lose history.
 */
import { mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "errored";

export interface RunRecord {
  id: string;
  plan_name: string;
  plan_target: string;
  plan_platform: "web" | "mobile";
  status: RunStatus;
  passed?: boolean;
  intents_satisfied?: number;
  intents_total?: number;
  assertions_pass?: number;
  assertions_total?: number;
  duration_ms?: number;
  error?: string;
  queued_at: string;
  started_at?: string;
  finished_at?: string;
}

export class RunRegistry {
  private records = new Map<string, RunRecord>();
  private indexPath: string;
  private loaded = false;

  constructor(public readonly dataDir: string) {
    this.indexPath = join(dataDir, "index.json");
  }

  async init(): Promise<void> {
    if (this.loaded) return;
    await mkdir(join(this.dataDir, "runs"), { recursive: true });
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const list = JSON.parse(raw) as RunRecord[];
      for (const r of list) this.records.set(r.id, r);
    } catch {
      // No index yet — first run.
    }
    this.loaded = true;
  }

  newRunId(): string {
    return `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  runDir(id: string): string {
    return join(this.dataDir, "runs", id);
  }

  async create(rec: RunRecord): Promise<void> {
    this.records.set(rec.id, rec);
    await mkdir(this.runDir(rec.id), { recursive: true });
    await this.flush();
  }

  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | null> {
    const rec = this.records.get(id);
    if (!rec) return null;
    const next = { ...rec, ...patch };
    this.records.set(id, next);
    await this.flush();
    return next;
  }

  get(id: string): RunRecord | null { return this.records.get(id) ?? null; }

  list(opts: { limit?: number; status?: RunStatus } = {}): RunRecord[] {
    const all = [...this.records.values()].sort((a, b) => b.queued_at.localeCompare(a.queued_at));
    const filtered = opts.status ? all.filter((r) => r.status === opts.status) : all;
    return filtered.slice(0, opts.limit ?? 50);
  }

  async fileExists(path: string): Promise<boolean> {
    try { await stat(path); return true; } catch { return false; }
  }

  private async flush(): Promise<void> {
    const list = [...this.records.values()];
    await writeFile(this.indexPath, JSON.stringify(list, null, 2));
  }
}
