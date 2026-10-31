# Lessons you review

> **Where the rows are.** The repo keeps each gate set's frozen inputs (`prompts.json`, `history.json`, `freeze.json`) and its current baseline (`results-p3b.json`). The per-round result files named below, the reranker's files (removed in 0.3.3) and the paid and dry-run rows under `bench/ab-results/` are not in the repo. A rerun of a gate rebuilds its results from the frozen inputs.

The Gate 4 pilot ([result](memory-gates.md#result-2026-10-29-no-go-for-memory-as-it-shipped-for-both-agents))
found two problems with memory as it shipped. Claude Code was told about the records and never
searched them. Codex searched, but a session record was not what it needed. Lessons address both.
A lesson is a short line you approve. A short skill tells each agent when to search.

## The loop

1. **Session evidence:** An agent proposes a lesson (`snout_memory_propose`) only on one of three
   grounds:
   - a test run that passed in the session (`test`);
   - a decision you gave (`decision`), with your words quoted;
   - a correction you made that the work now meets (`correction`), with your words quoted.

   Each proposal carries its source session, the evidence, its date, the project and where it
   applies (`applies_when`).
2. **Checked against the record:** When the session's turn ends, Snout checks the proposal against
   that session's own record:
   - a `test` lesson needs a passing test run for the same command the proposal cites;
   - a `decision` lesson needs the quoted words to be in what you typed in that session;
   - a `correction` lesson needs your quoted words, and then a passing run or a commit.

   A proposal the record doesn't back stays unchecked and can't be approved.
3. **You review it:**

   | Command | What it does |
   | --- | --- |
   | `snout memory review` | Lists each proposal with every field and what the record showed. |
   | `snout memory approve <id> [--replaces <id>]` | Approves a proposal. With `--replaces`, it takes the place of an older lesson, which is kept as replaced. |
   | `snout memory reject <id> ["why"]` | Rejects a proposal. |
   | `snout memory edit <id> ["new text"] [--when "..."]` | Rewords a proposal or its conditions. It stays a proposal. |
   | `snout memory replace <id> "your text"` | Puts your own wording in place of an approved lesson. |
   | `snout memory review --all` | Also lists lessons you already approved, rejected or replaced. |

   Only these commands approve a lesson. An agent saying that you agreed doesn't approve anything.
4. **Approved project memory:** An approved lesson stays private to you, in this project.
5. **Recall:** When Claude Code or Codex searches, approved lessons come first, three at most. Each
   one is a single line that says where it applies and where it came from:

   ```
   - o_136c25b3f141  lesson  "Fuel sales for the supplier's portal export tab-separated, ..."  applies when: exporting fuel sales for the supplier's portal (berthbook export-fuel)  (a decision the user gave; session:claude-c7cd..., claude, 2026-10-30; approved 2026-10-30)
   ```

   `snout_memory_fetch` opens the lesson's evidence: your quoted words or the test run, and the
   source session's record. A search leaves out lessons that are:
   - still proposed, or rejected;
   - replaced by a newer lesson;
   - about a file that has changed since;
   - from another project;
   - matched on a single shared word.

Automatic notes stay off by default. With `snout memory notes on`, an approved lesson may also reach
an agent through the prompt hook when the current request appears to fit its applicability. This
opt-in path is still experimental: the frozen 40-prompt final preflight on 2026-10-30 delivered all
20 applicable lessons but incorrectly delivered a related lesson on four of 20 negative prompts in
both Claude Code and Codex. Keep it off for users until a new unseen safety check passes. Searching
for a lesson remains available regardless of the notes setting.

The failed frozen result is in `bench/ab-results/lesson-delivery-final-1793384542537.json`; the
dataset and freeze are `bench/lesson-delivery-final.json` and
`bench/lesson-delivery-final-freeze.json`. The four false deliveries were a warehouse lesson for a
label-print retry, a database rollback lesson for a CSS rollback, the same lesson for an analytics
column rename, and an indexer lesson for a UI event-order change. Each shares a topic word but not
the lesson's action or scope. The earlier 40-prompt development set passed after changes, but a
different fresh set also failed; neither is a substitute for a new held-out result after redesign.
The stand-in eight-slot handoff checked proposal, review, search and opt-in delivery wiring in both
directions. Its receivers followed scripted behavior, so it does not measure real-agent discovery,
task quality or savings. No paid agent run was made for this preflight.

A scope-word pairing experiment passed the two already-seen sets as development diagnostics, then
failed the newly frozen `bench/lesson-delivery-unseen8.json` on 2026-10-30. Both hook paths found all
20 answerable lessons but delivered a wrong or unrelated lesson on 14 prompts; seven of 20 negative
prompts stayed silent. The result is
`bench/ab-results/lesson-delivery-unseen8-1793385637353.json`. The trial matcher was rolled back;
the built product uses the prior rule, which still failed the earlier final set. This is a design
limit of automatic selection from a free-text applicability sentence: shared nouns cannot tell
whether the current action is the one the lesson covers. The next safety work should keep full
lesson text behind explicit search and test whether a short, cited discovery hint gets real agents
to search when earlier work matters. Do not treat the stand-in handoff or a seen-set diagnostic as
proof of reduced context, solved work or cost.

The billing handoff harness now excludes automatic notes from live runs. Its six-session default
compares reviewed-lesson search and fetch with memory off in both agent directions. The notes arm
is available only to stand-ins with `--experimental-notes`; a live attempt with that flag is
rejected. The corrected free stand-in result is
`bench/ab-results/handoff-dryrun-1793386077048.json`: evidence-backed proposals were reviewed,
and the MCP search/fetch probe found each approved lesson. The stand-ins themselves did not search
or see the session-start hint, so the harness reports neither direction as a successful real-agent
handoff. This is a wiring check, not a quality or cost result.

**The skill:** `skills/memory/SKILL.md` in the plugin, and `.agents/skills/snout-memory/SKILL.md`
from `snout init codex` (one text, kept the same by a test). In about 400 words, it says when to
search, when to skip memory, how to treat what comes back, and when a lesson may be proposed.

**Promoting lessons into a skill:** `snout memory promote <id>... --name <skill>` prints the files
it would write, `.claude/skills/<skill>/` and `.agents/skills/<skill>/`, and their full text. It
writes nothing until you run it again with `--yes <code>`. The code covers that exact content, so a
change to the lessons or the files after the preview needs a new preview. No MCP tool promotes
anything.

## Billing handoff, both directions (stand-in agents, 2026-10-29)

`node bench/lesson-handoff.mjs` runs the loop on the billing project (`bench/handoff/berthbook`). It
is free and offline. Stand-in agents drive Snout's real hooks, MCP server and CLI, in Claude Code's
transcript format and Codex's rollout format, and the project's tests run for real.

- The task comes from `spec-record.json`. The user gives finance's two export formats, and the
  giver adds the invoice export only. The receiver is later asked for the fuel export "in the format
  finance gave us", which is in no file.
- Lessons that must stay out are seeded first: an older, wrong lesson (replaced at review), one
  about a file that changed since, one from another project, one never approved, one rejected, one
  sharing a single word with the question, and an unrelated lesson that may appear only for its
  own topic.

| | Claude Code → Codex | Codex → Claude Code |
| --- | --- | --- |
| Giver's tests | 1 failed, 6 passed → 7 passed | 1 failed, 6 passed → 7 passed |
| Saved | 2 proposals: the portal format (decision, the user's words quoted) and a VAT column the user never asked for | the same |
| Checked | the format: the user's words found in the session; the VAT one: not found | the same |
| Review | the VAT one can't be approved and is rejected; the format is approved in place of the older lesson | the same |
| Receiver's session start | one line: 1 earlier session on record, how to search; nothing added to the prompt | the same |
| Found | search "fuel sales export supplier portal format": the approved lesson, first (259 tokens) | the same (255 tokens) |
| Opened | fetch: the user's words, the test run, the source session (404 tokens) | the same (400 tokens) |
| Kept out | all six | all six |
| Unrelated question | only its own lesson | only its own lesson |
| Used | format absent from the project before; present in the receiver's work | the same |
| Final tests | 9 passed (project, giver's hidden, receiver's hidden) | 9 passed |

The stand-ins search, apply the fix and play the reviewer by script, in the check's own throwaway
store. The check shows that the loop works through Snout's code in both agents' formats, and that
the wrong lessons stay out. It cannot show whether a real agent searches, trusts the lesson and uses
it. The test below does that.

## Next: the billing handoff, live

Snout's promise is to carry verified coding decisions across sessions and agents. The first live
test is one decision in a billing service (`bench/handoff/chargeline`, `spec-lesson.json`):

- **Monday.** The giver is asked to fix duplicate charges. The cause is that each retry makes a new
  idempotency key, so a try that timed out after the provider charged the card gets charged again.
  The rule its passing tests verify: retries reuse the original idempotency key.
- **Thursday.** The receiver, the other agent, is asked to add scheduled retries. Its prompt says
  nothing about keys. A hidden test fails if a scheduled retry charges a customer twice.

Each direction runs the giver, stops for your review (`--review`), then runs the receiver twice from
the same snapshot: once with Snout on (the approved lesson, search, fetch, propose and the skill) and
once with Snout off. The giver's prompt does not ask for a lesson. Whether it proposes one is part of
what the test shows.

**Free checks done (2026-10-30):** the grade check passes in both directions. The unchanged project
fails the giver's tests. The giver's reference passes them and fails only the receiver's. Both
references pass everything. A scheduled retry that uses a new key fails exactly the double-charge
test. A dry run with stand-in agents ran the whole path in both directions: proposed during the
session, backed by the record at Stop, approved at review, shown and opened by the receiver, then
solved.

**Live:** 6 sessions. Claude Code runs 3 on the API (the 2026-10-28 handoff sessions cost $0.04 to
$0.10 each), and Codex runs 3 on the plan. It needs your go, and a commit of `src/` and `dist/` so
the build is frozen.

## Then: related real PRs, memory on and off

If the live handoff works both ways, the next step is a pilot on 8 to 12 real PR tasks from one or
two repositories. Each task is a PR whose code depends on a decision an earlier PR in the set
verified. Both arms get the same issue text and the same code at the PR's base commit, and the PR's
own tests are withheld for grading. Lessons come from real giver sessions on the earlier PRs, and
you review them.

- **Headline:** cost per solved PR, memory on against off.
- **Beside it:** solve rate and total tokens, including memory calls.
- **Path:** for each task, whether the right lesson was shown, opened and used.
- **To scale:** agents use the right lesson consistently, solve as many PRs, and spend less. If so,
  the next step is a larger, time-rolled PR study with withheld tests and repeated attempts.
