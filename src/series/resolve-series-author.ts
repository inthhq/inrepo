import { runGitCapture } from "../git/run-git-capture.js";
import { DEFAULT_SERIES_AUTHOR } from "./series-git.js";
import type { SeriesAuthor } from "./series-git.js";

/**
 * Identity recorded in the `From:` header of generated patches.
 *
 * Patch headers are inrepo's provenance record, so a captured patch should name
 * the person who captured it. The host repository's git configuration is the
 * best available answer; {@link DEFAULT_SERIES_AUTHOR} is the fallback when git
 * has no identity configured.
 */
export const resolveSeriesAuthor = async function resolveSeriesAuthor(
  cwd: string
): Promise<SeriesAuthor> {
  const read = async (key: string): Promise<string> => {
    try {
      return await runGitCapture(["config", "--get", key], { cwd });
    } catch {
      return "";
    }
  };
  const [name, email] = await Promise.all([
    read("user.name"),
    read("user.email"),
  ]);
  return {
    email: email || DEFAULT_SERIES_AUTHOR.email,
    name: name || DEFAULT_SERIES_AUTHOR.name,
  };
};
