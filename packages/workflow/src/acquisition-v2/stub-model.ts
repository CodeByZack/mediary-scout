import type {
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3Message,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  canonicalEpisodeFileName,
  cleanTitleForCanonicalName,
  episodeCodeFromFileName,
} from "../episode-code.js";

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;

/**
 * The deterministic-script acquisition model for the fake/dev adapter.
 *
 * 方案 A: instead of a no-op that reports no coverage, this stub DRIVES the same
 * sandbox tool-loop a real agent would — search (bare title) → transfer the
 * first candidate → inspect staging → canonical-rename every video → distribute
 * into the season derived from each file's SxxExx code → mark obtained →
 * discard staging → finish. Movie tasks take the shorter flattenMovie path. It
 * is a script, not a judge: no quality/language decisions, no multi-candidate
 * ranking, no dead-link iteration — it exists so dev/demo runs (and the fake
 * drive behind a real PanSou search) exercise the FULL pipeline end-to-end
 * (search → 转存 → 改名 → 入库 → 标记) without a real LLM.
 *
 * Everything the script needs is read from the model call's prompt: the target
 * title/kind come from the user message; the tool results (snapshot ids, staged
 * file trees, rename outcomes) come back as structured JSON in the tool
 * messages. The script keeps only its own distribution plan (fileId→newName
 * mapping) in closure state. Honest terminal paths: any step that fails
 * (no candidates / nothing landed / rename errors) reports no-coverage instead
 * of fabricating success — so a broken config still surfaces as a clean
 * no_coverage run, never a fake "obtained".
 *
 * Real acquisition requires AGENT_MODEL configuration
 * (MEDIA_TRACK_AGENT_ADAPTER=vercel-ai); the adapter policy still enforces that
 * whenever live 115 storage is in use.
 */

type Phase =
  | "search"
  | "transfer"
  | "inspect"
  | "rename"
  | "move"
  | "mark"
  | "discard"
  | "flatten"
  | "finish"
  | "report"
  | "done";

interface StubState {
  phase: Phase;
  movie: boolean;
  title: string;
  /** TV: the episode codes this task needs (from the user prompt's
   *  missingEpisodes). Empty (parse miss) → the script treats every staged
   *  video as wanted (degenerate). The script ONLY touches these codes, so
   *  out-of-scope extras in a pack are left in staging for discardStaging. */
  need: Set<string>;
  /** TV: fileId → canonical newName decided from inspectStaging. */
  renames: Array<{ fileId: string; newName: string }>;
  /** TV: episode codes derived from the canonical names. */
  codes: string[];
  step: number;
}

function toolCall(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV3GenerateResult {
  return {
    content: [
      {
        type: "tool-call",
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: "tool-calls", raw: "tool-calls" },
    usage: USAGE,
    warnings: [],
  };
}

function textResult(text: string): LanguageModelV3GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: USAGE,
    warnings: [],
  };
}

/** The last tool message's structured output, or undefined when none yet.
 *  AI SDK v6 wraps tool results as { type: "json", value } and may hand the
 *  value back as a JSON string — normalize both. */
function lastToolOutput(prompt: LanguageModelV3Message[]): unknown {
  for (let i = prompt.length - 1; i >= 0; i -= 1) {
    const message = prompt[i];
    if (message?.role !== "tool") {
      continue;
    }
    const part = message.content[0];
    if (part && "output" in part) {
      let output = part.output as unknown;
      if (
        typeof output === "object" &&
        output !== null &&
        "value" in output &&
        (output as { type?: unknown }).type === "json"
      ) {
        output = (output as { value: unknown }).value;
      }
      if (typeof output === "string") {
        try {
          return JSON.parse(output);
        } catch {
          return output;
        }
      }
      return output;
    }
  }
  return undefined;
}

/** Parse the task kind + target identity + TV need from the user message(s). */
function parseTask(
  prompt: LanguageModelV3Message[],
): { movie: boolean; title: string; year?: number; need: Set<string> } {
  const userText = prompt
    .filter((message) => message?.role === "user")
    .flatMap((message) =>
      message.role === "user"
        ? message.content.map((part) => (part.type === "text" ? part.text : ""))
        : [],
    )
    .join("\n");
  const movieMatch = /Acquire the movie "(.+?)" \((\d{4})\)/.exec(userText);
  if (movieMatch) {
    return { movie: true, title: cleanTitleForCanonicalName(movieMatch[1]!), year: Number(movieMatch[2]), need: new Set() };
  }
  const tvMatch = /Acquire the missing episodes for "(.+?)"/.exec(userText);
  const title = tvMatch ? cleanTitleForCanonicalName(tvMatch[1]!) : "Stub Title";
  // "Missing episodes (the coverage need — may span multiple seasons): S01E01, S01E02, ..."
  const need = new Set<string>();
  const needMatch = /Missing episodes[^\n]*:\s*([A-Za-z0-9, ]+)/.exec(userText);
  if (needMatch) {
    for (const token of needMatch[1]!.split(",")) {
      const code = episodeCodeFromFileName(token.trim());
      if (code !== null) {
        need.add(code);
      }
    }
  }
  return { movie: false, title, need };
}

