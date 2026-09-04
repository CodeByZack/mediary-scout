import type { LanguageModel } from "ai";
import type { AgentDecision, AuditEvent, ResourceSnapshot, TransferAttempt } from "../domain.js";
import type { ResourceProvider, StorageExecutor } from "../ports.js";
import type { AgentToolEvent } from "./activity.js";
import { CandidateRegistry } from "./candidate-registry.js";
import type { DeadLinkStore } from "./dead-links.js";
import { RealResourceProviderV2 } from "./real-provider-adapter.js";
import { RealStorageV2 } from "./real-storage-adapter.js";
import { TaskSandbox } from "./sandbox.js";
import { getStorageBrand } from "../storage-brands.js";
import { AssrtSubtitleProvider, type AssrtProviderPort } from "../subtitle-provider.js";
import type { SearchProfile } from "./search-profile.js";
import { needForMovie, needForTvTarget, type MovieTarget, type TvAnimeTarget } from "./target-types.js";
import { runFastPathAcquisition } from "../consumption/fast-path/tv.js";
import type { EpisodeParseRules } from "../episode-code.js";
import type { PromptOverrideLookup } from "../ruleset.js";
import { runMovieFastPathAcquisition } from "../consumption/fast-path/movie.js";

/**
 * Phase 6 — the composition root. Given the real provider + executor, a model,
 * a target, and the already-resolved scoped handles, it wires the registry +
 * both real adapters + the task sandbox (with the coverage need) and runs the
 * matching strong task agent's loop. This is the inner orchestration; the outer
 * workflow still owns resolving the handles (show/staging/season dirs) from the
 * media DB and persisting the trace.
 */
export type AcquisitionV2Target =
  | ({ kind: "tv" } & TvAnimeTarget)
  | ({ kind: "movie" } & MovieTarget);

export interface RunAcquisitionV2Request {
  provider: ResourceProvider;
  executor: StorageExecutor;
  model: LanguageModel;
  workflowRunId: string;
  target: AcquisitionV2Target;
  /** The scoped staging dir (under the show dir / storage parent — NEVER inside the Season dir). */
  stagingDirectoryId: string;
  /** TV: season number -> scoped Season directory. A multi-season pack's files are
   *  distributed across these; supply one entry per season the task covers. */
  targetSeasonDirectoryIds?: Record<number, string>;
  /** Movie: the single scoped movie directory this task may write into. */
  targetMovieDirectoryId?: string;
  searchBudget?: number;
  maxSteps?: number;
  preferredLanguage?: string;
  /** TMDB origin_country of the title — when it includes CN the movie prompt skips
   *  the 中文 subtitle floor (国产片 natively Chinese-spoken). */
  originCountries?: string[];
  /** This title's per-media-type PanSou keyword recipe, injected into the prompt. */
  searchHints?: string;
  /** Rendered quality-preference guidance (召回后选片优先级), injected into the prompt. */
  qualityGuidance?: string;
  /** The task's fine-grained search profile — enables the anime taboo-keyword
   *  validator (warnings only, never blocking). 病2b。 */
  searchProfile?: SearchProfile;
  /** The run's drive brand — selects the brand transfer model + dead-links section. */
  storageProvider?: string;
  /** Filters known-dead candidates from search results before the agent sees them,
   *  and records newly-proven-dead links from failed transfers (#15). */
  deadLinkStore?: DeadLinkStore;
  /** assrt token (Settings → 字幕来源). When set AND origin is non-CN AND the
   *  drive is 115, the orchestrator pre-warms a subtitle snapshot and the agent
   *  gets viewSubtitleSnapshot/transferSubtitle tools. Undefined/empty = no
   *  subtitle flow (the agent never sees those tools). */
  assrtToken?: string;
  /** Injectable assrt provider (tests pass a spy). When absent, the orchestrator
   *  builds a real AssrtSubtitleProvider from assrtToken. */
  assrtProvider?: AssrtProviderPort;
  /** Per-tool-call live progress for the activity page (best-effort). */
  onProgress?: (event: AgentToolEvent) => void;
  /** issue #44: 可配置集数解析规则(UI 编辑后经 pipeline 注入)。缺省 = 内置正则。 */
  episodeRules?: EpisodeParseRules;
  /** issue #44 Phase 2: AI 仲裁 prompt 覆盖表(kind → body)。缺省 = 内置模板。 */
  promptOverrides?: PromptOverrideLookup;
}

