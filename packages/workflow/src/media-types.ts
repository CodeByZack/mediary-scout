/**
 * The library's media shelves as a VALUE list. This module is deliberately
 * dependency-free and exported via the package subpath "@media-track/workflow/media-types":
 * client components (demo-session guards, `?type=` validation) need the runtime
 * whitelist, but importing it from the package ROOT would drag dist/index.js —
 * node:sqlite included — into the browser bundle (Turbopack build error; CI
 * build:web proves it). Keep it zero-import. The MediaType union lives in
 * domain.js; this list is its single runtime mirror — add a shelf in BOTH places
 * and every consumer guard follows.
 */
export const MEDIA_TYPES = ["movie", "tv", "anime", "variety"] as const;
