/**
 * The labelled dataset.
 *
 * Gold labels, and what they mean. `value` is the context value a careful engineer would
 * assign the file *for the stated goal*:
 *
 *   0  nothing usable   generated, vendored, built, binary, or a lockfile
 *   1  marginal         might mention something relevant; the task completes without it
 *   2  useful           bears on the goal but is not where the work happens
 *   3  essential        the goal cannot be met correctly without reading it
 *
 * `cls` is the single class we expect a rule-based classifier to assign, or `null` when no
 * deterministic rule should fire and the file must fall through to a semantic tier.
 *
 * LIMITATIONS, stated here rather than in a footnote:
 *   - One annotator. No adjudication, no inter-annotator agreement.
 *   - No held-out split. These cases informed the rules, so accuracy here is an upper
 *     bound and cannot be read as generalisation.
 *   - Synthetic content, realistic in shape rather than sampled from real repositories.
 *   - n is small: treat gaps under about 5 points
 *     as noise.
 *
 * The point of the set is regression and calibration, not a leaderboard claim.
 */
import { content as c } from "./fixtures.mjs";

/** goal: the developer's request the file is being judged against. */
const GOAL_WEB = "Session cookie is dropped on redirect after login. Fix it.";
const GOAL_GO = "The /orders endpoint returns 500 when the body is empty. Fix the handler.";
const GOAL_PY = "Add retry with backoff to the payments client.";
const GOAL_PHP = "Uploading a product image larger than 2 MB fails silently. Fix the upload handler.";

