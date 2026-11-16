// Writes benchmark handoff projects from a definitions module into bench/handoff/<project>/.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
const [defsFile, root] = process.argv.slice(2);
const { projects } = await import(pathToFileURL(defsFile).href);
const T = (imports, body) => `import { test } from "node:test";\nimport assert from "node:assert/strict";\n${imports}\n\n${body.trim()}\n`;
for (const p of projects) {
  const dir = join(root, p.name);
  if (existsSync(join(dir, "base")) && !process.env.OVERWRITE) throw new Error(`${p.name} exists`);
  const put = (rel, text) => { const f = join(dir, rel); mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, text.endsWith("\n") ? text : text + "\n"); };
  put("base/README.md", `# ${p.name}\n\n${p.readme}\n\n    npm test`);
  put("base/package.json", JSON.stringify({ name: p.name, private: true, type: "module", scripts: { test: "node --test" } }, null, 2));
  put(`base/src/${p.module}.js`, p.base);
  put(`base/test/${p.module}.test.js`, T(p.baseImports, p.baseTests));
  put("hidden/handoff-giver.test.js", T(p.baseImports, p.giverTest));
  put("hidden/handoff-receiver-task.test.js", T(p.step2Imports, p.taskTest));
  put("hidden/handoff-receiver-decision.test.js", T(p.step2Imports, p.decisionTest));
  put(`ref-giver/src/${p.module}.js`, p.refGiver);
  put(`ref-receiver/src/${p.step2}.js`, p.refReceiver);
  put(`ref-guess/src/${p.step2}.js`, p.refGuess);
  if (p.control) {
    put("hidden/control-task.test.js", T(p.control.imports, p.control.taskTest));
    put("hidden/control-scope.test.js", T(`import { existsSync, readdirSync, readFileSync } from "node:fs";`, `
const src = new URL("../src/", import.meta.url);

test("${p.control.leftAlone}", () => {
  assert.equal(existsSync(new URL("${p.step2}.js", src)), false);
  for (const f of readdirSync(src)) assert.doesNotMatch(readFileSync(new URL(f, src), "utf8"), /${p.control.scopePattern}/, f);
});`));
    put(`ref-control/src/${p.module}.js`, p.control.ref);
  }
  console.log("wrote", p.name);
}