/** The persistable trace of a V2 run, in the same shape the old serial path
 *  produced — so the workflow records snapshots/decisions/attempts unchanged. */
export interface AcquisitionV2Outcome {
  resourceSnapshots: ResourceSnapshot[];
  decisions: AgentDecision[];
  transferAttempts: TransferAttempt[];
}

/** Result shape from the fast path — mirrors the old AcquisitionAgentResult + adds outcome/audit. */
export interface RunAcquisitionV2Result {
  /** The model's final free text (after it stopped calling tools). */
  text: string;
  /** Number of loop steps the model took. */
  steps: number;
  /** Final honest coverage picture, read from the sandbox after the run. */
  coverage: { coverageMet: boolean; obtained: string[]; missing: string[]; subtitleFallback: boolean };
  outcome: AcquisitionV2Outcome;
  auditEvents: AuditEvent[];
}

export async function runAcquisitionV2(request: RunAcquisitionV2Request): Promise<RunAcquisitionV2Result> {
  // Every task's first log line names the drive it writes to — covers fast-path,
  // agent loop, and interrogation with ONE marker at the composition root.
  let providerLabel = request.storageProvider ?? "unknown";
  try {
    providerLabel = getStorageBrand(providerLabel).label;
  } catch {
    // unknown brand string — keep the raw id.
  }
  console.log(
    `[mediary-run][${request.workflowRunId}] ${request.target.title} | 网盘: ${providerLabel} (${request.storageProvider ?? "unknown"})`,
  );
  const registry = new CandidateRegistry();
  const provider = new RealResourceProviderV2({
    provider: request.provider,
    registry,
    workflowRunId: request.workflowRunId,
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
  });
  const storage = new RealStorageV2({
    executor: request.executor,
    registry,
    workflowRunId: request.workflowRunId,
    ...(request.deadLinkStore ? { deadLinkStore: request.deadLinkStore } : {}),
  });
  const need = request.target.kind === "tv" ? needForTvTarget(request.target) : needForMovie();
  const sandbox = new TaskSandbox({
    provider,
    storage,
    workflowRunId: request.workflowRunId,
    // Movie-only 中文字幕软兜底: 8+2 budget + last-resort raw landing (the prompt's
    // soft floor authorizes it). TV/anime omit it → hard floor + hard 8-budget.
    ...(request.target.kind === "movie" ? { subtitleFallback: true } : {}),
    stagingDirectoryId: request.stagingDirectoryId,
    ...(request.targetSeasonDirectoryIds === undefined
      ? {}
      : { targetSeasonDirectoryIds: request.targetSeasonDirectoryIds }),
    ...(request.targetMovieDirectoryId === undefined
      ? {}
      : { targetMovieDirectoryId: request.targetMovieDirectoryId }),
    need,
    // The agent's search keywords must reference the title — reject genre/year-only
    // fallbacks ("2026 电影") at the tool boundary so they never burn a search.
    titleTerms: [request.target.title, ...request.target.aliases],
    // Canonical rename context: TV/anime titles drive renameVideo's TV-shape guard
    // + the skill's naming examples; movies additionally carry the year so
    // flattenMovie auto-renames the film + subtitles to `Title (Year).ext`.
    canonicalTitle: request.target.title,
    ...(request.target.kind === "movie" ? { canonicalYear: request.target.year } : {}),
    ...(request.searchBudget === undefined ? {} : { searchBudget: request.searchBudget }),
    ...(request.searchProfile === undefined ? {} : { searchProfile: request.searchProfile }),
  });

  // Pre-warm the raw snapshot (bare title) BEFORE dispatch — the fast path grades
  // this snapshot (zero-LLM), so a pre-warm is not a prompt pointer anymore, it
  // IS the acquisition evidence. If the provider fails (network error, etc.),
  // gracefully degrade: the fast path reports 暂无资源 rather than crashing.
  try {
    const rawKeyword = request.target.title; // bare title (中文名), no quality/subtitle/year
    await sandbox.primeRawSnapshot(rawKeyword);
  } catch (error) {
    // Provider unavailable → no pre-warm; the fast path reports no snapshot.
    // Do NOT crash the workflow.
  }

  // Pre-warm the assrt subtitle snapshot when all three gates pass: token
  // configured, KNOWN non-CN origin, and the EXECUTOR can land external
  // subtitle urls. UNKNOWN origin (undefined/empty originCountries — missing
  // TMDB metadata) counts as NOT eligible: niche 国产短剧 are precisely the
  // titles most likely to lack origin metadata, while mainstream foreign
  // titles essentially always carry it — and a false positive here recurs on
  // EVERY patrol tick, burning the shared assrt quota (20/min) and confusing
  // the agent with subtitle tools on a natively-Chinese title. Requiring known
  // non-CN loses almost nothing and matches the UI copy (仅对非国产内容生效).
  // The third gate is a CAPABILITY probe (transferSubtitleUrl presence), not a
  // brand string — the day the 光鸭/夸克 executor implements the method,
  // subtitles light up there automatically, and the gate can never disagree
  // with what the executor can actually do (today only 115 implements it).
  // Soft-fail: a flaky assrt / empty search sets an empty snapshot, never
  // blocks the video task. When the gates don't pass, the subtitle tools are
  // simply not registered (the agent never knows subtitles were an option).
  const origins = request.originCountries ?? [];
  const subtitleActive =
    request.assrtToken !== undefined &&
    request.assrtToken.trim() !== "" &&
    origins.length > 0 &&
    origins.every((c) => c !== "CN") &&
    typeof request.executor.transferSubtitleUrl === "function";
  if (subtitleActive) {
    const subtitleProvider: AssrtProviderPort =
      request.assrtProvider ?? new AssrtSubtitleProvider({ token: request.assrtToken! });
    try {
      // Pre-warm the assrt snapshot so the fast path's subtitle stage can read
      // it later without an extra assrt hit.
      await sandbox.primeSubtitleSnapshot(request.target.title, subtitleProvider);
    } catch {
      // assrt unavailable → empty snapshot; the fast-path subtitle stage will
      // re-prime on its own (soft-fail), never blocking the video task.
    }
  }

  const isChineseNative = origins.includes("CN");
  // The movie route is FULLY fast-path now (zero-LLM acquisition, including
  // subtitles). A foreign film with a 中文 subtitle preference USED to escalate
  // to the LLM movie agent for assrt 选包 + 软兜底; that agent loop is real but
  // expensive — it burned a full model loop + up to 8+2 searches even when the
  // drive had NO subtitle capability at all (夸克 executor lacks
  // transferSubtitleUrl — the tools never even registered). The deterministic
  // subtitle picker (subtitle-picker.ts) approximates the selection policy in
  // code: language-preference match > ★ vote > 口碑组 > freshness.
  const prefersChineseSubtitles = (request.preferredLanguage ?? "").includes("中");

  const result =
    request.target.kind === "tv"
      ? await runFastPathAcquisition({
          sandbox,
          model: request.model,
          target: stripKind(request.target),
          isChineseNative,
          ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
          // Task D: fast-path steps are traced through the SAME onProgress the
          // agent path uses — the runner wires it to the progress + agent-trace
          // sinks, so the activity page shows fast-path steps in agent_steps.
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
          ...(request.episodeRules === undefined ? {} : { episodeRules: request.episodeRules }),
          ...(request.promptOverrides === undefined ? {} : { promptOverrides: request.promptOverrides }),
        })
      : await runMovieFastPathAcquisition({
          sandbox,
          model: request.model,
          target: stripKind(request.target),
          ...(request.storageProvider === undefined ? {} : { storageProvider: request.storageProvider }),
          ...(request.onProgress ? { onProgress: request.onProgress } : {}),
          ...(request.promptOverrides === undefined ? {} : { promptOverrides: request.promptOverrides }),
          // Subtitle stage gates: NON-CN title (isChineseNative false) AND the
          // subtitle flow is actually active (assrt token + executor capability).
          // Pass the assrt provider + language preference down so the fast path's
          // POST-LANDING stage can prime/read/pick/land subtitles itself —
          // deterministically, no LLM.
          ...(!isChineseNative && subtitleActive
            ? {
                subtitle: {
                  provider: request.assrtProvider ?? new AssrtSubtitleProvider({ token: request.assrtToken! }),
                  preferredLanguage: request.preferredLanguage ?? "",
                },
              }
            : {}),
        });

  // The agent transferred candidates by id; the storage adapter recorded the
  // domain attempts and the provider adapter the domain snapshots. Assemble the
  // same AcquisitionOutcome shape the old serial path persisted. No episode
  // mapping (§1.13): the decision records what was selected/observed, not a
  // fileId↔episode map.
  const transferAttempts = storage.attempts();
  const resourceSnapshots = provider.snapshots();
  const decisions = buildAgentDecisions({
    transferAttempts,
    resourceSnapshots,
    coverageMet: result.coverage.coverageMet,
    // The finish terminal stop ends the loop AT the finish step, so a SUCCESSFUL
    // run has no closing free-text turn — fall back to the honest coverage summary
    // for that case. Other mechanical stops (systemic block / no-coverage) also
    // leave text empty; their reasons already persist elsewhere (each attempt's
    // providerMessage / the reportNoCoverage reason), so they keep the pre-existing
    // empty-reason behavior here.
    reason:
      result.text ||
      (result.coverage.coverageMet
        ? `已完成:obtained=${result.coverage.obtained.join(",") || "-"}(finish 终结即停)`
        : result.text),
  });
  return { ...result, outcome: { resourceSnapshots, decisions, transferAttempts }, auditEvents: sandbox.auditTrail() };
}