export const repos = {
  // ------------------------------------------------------------------ a Next.js-ish app
  web: {
    goal: GOAL_WEB,
    files: {
      // Output dirs only count as vendored when ignored; this is what makes dist/ and
      // coverage/ below machine-owned (see OUTPUT_DIRS in src/gate/rules.ts).
      ".gitignore": "node_modules\n.next\ndist/\ncoverage/\n",
      // Real false deny, found by bench/label.mjs against microsoft/vscode: committed build/
      // is hand-written tooling, and `build` was denied at any depth.
      "build/gulpfile.ts": c.ts(40),
      "src/middleware.ts": c.ts(50),
      "src/auth/session.ts": c.ts(60),
      "src/app/login/route.ts": c.ts(30),
      "src/components/Button.tsx": c.tsx(30),
      "src/lib/format.ts": c.ts(20),
      "README.md": c.md(5),
      "docs/architecture.md": c.md(30),
      "docs/secret-handling.md": c.md(10),
      "src/secrets-manager.ts": c.secretsModule(),
      "src/generated/api-client.ts": c.generatedTs(600),
      "src/db/schema-types.ts": c.prisma(300),
      "src/constants/columns.ts": c.handWrittenDoNotEdit(30),
      "src/debug/log.ts": c.handWrittenLintDisable(30),
      "package-lock.json": c.lock(400),
      "package.json": c.json(20),
      "tsconfig.json": c.json(10),
      "node_modules/react/index.js": c.ts(200),
      "node_modules/.package-lock.json": c.lock(100),
      ".next/static/chunks/main.js": c.minified(2000),
      "public/vendor.min.js": c.minified(3000),
      "public/app.js.map": c.sourcemap(),
      "src/__snapshots__/Button.test.tsx.snap": c.snapshot(200),
      "src/__fixtures__/users.json": c.json(200),
      "public/logo.png": c.binary(),
      "coverage/lcov-report/index.html": c.md(50),
      "data/exports/analytics-2026.csv": c.csv(20000),
      ".env": c.env(),
      ".env.example": c.envExample(),
      "certs/server.pem": c.pem(),
      "dist/bundle.js": c.minified(1500),
      // Real gap, found by bench/label.mjs against nodejs/node: `deps/` holds ~30
      // independent third-party projects (LIEF, openssl, v8, ...), the same convention
      // `vendor/` names elsewhere. Was missing from VENDOR_DIRS.
      "deps/LIEF/include/LIEF/hash.hpp": c.ts(80),
      // Real gap, found by bench/label.mjs against WordPress/WordPress: 384 lines of
      // unmodified GPLv2 boilerplate, not project-specific content.
      "license.txt": c.md(80),
    },
    labels: {
      "src/middleware.ts": { value: 3, cls: null },
      "build/gulpfile.ts": { value: 1, cls: null },
      "src/auth/session.ts": { value: 3, cls: null },
      "src/app/login/route.ts": { value: 3, cls: null },
      "src/components/Button.tsx": { value: 1, cls: null },
      "src/lib/format.ts": { value: 1, cls: null },
      "README.md": { value: 2, cls: "always-allow" },
      "docs/architecture.md": { value: 2, cls: null },
      "docs/secret-handling.md": { value: 1, cls: null },
      "src/secrets-manager.ts": { value: 1, cls: null },
      "src/generated/api-client.ts": { value: 0, cls: "generated" },
      "src/db/schema-types.ts": { value: 0, cls: "generated" },
      "src/constants/columns.ts": { value: 2, cls: null },
      "src/debug/log.ts": { value: 1, cls: null },
      "package-lock.json": { value: 0, cls: "lockfile" },
      "package.json": { value: 2, cls: null },
      "tsconfig.json": { value: 1, cls: null },
      "node_modules/react/index.js": { value: 0, cls: "vendored" },
      "node_modules/.package-lock.json": { value: 0, cls: "vendored" },
      ".next/static/chunks/main.js": { value: 0, cls: "vendored" },
      "public/vendor.min.js": { value: 0, cls: "minified" },
      "public/app.js.map": { value: 0, cls: "minified" },
      "src/__snapshots__/Button.test.tsx.snap": { value: 1, cls: "snapshot" },
      "src/__fixtures__/users.json": { value: 1, cls: "snapshot" },
      "public/logo.png": { value: 0, cls: "binary" },
      "coverage/lcov-report/index.html": { value: 0, cls: "vendored" },
      "data/exports/analytics-2026.csv": { value: 0, cls: "oversized" },
      ".env": { value: 0, cls: "secret" },
      ".env.example": { value: 1, cls: null },
      "certs/server.pem": { value: 0, cls: "secret" },
      "dist/bundle.js": { value: 0, cls: "vendored" },
      "deps/LIEF/include/LIEF/hash.hpp": { value: 0, cls: "vendored" },
      "license.txt": { value: 0, cls: "license" },
    },
  },

  // ------------------------------------------------------------------ a Go service
  go: {
    goal: GOAL_GO,
    files: {
      ".gitignore": "/target/\n",
      "internal/http/orders.go": c.go(60),
      "internal/http/middleware.go": c.go(30),
      "internal/orders/service.go": c.go(50),
      "internal/orders/validate.go": c.go(25),
      "cmd/server/main.go": c.go(20),
      "api/api.pb.go": c.generatedGo(400),
      "api/api_grpc.pb.go": c.generatedGo(300),
      "go.sum": c.lock(300),
      "go.mod": c.md(2),
      "vendor/github.com/gin-gonic/gin/gin.go": c.go(200),
      "bin/server": c.elf(),
      "testdata/orders_golden.json": c.json(300),
      "docs/api.md": c.md(25),
      "Makefile": c.md(3),
      "internal/orders/keys.go": c.handWrittenDoNotEdit(20),
      "deploy/id_rsa": c.pem(),
      "target/debug/build.log": c.md(100),
      // Real gap, found by bench/run.mjs against kubernetes/kubernetes: machine-generated
      // JSON carries no comment syntax, so the banner-sniffing `generated` rule can never
      // see it. Currently `cls: null` in the shipped rules — this case is expected to fail
      // until the rule gains a path-convention check for spec/schema directories.
      "api/openapi-spec/v3/apis__autoscaling__v2_openapi.json": c.generatedJsonNoBanner(150),
    },
    labels: {
      "internal/http/orders.go": { value: 3, cls: null },
      "internal/http/middleware.go": { value: 2, cls: null },
      "internal/orders/service.go": { value: 3, cls: null },
      "internal/orders/validate.go": { value: 3, cls: null },
      "cmd/server/main.go": { value: 1, cls: null },
      "api/api.pb.go": { value: 0, cls: "generated" },
      "api/api_grpc.pb.go": { value: 0, cls: "generated" },
      "go.sum": { value: 0, cls: "lockfile" },
      "go.mod": { value: 2, cls: null },
      "vendor/github.com/gin-gonic/gin/gin.go": { value: 0, cls: "vendored" },
      "bin/server": { value: 0, cls: "binary-content" },
      "testdata/orders_golden.json": { value: 1, cls: null },
      "docs/api.md": { value: 2, cls: null },
      Makefile: { value: 1, cls: null },
      "internal/orders/keys.go": { value: 1, cls: null },
      "deploy/id_rsa": { value: 0, cls: "secret" },
      "target/debug/build.log": { value: 0, cls: "vendored" },
      "api/openapi-spec/v3/apis__autoscaling__v2_openapi.json": { value: 0, cls: "generated" },
    },
  },

  // ------------------------------------------------------------------ a Python service
  py: {
    goal: GOAL_PY,
    files: {
      "payments/client.py": c.py(50),
      "payments/retry.py": c.py(20),
      "payments/__init__.py": c.py(2),
      "tests/test_client.py": c.py(40),
      "poetry.lock": c.lock(350),
      "pyproject.toml": c.md(4),
      ".venv/lib/python3.12/site-packages/requests/api.py": c.py(150),
      "payments/__pycache__/client.cpython-312.pyc": c.binary(),
      "docs/payments.md": c.md(20),
      "payments/proto/payments_pb2.py": c.generatedGo(250),
      "notebooks/analysis.ipynb": c.json(400),
      ".mypy_cache/3.12/payments/client.json": c.json(300),
      "fixtures/cassettes/payment_ok.yaml": c.md(80),
      "scripts/migrate.py": c.py(15),
      ".npmrc": "//registry.npmjs.org/:_authToken=npm_abc123\n",
    },
    labels: {
      "payments/client.py": { value: 3, cls: null },
      "payments/retry.py": { value: 3, cls: null },
      "payments/__init__.py": { value: 1, cls: null },
      "tests/test_client.py": { value: 2, cls: null },
      "poetry.lock": { value: 0, cls: "lockfile" },
      "pyproject.toml": { value: 2, cls: null },
      ".venv/lib/python3.12/site-packages/requests/api.py": { value: 0, cls: "vendored" },
      "payments/__pycache__/client.cpython-312.pyc": { value: 0, cls: "binary" },
      "docs/payments.md": { value: 2, cls: null },
      "payments/proto/payments_pb2.py": { value: 0, cls: "generated" },
      "notebooks/analysis.ipynb": { value: 1, cls: null },
      ".mypy_cache/3.12/payments/client.json": { value: 0, cls: "vendored" },
      "fixtures/cassettes/payment_ok.yaml": { value: 1, cls: "snapshot" },
      "scripts/migrate.py": { value: 1, cls: null },
      ".npmrc": { value: 0, cls: "secret" },
    },
  },

  // ------------------------------------------------------------------ a legacy PHP app
  // Added for one case: a third-party library bundled directly into the main tree, with
  // no `vendor/` directory and no generator banner. Found by bench/run.mjs against
  // WordPress/WordPress (wp-admin/includes/class-pclzip.php). Everything else here just
  // gives that file a realistic repo to sit in.
  php: {
    goal: GOAL_PHP,
    files: {
      "app/Upload/ImageHandler.php": c.php(50),
      "app/Upload/Validators.php": c.php(25),
      "README.md": c.md(5),
      "composer.lock": c.lock(200),
      "includes/class-pclzip.php": c.vendoredNoDirNoBanner(150),
    },
    labels: {
      "app/Upload/ImageHandler.php": { value: 3, cls: null },
      "app/Upload/Validators.php": { value: 2, cls: null },
      "README.md": { value: 2, cls: "always-allow" },
      "composer.lock": { value: 0, cls: "lockfile" },
      // Currently `cls: null` in the shipped rules — no directory-name or banner signal
      // exists for this shape, and this case is expected to fail until we decide whether
      // a heuristic is worth the false-deny risk it would carry (a policy call, not a bug).
      "includes/class-pclzip.php": { value: 0, cls: "vendored" },
    },
  },
};