/** Group the decided renames into one move per season (from the SxxExx code). */
function movesForRenames(renames: Array<{ fileId: string; newName: string }>): Array<{
  season: number;
  fileIds: string[];
}> {
  const bySeason = new Map<number, string[]>();
  for (const rename of renames) {
    const code = episodeCodeFromFileName(rename.newName);
    const season = code ? Number(code.slice(1, 3)) : 1;
    const fileIds = bySeason.get(season) ?? [];
    fileIds.push(rename.fileId);
    bySeason.set(season, fileIds);
  }
  return [...bySeason.entries()]
    .sort(([a], [b]) => a - b)
    .map(([season, fileIds]) => ({ season, fileIds }));
}

/** Shared first stage for both scripts: first call issues the bare-title search;
 *  a following call either moves on to transfer (snapshot with candidates) or
 *  honestly reports no-coverage — empty snapshot, or a failed/refused search
 *  (no snapshot at all). Without the failed-search case the stub would resend
 *  the same keyword every loop until the repetition stop burned the budget. */
function searchStep(state: StubState, last: unknown, id: string): LanguageModelV3GenerateResult {
  const snapshot = (last as { snapshot?: { id?: string; candidates?: Array<{ id?: string }> } })?.snapshot;
  if (snapshot === undefined) {
    if (last !== undefined) {
      state.phase = "report";
      return toolCall(id, "reportNoCoverage", { reason: "stub: search failed or was refused" });
    }
    // First call of the loop — nothing searched yet. Issue the bare-title
    // search now; the NEXT call (with the search result as `last`) decides.
    return toolCall(id, "searchResources", { keyword: state.title });
  }
  const candidates = snapshot.candidates ?? [];
  if (!snapshot.id || candidates.length === 0) {
    state.phase = "report";
    return toolCall(id, "reportNoCoverage", { reason: "stub: search returned no candidates" });
  }
  state.phase = "transfer";
  return toolCall(id, "transferCandidate", {
    snapshotId: snapshot.id,
    candidateId: candidates[0]!.id,
  });
}

/** Shared second stage for both scripts: the transfer must have landed files
 *  (the truth is the staging listing, not the status flag — a provider can mark
 *  an attempt failed yet materialize files); otherwise honest no-coverage. */
function transferStep(state: StubState, last: unknown, id: string): LanguageModelV3GenerateResult {
  const result = last as { error?: string; attempt?: { status?: string }; staging?: unknown[] };
  if (result?.error || result?.attempt?.status !== "succeeded" || !Array.isArray(result.staging) || result.staging.length === 0) {
    state.phase = "report";
    return toolCall(id, "reportNoCoverage", { reason: "stub: transfer landed nothing" });
  }
  state.phase = "inspect";
  return toolCall(id, "inspectStaging", {});
}

/** The staged video files from an inspectStaging result (shared by both scripts). */
function videosFromInspect(last: unknown): Array<{ id: string; path: string; isVideo?: boolean }> {
  return Array.isArray(last) ? (last as Array<{ id: string; path: string; isVideo?: boolean }>).filter((file) => file.isVideo) : [];
}

