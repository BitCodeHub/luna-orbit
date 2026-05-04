/**
 * Billing — plan tiers + usage caps.
 *
 * v0.4 ships the schema + the cap-enforcement logic. Real Stripe wiring
 * lands in v0.5 once the user has a Stripe account configured. For now
 * the "Upgrade" page is a CTA that emails support / the operator.
 */
import type { Database } from "better-sqlite3";
import type { WorkspaceRow } from "./users.js";

export type Plan = "free" | "pro" | "team" | "enterprise";

export interface PlanLimits {
  monthly_runs: number;          // -1 = unlimited
  parallel_runs: number;
  retention_days: number;        // how long run reports stay
  max_team_members: number;      // 1 = solo
  api_keys: number;              // -1 = unlimited
}

export const PLANS: Record<Plan, PlanLimits & { display_name: string; monthly_price_usd: number }> = {
  free:       { display_name: "Free",       monthly_price_usd: 0,    monthly_runs: 100,   parallel_runs: 1, retention_days: 7,  max_team_members: 1,  api_keys: 1 },
  pro:        { display_name: "Pro",        monthly_price_usd: 29,   monthly_runs: 2_500, parallel_runs: 3, retention_days: 90, max_team_members: 5,  api_keys: 10 },
  team:       { display_name: "Team",       monthly_price_usd: 99,   monthly_runs: 10_000, parallel_runs: 8, retention_days: 365, max_team_members: 25, api_keys: 50 },
  enterprise: { display_name: "Enterprise", monthly_price_usd: -1,   monthly_runs: -1,    parallel_runs: 32, retention_days: 365, max_team_members: -1, api_keys: -1 },
};

/** Roll the workspace's monthly-runs counter to the new period if needed, then return current usage. */
export function refreshUsage(db: Database, ws: WorkspaceRow): { used: number; limit: number } {
  const period = new Date(ws.usage_period_start);
  const now = new Date();
  const monthsElapsed = (now.getFullYear() - period.getFullYear()) * 12 + (now.getMonth() - period.getMonth());
  if (monthsElapsed >= 1) {
    db.prepare("UPDATE workspaces SET runs_used_this_month = 0, usage_period_start = ? WHERE id = ?").run(now.toISOString(), ws.id);
    ws.runs_used_this_month = 0;
    ws.usage_period_start = now.toISOString();
  }
  const limit = PLANS[ws.plan].monthly_runs;
  return { used: ws.runs_used_this_month, limit };
}

/** Throw if the workspace has hit its monthly cap. Caller should catch and 402. */
export function enforceRunQuota(db: Database, ws: WorkspaceRow): void {
  const { used, limit } = refreshUsage(db, ws);
  if (limit === -1) return;
  if (used >= limit) {
    throw new Error(`Plan limit reached: ${used}/${limit} runs this month on the ${PLANS[ws.plan].display_name} plan. Upgrade to keep running tests.`);
  }
}

/** Increment the runs_used counter — call when a run is queued (not when it finishes). */
export function bumpUsage(db: Database, workspaceId: string): void {
  db.prepare("UPDATE workspaces SET runs_used_this_month = runs_used_this_month + 1 WHERE id = ?").run(workspaceId);
}
