import { drizzle } from "drizzle-orm/d1";
import { audits } from "./schema";

interface AuditLogEntry {
  userId: number;
  auditGroupId: string;
  collectionName: string;
  variablesCount: number;
  violationsCount: number;
  inputTokens: number;
  outputTokens: number;
  violationsJson: string;
}

/** Best-effort audit logging — never throws. */
export async function logAudit(db: D1Database, entry: AuditLogEntry): Promise<void> {
  try {
    const orm = drizzle(db);
    await orm.insert(audits).values({
      userId: entry.userId,
      auditGroupId: entry.auditGroupId,
      collectionName: entry.collectionName,
      collectionsCount: 1,
      variablesCount: entry.variablesCount,
      violationsCount: entry.violationsCount,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      violationsJson: entry.violationsJson,
    });
  } catch {
    // Best-effort — don't break the response
  }
}
