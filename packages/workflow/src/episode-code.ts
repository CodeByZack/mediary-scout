/**
 * The episode-identity contract between storage listings and workflow state:
 * a file is "visible" as an episode exactly when its FILE NAME alone exposes
 * an episode code. Path context (season folders) does not survive moves, so
 * anything the workflow lands in a canonical season directory must carry its
 * code in the name — see the rename step in staging normalization.
 */
export function episodeCodeFromFileName(name: string): string | null {
  // Episode allows up to 4 digits for 1000+ episode anime (One Piece/柯南/蜡笔小新);
  // \d{1,3} truncated "E1050" → "E105".
  const seasonEpisodeMatch = /[Ss](\d{1,2})[Ee](\d{1,4})/.exec(name);
  if (seasonEpisodeMatch?.[1] && seasonEpisodeMatch[2]) {
    return `S${seasonEpisodeMatch[1].padStart(2, "0")}E${seasonEpisodeMatch[2].padStart(2, "0")}`;
  }

  // Name-only heuristic: a bare "第N集" cannot reveal its season, so this
  // reading is only trustworthy for season 1. Files like these landing in
  // other seasons are exactly what the canonical rename step eliminates.
  const chineseEpisodeMatch = /第\s*(\d{1,4})\s*集/.exec(name);
  if (chineseEpisodeMatch?.[1]) {
    return `S01E${chineseEpisodeMatch[1].padStart(2, "0")}`;
  }

  return null;
}

/**
 * Canonical episode name `Title.SxxExx.ext` — the TV/anime staging-normalization
 * target (renameVideo). CONTRACT: `episodeCode` must be the FINAL code for the
 * file's target season — i.e. season-corrected (a `第N集` file landing in
 * `Season 03` must pass `S03E03`, NOT the `S01E03` that
 * `episodeCodeFromFileName` would read from the bare filename). The season
 * context lives only in the agent's judgment (inspectTargetDir), never in the
 * source filename, so the caller supplies the corrected code.
 */
export function canonicalEpisodeFileName(input: {
  title: string;
  episodeCode: string;
  sourceName: string;
}): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
  const extension = extensionMatch?.[0] ?? "";
  return `${input.title}.${input.episodeCode}${extension}`;
}

/**
 * Canonical movie name `Title (Year).ext` — the movie staging-normalization
 * target (flattenMovie auto-rename + the renameVideo movie-shape contract).
 * `year` may be a number or a pre-formatted string; the extension is carried
 * over from the source file so the film stays a playable video.
 */
export function canonicalMovieFileName(input: {
  title: string;
  year: number | string;
  sourceName: string;
}): string {
  const extensionMatch = /\.[A-Za-z0-9]+$/.exec(input.sourceName);
  const extension = extensionMatch?.[0] ?? "";
  return `${input.title} (${input.year})${extension}`;
}

/**
 * Strip a title clean enough to embed in a canonical filename:
 *  - episode-code-shaped substrings (`SxxExx`, `第N集`) — they would otherwise
 *    be mis-read by `episodeCodeFromFileName` when the canonical name is later
 *    parsed (a title containing `S01E01`-shaped noise makes the episode
 *    identity ambiguous);
 *  - filename-hostile characters `[\\/:*?"<>|]`;
 *  - leftover whitespace (folded to a single space + trimmed).
 * Pure function: provided for the skill examples and the future system-generated
 * naming mode; the renameVideo guard itself only rejects illegal characters
 * (§1.3 #7) — it does not require the newName prefix to equal the cleaned title.
 */
export function cleanTitleForCanonicalName(title: string): string {
  return title
    .replace(/[Ss]\d{1,2}[Ee]\d{1,4}/g, "")
    .replace(/第\s*\d{1,4}\s*集/g, "")
    .replace(/[\\/:*?"<>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