/** Advance the TV script one step based on the previous tool output. */
function nextTvStep(state: StubState, last: unknown): LanguageModelV3GenerateResult {
  const id = `stub_tc_${state.step}`;
  switch (state.phase) {
    case "search":
      return searchStep(state, last, id);
    case "transfer":
      return transferStep(state, last, id);
    case "inspect": {
      const videos = videosFromInspect(last);
      if (videos.length === 0) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: no video landed in staging" });
      }
      // Only the episodes this task needs get renamed/moved/marked; out-of-scope
      // extras in a pack (e.g. a fake 3-season dump for a 1-season task) stay in
      // staging and are wiped by discardStaging. When the need failed to parse,
      // fall back to every staged video (degenerate, but still deterministic).
      const wanted = state.need.size > 0 ? videos.filter((file) => state.need.has(episodeCodeFromFileName(file.path) ?? "")) : videos;
      if (wanted.length === 0) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: none of the needed episodes landed" });
      }
      state.renames = wanted.map((file) => ({
        fileId: file.id,
        newName: canonicalEpisodeFileName({
          title: state.title,
          episodeCode: episodeCodeFromFileName(file.path) ?? "S01E01",
          sourceName: file.path,
        }),
      }));
      state.codes = state.renames
        .map((rename) => episodeCodeFromFileName(rename.newName))
        .filter((code): code is string => code !== null);
      state.phase = "rename";
      return toolCall(id, "renameVideo", { renames: state.renames });
    }
    case "rename": {
      const result = last as { renamed?: string[]; errors?: unknown[] };
      if ((result?.errors?.length ?? 0) > 0 || (result?.renamed?.length ?? 0) === 0) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: rename failed" });
      }
      state.phase = "move";
      return toolCall(id, "moveToSeason", { moves: movesForRenames(state.renames) });
    }
    case "move": {
      // Honest termination: if the batch move failed (e.g. a file left staging,
      // SANDBOX_NO_SEASON_DIR), the files did NOT land in their season — marking
      // them obtained anyway would fabricate a succeeded run with nothing in the
      // library. Report no-coverage instead.
      if ((last as { error?: string } | undefined)?.error) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: moveToSeason failed" });
      }
      state.phase = "mark";
      return toolCall(id, "markObtained", { codes: state.codes });
    }
    case "mark": {
      state.phase = "discard";
      return toolCall(id, "discardStaging", {});
    }
    case "discard": {
      // Honest termination: a failed staging wipe leaves the run's leftovers in
      // place — not a coverage failure by itself, but the run cannot claim a
      // clean finish while its own staging is polluted, so report no-coverage.
      if ((last as { error?: string } | undefined)?.error) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: discardStaging failed" });
      }
      state.phase = "finish";
      return toolCall(id, "finish", {});
    }
    case "finish":
      state.phase = "done";
      return textResult("stub: full script complete");
    case "report":
    case "done":
    default:
      return textResult("stub: done");
  }
}

/** Advance the movie script one step. */
function nextMovieStep(state: StubState, last: unknown): LanguageModelV3GenerateResult {
  const id = `stub_tc_${state.step}`;
  switch (state.phase) {
    case "search":
      return searchStep(state, last, id);
    case "transfer":
      return transferStep(state, last, id);
    case "inspect": {
      const videos = videosFromInspect(last);
      if (videos.length === 0) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: no video landed in staging" });
      }
      state.phase = "flatten";
      return toolCall(id, "flattenMovie", {});
    }
    case "flatten": {
      // Honest termination: a failed flatten (SANDBOX_NOT_A_MOVIE / wrapper
      // cleanup failure) means the film was never extracted into the movie dir —
      // marking MOVIE obtained anyway would fabricate success.
      if ((last as { error?: string } | undefined)?.error) {
        state.phase = "report";
        return toolCall(id, "reportNoCoverage", { reason: "stub: flattenMovie failed" });
      }
      state.phase = "mark";
      return toolCall(id, "markObtained", { codes: ["MOVIE"] });
    }
    case "mark": {
      state.phase = "finish";
      return toolCall(id, "finish", {});
    }
    case "finish":
      state.phase = "done";
      return textResult("stub: movie script complete");
    case "report":
    case "done":
    default:
      return textResult("stub: done");
  }
}

/**
 * A deterministic acquisition agent: it executes the happy-path tool sequence
 * from the prompt's own evidence (never invents ids), and honestly reports
 * no-coverage when any step comes up empty. A dev/demo worker run therefore
 * completes with a REAL end-to-end result — search → 转存 → 改名 → 入库 → 标记 —
 * instead of an instant no_coverage, while still costing zero LLM calls.
 */
export function createStubAcquisitionModel(): LanguageModel {
  let state: StubState | null = null;
  return new MockLanguageModelV3({
    doGenerate: async (options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> => {
      const last = lastToolOutput(options.prompt);
      // New-run detection: a prompt with NO tool messages means a fresh
      // conversation. The worker's agentModelCache reuses ONE stub instance
      // across every fake-mode run in the process — without this reset, the
      // second run would see the previous run's finished state and silently
      // idle (0 tool calls, 0 marks, honest-looking no_coverage) or, worse,
      // inherit a half-finished run's renames/codes and fabricate obtained.
      // Rebuild the whole plan from the prompt whenever it carries no tool
      // history (first call of a run is exactly such a prompt).
      if (state === null || last === undefined) {
        const parsed = parseTask(options.prompt);
        state = {
          phase: "search",
          movie: parsed.movie,
          title: parsed.title,
          need: parsed.need,
          renames: [],
          codes: [],
          step: 0,
        };
      }
      state.step += 1;
      return state.movie ? nextMovieStep(state, last) : nextTvStep(state, last);
    },
  });
}
