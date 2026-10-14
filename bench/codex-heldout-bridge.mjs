#!/usr/bin/env node
/** Ask the trusted local supervisor to run Python tooling in the pinned task container. */
import { randomUUID } from "node:crypto";
import { existsSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const tool = process.argv[2];
const queue = process.env.SNOUT_HELDOUT_QUEUE;
if (!/^(python|python3|pytest)$/.test(tool ?? "") || !queue || !existsSync(queue)) {
  console.error("held-out bridge requires a supported tool and active local supervisor");
  process.exit(2);
}
const id = randomUUID();
const request = join(queue, `request-${id}.json`);
const response = join(queue, `response-${id}.json`);
const temp = `${request}.tmp`;
writeFileSync(temp, JSON.stringify({ tool, args: process.argv.slice(3) }));
renameSync(temp, request);
const deadline = Date.now() + 10 * 60_000;
while (!existsSync(response) && Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
if (!existsSync(response)) {
  console.error("held-out Docker test supervisor timed out");
  process.exit(124);
}
const result = JSON.parse(readFileSync(response, "utf8"));
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(Number.isInteger(result.status) ? result.status : 125);