/** Flat list of cases: one per (repo, file). */
export function cases() {
  const out = [];
  for (const [name, repo] of Object.entries(repos)) {
    for (const [rel, gold] of Object.entries(repo.labels)) {
      out.push({ repo: name, goal: repo.goal, path: rel, ...gold });
    }
  }
  return out;
}

/** Every class a rule may assign. Used for the macro-averaged multi-label table. */
export const CLASSES = [
  "secret", "always-allow", "binary", "binary-content", "lockfile", "vendored",
  "minified", "always-deny", "snapshot", "generated", "oversized", "crafted-path", "license",
];

/**
 * Every class the gold labels use must appear in CLASSES.
 *
 * `binary-content` was missing, and the effect was worse than a wrong number: the macro
 * table iterates over CLASSES, so a gold label naming a class outside that list was never
 * scored at all — neither as a hit nor as a miss. The case simply vanished from the
 * metric. A measurement that silently ignores a label is more dangerous than one that gets
 * it wrong, because nothing looks off.
 */
export function assertClassesCoverGold() {
  const unknown = new Set();
  for (const c of cases()) if (c.cls !== null && !CLASSES.includes(c.cls)) unknown.add(c.cls);
  if (unknown.size > 0) {
    throw new Error(
      `gold labels use classes missing from CLASSES: ${[...unknown].join(", ")}. ` +
        `They would be silently dropped from the multi-label table.`,
    );
  }
}
