import { connection } from "next/server";
import { switcherItems, isRegisteredStorageProvider } from "@media-track/workflow";
import { getAccountConnectedStorages } from "../lib/workflow-runtime";
import { WorkspaceSwitcher } from "./workspace-switcher";

/**
 * Server loader for the drive switcher: fetches the account's connected drives
 * (sanitized — no cookie) and hands the computed tab list to the client switcher.
 * Renders nothing for 0–1 drives, so single-user/single-drive sees no chrome.
 *
 * `AppSidebar` renders this in some pages' STATIC shell, so a Suspense boundary
 * alone is NOT enough under cacheComponents — Next would prerender this at build
 * and the DB read crashes when there's no MEDIA_TRACK_SQLITE_PATH (e.g. `docker
 * build`). `await connection()` marks it dynamic so the read defers to request
 * time and the fallback (null) prerenders. Mirrors every other DB-reading server
 * component (ForeignWorkReview / ActivitySurface / show / settings / notifications).
 */
export async function WorkspaceSwitcherLoader() {
  await connection();
  const storages = (await getAccountConnectedStorages()).filter((storage) =>
    isRegisteredStorageProvider(storage.provider),
  );
  if (storages.length < 2) {
    return null;
  }
  // pathname is client-only; pass "/" here and let the client re-derive active.
  const tabs = switcherItems(
    storages.map((storage) => ({
      id: storage.id,
      label: storage.label,
      provider: storage.provider,
      providerUid: storage.providerUid,
      createdAt: storage.createdAt,
      status: storage.status,
    })),
    "/",
  ).map((item) => ({ id: item.id, href: item.href, label: item.label, frozen: item.frozen, provider: item.provider }));
  return <WorkspaceSwitcher tabs={tabs} />;
}
