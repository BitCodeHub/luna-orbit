/**
 * Run registry — multi-tenant, SQLite-backed.
 *
 * v0.4 change: every run is owned by a workspace. The runs table holds
 * the indexable columns (id, workspace_id, status, queued_at) plus a JSON
 * blob of the full RunRecord. Per-run files (screenshots, report.html,
 * report.json, plan.md) still live on disk under <data-dir>/runs/<id>/.
 */
import type { Database } from "better-sqlite3";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type RunStatus = "queued" | "running" | "passed" | "failed" | "errored";

export interface RunRecord {
  id: string;
  workspace_id: string;
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
  constructor(public readonly dataDir: string, private db: Database) {}

  async init(): Promise<void> {
    await mkdir(join(this.dataDir, "runs"), { recursive: true });
  }

  newRunId(): string {
    return `run_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  }

  runDir(id: string): string {
    return join(this.dataDir, "runs", id);
  }

  async create(rec: RunRecord): Promise<void> {
    await mkdir(this.runDir(rec.id), { recursive: true });
    this.db.prepare("INSERT INTO runs (id, workspace_id, data, status, queued_at) VALUES (?, ?, ?, ?, ?)")
      .run(rec.id, rec.workspace_id, JSON.stringify(rec), rec.status, rec.queued_at);
  }

  async update(id: string, patch: Partial<RunRecord>): Promise<RunRecord | null> {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.db.prepare("UPDATE runs SET data = ?, status = ? WHERE id = ?")
      .run(JSON.stringify(next), next.status, id);
    return next;
  }

  get(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RunRecord : null;
  }

  /** Get a run, but only if it belongs to the given workspace (for auth scoping). */
  getForWorkspace(id: string, workspaceId: string): RunRecord | null {
    const row = this.db.prepare("SELECT data FROM runs WHERE id = ? AND workspace_id = ?").get(id, workspaceId) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as RunRecord : null;
  }

  list(opts: { workspaceId: string; limit?: number; status?: RunStatus }): RunRecord[] {
    const limit = opts.limit ?? 50;
    const rows = opts.status
      ? this.db.prepare("SELECT data FROM runs WHERE workspace_id = ? AND status = ? ORDER BY queued_at DESC LIMIT ?").all(opts.workspaceId, opts.status, limit)
      : this.db.prepare("SELECT data FROM runs WHERE workspace_id = ? ORDER BY queued_at DESC LIMIT ?").all(opts.workspaceId, limit);
    return (rows as Array<{ data: string }>).map((r) => JSON.parse(r.data) as RunRecord);
  }

  async fileExists(path: string): Promise<boolean> {
    try { await stat(path); return true; } catch { return false; }
  }

  /** Total runs in the workspace (for usage display). */
  countAllTime(workspaceId: string): number {
    const r = this.db.prepare("SELECT COUNT(*) as n FROM runs WHERE workspace_id = ?").get(workspaceId) as { n: number };
    return r.n;
  }
}
