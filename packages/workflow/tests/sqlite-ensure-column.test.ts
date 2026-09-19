import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createSqliteWorkflowRepository } from "../src/sqlite.js";

/**
 * The schema has no migration runner (one-shot final shape), so a NEW column on an
 * EXISTING table is added by SqliteWorkflowRepository.ensureColumn at open time
 * (PRAGMA table_info + ADD COLUMN, idempotent). First user of the mechanism is
 * connected_storages.variety_cid — this locks the upgrade path: a pre-variety
 * database must open cleanly, gain the column, keep its rows, and round-trip the
 * new value through the write path.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** connected_storages exactly as it shipped before variety_cid existed. */
function legacyDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "ms-migrate-"));
  dirs.push(dir);
  const path = join(dir, "store.db");
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE connected_storages (\n  id text PRIMARY KEY,\n  account_id text NOT NULL,\n  provider text NOT NULL,\n  provider_uid text NOT NULL,\n  label text,\n  payload text NOT NULL,\n  root_cid text,\n  movies_cid text,\n  tv_cid text,\n  anime_cid text,\n  status text NOT NULL DEFAULT 'active',\n  frozen_reason text,\n  frozen_at text,\n  created_at text NOT NULL,\n  UNIQUE (provider, provider_uid)\n);");
  db.exec("INSERT INTO connected_storages\n  (id, account_id, provider, provider_uid, label, payload, root_cid, movies_cid, tv_cid, anime_cid, created_at)\n  VALUES ('cs_legacy', 'acct_default', 'quark', 'uid1', '旧盘', '{}', 'r1', 'm1', 't1', 'a1', '2026-01-01T00:00:00.000Z')");
  db.close();
  return path;
}

function columnNames(path: string): string[] {
  const db = new DatabaseSync(path);
  try {
    return (db.prepare("PRAGMA table_info(connected_storages)").all() as Array<{ name: string }>).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
}

describe("SqliteWorkflowRepository ensureColumn (upgrade of an existing DB)", () => {
  it("adds the missing variety_cid column on open", () => {
    const path = legacyDbPath();
    expect(columnNames(path)).not.toContain("variety_cid");
    const repo = createSqliteWorkflowRepository({ path });
    try {
      expect(columnNames(path)).toContain("variety_cid");
    } finally {
      repo.close();
    }
  });

  it("is idempotent and preserves the legacy row (variety_cid NULL until provisioned)", async () => {
    const path = legacyDbPath();
    createSqliteWorkflowRepository({ path }).close(); // first open: adds the column
    const repo = createSqliteWorkflowRepository({ path }); // second open: must not throw
    try {
      const row = await repo.findConnectedStorageByUid("quark", "uid1");
      expect(row).not.toBeNull();
      expect(row!.id).toBe("cs_legacy");
      expect(row!.animeCid).toBe("a1");
      expect(row!.varietyCid).toBeNull();
    } finally {
      repo.close();
    }
  });

  it("round-trips the new column through the upsert", async () => {
    const path = legacyDbPath();
    const repo = createSqliteWorkflowRepository({ path });
    try {
      await repo.upsertConnectedStorage({
        id: "cs_legacy",
        accountId: "acct_default",
        provider: "quark",
        providerUid: "uid1",
        label: "旧盘",
        payload: { cookie: "x" },
        rootCid: "r1",
        moviesCid: "m1",
        tvCid: "t1",
        animeCid: "a1",
        varietyCid: "v1",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      expect((await repo.findConnectedStorageByUid("quark", "uid1"))!.varietyCid).toBe("v1");
    } finally {
      repo.close();
    }
  });
});
