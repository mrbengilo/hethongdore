import schedulingSql from "../drizzle/0001_shift_scheduling.sql?raw";

export const schedulingStatements = schedulingSql.split("--> statement-breakpoint").map((sql) => sql.trim()).filter(Boolean);
export async function initScheduling(db: D1Database) {
  await db.batch(schedulingStatements.map((sql) => db.prepare(sql)));
}
