# Snout for teams: onboarding, organizations and CI

The plan for getting a team of coding-agent users from "heard of Snout" to "every developer and
every CI run is gated and reporting," in under ten minutes. Status column says what exists today.

## The path, end to end

| Step | Who | What happens | Status |
| --- | --- | --- | --- |
| 1. Install | each developer | `npm i -g usesnout`, or the Claude Code plugin. Works immediately, free, no account. | Done |
| 2. See the waste | each developer | `snout scan` grades the repo; `snout dashboard` shows savings live. The reason to go further. | Done |
| 3. Sign in | the lead | "Sign in with GitHub" on the web app. A personal workspace exists at once. | Done |
| 4. Create the organization | the lead | Guided setup, below. | Next |
| 5. Invite | the lead | Invite link, or add by GitHub username. Free up to 10 people; the Team plan past that. | Link done; usernames next |
| 6. Connect machines | each developer | `snout login`, pick the organization. Syncs daily totals after each session. | Done |
| 7. Connect CI | the lead | A workspace API key in CI; `snout ci` gates and reports agent runs. | Next |
| 8. Set guardrails | the lead | Budgets and alerts per team, project, agent or model. | Later |
| 9. Share rules | the team | A committed `.snout/team.json`, and org rules the CLI pulls. | Later |

## Organization setup (the guided flow)

One screen per step, each skippable, each with a visible "done" state. The dashboard is usable
after step 1.

1. **Name it.** Organization name; the lead becomes owner.
2. **Plan.** Free (up to 10 people, 90 days) or Team for larger teams ($8 per active developer per month). Stripe Checkout; the
   webhook flips `plan` and lifts the caps. Seats count developers who synced that month.
3. **Invite.** Paste GitHub usernames or share a link. Roles: owner (billing, keys, members),
   admin (members, rules), member (sees team totals, syncs).
4. **Connect.** Copyable commands per agent, with a live check that turns green when the first
   sync arrives:
   - Claude Code: plugin install, then `snout login`
   - Codex / Cursor / Gemini: `npx usesnout init codex` (etc.), then `snout login`
   - Orchestrators and subagents: nothing extra; subagent reads are attributed automatically
5. **Defaults.** Pick the mode for the org (observe first, enforce after a week), and whether the
   prompt coach is on. Written to `.snout/team.json` so a repo carries its own policy.
6. **First report.** After the first day of syncs: the org's first "what your agents read" view,
   and an email to the lead.

## CI and headless agents

Agents increasingly run in CI (Claude Code `-p`, `codex exec`, agent SDKs, PR bots). They need
the gate and the reporting without a browser login.

- **Workspace API keys.** Created by owners in the dashboard, scoped to one organization, named
  ("github-actions", "nightly-agent"), revocable, shown once, stored hashed. Same ingest endpoint
  as machine logins. Env var: `SNOUT_TOKEN`.
- **`snout ci`.** One step: installs the hooks for the agent in use, runs in enforce mode, and at
  the end syncs totals tagged with the CI run (provider, workflow, run id; never code or paths).
- **GitHub Action.** `uses: biffbuster/snout-context@v1` wrapping `snout ci`, with an optional
  PR comment: "this agent run read 1.2M tokens; Snout held back 310k (~$0.93)."
- **Budgets in CI.** Optional `--max-tokens` / `--max-usd`: the step warns, or fails, when an
  agent run exceeds its budget. The cheapest guardrail a team can adopt.

## What makes it efficient for agent teams

- **Zero-config attribution.** Every read is tagged with agent (Claude Code, Codex, Cursor,
  Gemini), subagent, model and person, so the org view splits cost without setup.
- **Redundancy across agents.** Snout already detects when two agents read the same file version;
  the team view surfaces it: "subagents re-read `schema.sql` 14 times this week."
- **Repo policy travels with the repo.** `.snout/team.json` means a new clone is configured.
- **Local-first.** Nothing about onboarding sends code anywhere; the cloud sees totals only.

## Build order

1. Stripe Checkout + webhook + customer portal (so step 2 of setup can take money).
2. Guided organization setup (steps 1–6) and roles.
3. Workspace API keys + `snout ci` + the GitHub Action.
4. `.snout/team.json` and org rules the CLI pulls.
5. Budgets and alerts.
