import { createServer } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let initialized = false;

/** Give a benchmark process its own gate server, even when the user's Snout is running. */
export async function isolateSnout(prefix) {
  if (initialized) return;
  const port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(address.port));
    });
  });
  process.env.SNOUT_PORT = String(port);
  process.env.SNOUT_CONFIG_DIR = mkdtempSync(join(tmpdir(), prefix));
  initialized = true;
}