/**
 * Assemble the persistable AgentDecision[] from the run's transfers + observed
 * snapshots. The agent may search SEVERAL times and transfer a candidate from a
 * LATER snapshot; persist validation (repository.ts) requires each decision's
 * selected candidates to belong to THAT decision's snapshot — so we group the
 * selected candidates by their REAL snapshot and emit one decision per snapshot.
 * (Tagging a single decision with resourceSnapshots[0] failed live e2e when the
 * agent transferred from a non-first search.)
 */
export function buildAgentDecisions(input: {
  transferAttempts: TransferAttempt[];
  resourceSnapshots: ResourceSnapshot[];
  coverageMet: boolean;
  reason: string;
}): AgentDecision[] {
  const snapshotByCandidate = new Map<string, string>();
  for (const snapshot of input.resourceSnapshots) {
    for (const candidate of snapshot.candidates) {
      snapshotByCandidate.set(candidate.id, snapshot.id);
    }
  }
  const selectedBySnapshot = new Map<string, string[]>();
  for (const candidateId of new Set(input.transferAttempts.map((attempt) => attempt.candidateId))) {
    const snapshotId = snapshotByCandidate.get(candidateId);
    if (snapshotId === undefined) continue; // unknown candidate — the transferAttempts validation catches it
    const selected = selectedBySnapshot.get(snapshotId) ?? [];
    selected.push(candidateId);
    selectedBySnapshot.set(snapshotId, selected);
  }
  return [...selectedBySnapshot.entries()].map(([snapshotId, selectedCandidateIds]) => ({
    node: "acquisition_v2_sandbox_agent",
    snapshotId,
    selectedCandidateIds,
    episodeMapping: {},
    providerAheadEpisodeMapping: {},
    rejectedCandidateIds: [],
    confidence: input.coverageMet ? "high" : "low",
    reason: input.reason.slice(0, 2000),
  }));
}

function stripKind<T extends { kind: unknown }>(target: T): Omit<T, "kind"> {
  const { kind: _kind, ...rest } = target;
  return rest;
}
