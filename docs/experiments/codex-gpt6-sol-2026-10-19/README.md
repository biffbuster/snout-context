# GPT-6 Sol Codex pilot — Windows, 2026-10-19

This is an **exploratory internal pilot**, not a release claim. It used the uncommitted Snout 0.3.1 candidate on `claude/launch-cleanup` (`dirty: true`; bundle SHA-256 `7737bd3946b1cacedec87dbed39061aa70ae92217d3bec34e35dc6f15fd73457`). The 18 synthetic coding attempts were three repeats of `usersRead` (forced generated-file read), `orders` (natural generated-file path), and `cart` (no bulk-path control), each with Snout off and enforce. Arm order rotated by task and repeat. Every task passed in both arms, including its in-session test. Enforce made three generated-file denials and three trims; the runner estimated about 87,000 low-value tokens withheld.

The globally installed Codex CLI 0.153.4 rejected `gpt-6-sol` before a model turn with HTTP 400: `The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account.` An isolated Codex CLI 0.163.0 under `.snout/tooling/` ran this pilot successfully; the global installation was unchanged. Login was the existing ChatGPT plan, with no OpenAI API key and no API-billed calls. Its quota was consumed.

| Measure per successful attempt | Snout off | Snout enforce | Change and uncertainty |
| --- | ---: | ---: | ---: |
| Effective tokens (uncached input + 0.1 × cached input + output) | 23,687 | 17,797 | −24.9% (−38.0% to +3.1%) |
| GPT-6 Sol API-list-price equivalent | $0.0512 | $0.0401 | −21.6% (−33.6% to +3.6%) |
| Tasks solved | 9/9 | 9/9 | No observed regression; one-sided 95% quality lower bound −63.2 points |

Neither cost interval excludes zero: **savings are not established by this pilot**. For quality, a zero-width bootstrap over three all-pass tasks would be misleading. The reporter now applies a one-sided 95% exact zero-harm lower bound based on the three *unique* tasks: −63.2 percentage points. The predeclared −5-point no-quality-loss gate is **NOT MET**. These authored tasks are not representative enough for a product claim. The control task was slightly more expensive with Snout on, so the full mix matters.

| Task | Effective tokens off → on | API equivalent off → on | Interpretation |
| --- | ---: | ---: | --- |
| `usersRead` | 28,663 → 21,154 (−26.2%) | $0.06157 → $0.04731 (−23.2%) | Forced generated read; 3 trims |
| `orders` | 27,926 → 17,314 (−38.0%) | $0.05985 → $0.03977 (−33.6%) | Natural path; 3 denials, task recovered |
| `cart` | 14,473 → 14,924 (+3.1%) | $0.03211 → $0.03326 (+3.6%) | Control; no Snout intervention |

`run.json` is the saved raw result with only machine-specific fixture paths removed. `api-equivalent.json` adds `apiEquivalentUsd` to each row. The two report folders contain attempts CSV, summary JSON, and chart SVG. Rebuild from the repository root:

```bash
node bench/report.mjs docs/experiments/codex-gpt6-sol-2026-10-19/run.json --margin 5 --metric effTokens --out .snout/rebuild-codex-eff
node bench/price-codex.mjs docs/experiments/codex-gpt6-sol-2026-10-19/run.json --out .snout/rebuild-codex-priced.json
node bench/report.mjs .snout/rebuild-codex-priced.json --margin 5 --metric apiEquivalentUsd --out .snout/rebuild-codex-price
```

The [published GPT-6 Sol API rates](https://developers.openai.com/api/docs/models/gpt-6-sol) used here are $2 per million uncached input, $0.20 cached input, $2.50 cache-write input, and $10 output, for the short-context tier. Codex CLI did not separately identify cache-write tokens in these rows, so unreported writes are priced as ordinary uncached input. This is a **price-weighted token estimate**, not what the ChatGPT plan billed. An API-authenticated run is needed for actual dollar cost.

The next scored Codex run needs a clean, frozen 0.3.1 build, the same pinned CLI and model, more task-diverse repeats, and a held-out repository pilot. Do not append attempts from a changed bundle or harness to this result.
