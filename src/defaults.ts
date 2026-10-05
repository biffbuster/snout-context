/** Built-in defaults. Pure data, no Node imports. */
import type { Config } from "./config.js";

export const DEFAULTS: Config = {
  mode: "observe",
  sizeCapBytes: 200_000,
  // Kept deliberately short. Every entry here outranks all of our heuristics, including
  // the size cap, so a broad pattern is a way to silently un-classify large parts of a
  // repo. Test files are NOT listed: they are better judged on merit by the later tiers.
  alwaysAllow: ["README.md", "CLAUDE.md", "AGENTS.md"],
  // Only what the built-in rules do NOT already cover. Duplicating a rule here is how
  // two policies end up disagreeing: the list runs before the rules, so a list entry
  // silently overrides a rule's more nuanced verdict.
  alwaysDeny: ["**/*.lock"],
  // Credential FILES, not files that discuss credentials.
  //
  // Two substring patterns lived here and were wrong: one for "secret" and one for
  // "credential" anywhere in a path. They matched `src/secrets-manager.ts` and
  // `docs/secret-handling.md` — ordinary source and docs that a user then got prompted
  // about on every single read. Because the secret rule deliberately ignores mode, there
  // was no way to turn that off short of editing this list by hand.
  //
  // A name-substring heuristic cannot tell a key from an essay about keys. These patterns
  // name file shapes that hold credentials instead.
  redact: [
    "**/.env",
    "**/.env.*",
    "**/id_rsa*",
    "**/id_ed25519*",
    "**/id_ecdsa*",
    "**/*.pem",
    "**/*.p12",
    "**/*.pfx",
    "**/*.keystore",
    "**/*.jks",
    "**/.npmrc",
    "**/.netrc",
    "**/.pgpass",
    "**/.htpasswd",
    "**/credentials",
    "**/credentials.json",
    "**/service-account*.json",
    "**/.aws/**",
    "**/.ssh/**",
    "**/.gnupg/**",
  ],

  // Exceptions to the list above, checked first. `.env.example` is committed on purpose,
  // read constantly, and holds no secret. Treating it as one is pure friction.
  redactExempt: [
    "**/.env.example",
    "**/.env.sample",
    "**/.env.template",
    "**/.env.defaults",
    "**/.env.dist",
    "**/.env.schema",
    "**/.env.test.example",
  ],
};
