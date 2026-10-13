"""Claude Code with Snout, as a Harbor agent.

Harbor's own Claude Code integration, unchanged, plus two things: Snout (a packed build) and a pinned
Node are copied into the task container, and Snout's hooks go into Claude Code's per-run settings.
Snout runs in enforce mode and keeps its records in the trial's agent logs, never in the task's
folder. Everything else (model, effort, prompt, tools, limits) is whatever the plain `claude-code`
agent gets, so a run against it differs only by Snout.

    SNOUT_TGZ=<usesnout-x.y.z.tgz> SNOUT_NODE_TGZ=<node-v22-linux-x64.tar.gz> PYTHONPATH=<repo> \\
      harbor run -d terminal-bench/terminal-bench-2-1 \\
        -a bench.harbor.claude_code_snout:ClaudeCodeSnout -m anthropic/claude-sonnet-5-5 -k 5

SNOUT_TGZ comes from `npm pack` of the build under test, frozen for the whole run.
"""

import json
import os
import subprocess
from pathlib import Path

from harbor.agents.installed.claude_code import ClaudeCode

REPO = Path(__file__).resolve().parents[2]
PREFIX = "/opt/snout"
NODE = f"{PREFIX}/node/bin/node"
BIN = f"{PREFIX}/package/dist/snout.mjs"


def _required(name: str) -> str:
    value = os.environ.get(name)
    if not value or not Path(value).is_file():
        raise RuntimeError(f"{name} must name an existing file (see bench/harbor/claude_code_snout.py)")
    return value


class ClaudeCodeSnout(ClaudeCode):
    @staticmethod
    def name() -> str:
        return "claude-code-snout"

    @property
    def config_source(self):
        # Per-run settings are always passed: they carry Snout's hooks.
        source = super().config_source
        return {} if source is None else source

    def _load_base_settings(self):
        base = super()._load_base_settings()
        records = (self.environment_logs_dir / "snout").as_posix()
        snout = json.loads(
            subprocess.run(
                ["node", str(REPO / "bench/harbor/settings.mjs"), NODE, BIN, records],
                capture_output=True, text=True, check=True,
            ).stdout
        )
        hooks = dict(base.get("hooks", {}))
        for event, entries in snout["hooks"].items():
            hooks[event] = [*hooks.get(event, []), *entries]
        return {**base, "hooks": hooks, "env": {**base.get("env", {}), **snout["env"]}}

    async def install(self, environment) -> None:
        await super().install(environment)
        await environment.upload_file(_required("SNOUT_TGZ"), "/tmp/usesnout.tgz")
        await environment.upload_file(_required("SNOUT_NODE_TGZ"), "/tmp/snout-node.tgz")
        await self.exec_as_root(
            environment,
            command=(
                "set -e; "
                f"mkdir -p {PREFIX}/node; "
                f"tar -xzf /tmp/usesnout.tgz -C {PREFIX}; "
                f"tar -xzf /tmp/snout-node.tgz -C {PREFIX}/node --strip-components=1; "
                f"chmod -R a+rX {PREFIX}; "
                "rm -f /tmp/usesnout.tgz /tmp/snout-node.tgz; "
                f"{NODE} {BIN} help | head -1"
            ),
        )
