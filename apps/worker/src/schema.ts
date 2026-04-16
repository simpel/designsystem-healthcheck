import { sqliteTable, integer, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

export const users = sqliteTable("users", {
  id: integer().primaryKey({ autoIncrement: true }),
  figmaUserId: text("figma_user_id").notNull().unique(),
  figmaUserName: text("figma_user_name").notNull(),
  token: text().notNull().unique(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
});

export const audits = sqliteTable(
  "audits",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id),
    timestamp: text()
      .notNull()
      .default(sql`(datetime('now'))`),
    collectionsCount: integer("collections_count").notNull().default(0),
    variablesCount: integer("variables_count").notNull().default(0),
    violationsCount: integer("violations_count").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    violationsJson: text("violations_json").notNull().default("[]"),
    auditGroupId: text("audit_group_id"),
    collectionName: text("collection_name"),
  },
  (table) => [index("idx_audits_user_id").on(table.userId)]
);
