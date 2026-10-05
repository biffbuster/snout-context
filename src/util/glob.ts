/**
 * Minimal glob matching for the config path lists.
 *
 * Supports `**`, `*`, `?` and character classes. It deliberately does NOT implement
 * full gitignore semantics (negation, directory-only `/` suffixes, nested ignore files).
 * Patterns are matched against a POSIX-style path relative to the project root.
 *
 * The limitation is documented in docs/configuration.md rather than hidden: a user who
 * needs exact gitignore behaviour should list paths explicitly.
 */

const cache = new Map<string, RegExp>();

export function toRegExp(pattern: string): RegExp {
  const hit = cache.get(pattern);
  if (hit) return hit;

  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` may match zero directories, so the slash is part of the optional group.
        if (pattern[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "[") {
      const end = pattern.indexOf("]", i);
      if (end === -1) {
        re += "\\[";
      } else {
        re += pattern.slice(i, end + 1);
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    }
  }

  const compiled = new RegExp(`^${re}$`);
  cache.set(pattern, compiled);
  return compiled;
}

export function matchesAny(relPath: string, patterns: readonly string[]): string | null {
  const p = relPath.replace(/\\/g, "/").replace(/^\.\//, "");
  for (const pattern of patterns) {
    if (toRegExp(pattern).test(p)) return pattern;
    // A bare directory name like "node_modules" should also match anything beneath it.
    if (!pattern.includes("/") && !pattern.includes("*")) {
      if (p === pattern || p.startsWith(pattern + "/") || p.includes("/" + pattern + "/")) {
        return pattern;
      }
    }
  }
  return null;
}
