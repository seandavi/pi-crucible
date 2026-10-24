// Factory: spec (Opus) → implement (Sonnet) → review lenses (Opus, parallel)
// → revise ≤ maxRounds (Sonnet) → PR (Sonnet). See docs/factory.md.
//
// args: { repo, issue, slug, worktree, branch, config, lenses?: string[], maxRounds?: number,
//         seam?: boolean, startAt?: "spec" | "implement" | "review", parent?: number,
//         engine?: { commit, dirty? } }
// (validated before launch by src/resource.ts when run as the named resource "pi-factory"; keep both in step)
// config: the engine part of the repo's .pi/factory.json (src/config.ts): design sources, lens texts,
// skills, checks and stage guidance. Everything project-specific comes from there; this script
// holds none of it. The /factory command builds all of these args.
// engine: the pi-factory commit that launched the run, recorded in the PR for provenance.
// seam: the change is a shared foundation later issues build on (label `seam`); reviewers
// then rate inherited defects by blast radius.
// startAt: skip earlier stages. "implement" needs the spec already committed on the branch;
// "review" re-reviews an existing branch (e.g. after hand edits) and updates its PR if one exists.
// parent: tracking issue; the follow-up issue is added to it as a sub-issue.
// The caller creates `worktree` on `branch` before launching; every stage runs there.
// Whenever the run stops for a person, the issue or PR gets the `needs:human` label.

// Launched by name (the pi-factory resource, as /factory does), pi-subagents gives the args only to
// the resource's resolve, which prepends them to this script as FACTORY_ARGS. Launched by path, they
// are the sandbox's `args`.
const input = typeof FACTORY_ARGS !== "undefined" ? FACTORY_ARGS : args;

const config = input.config;
if (!config) throw new Error("args.config is required: launch with /factory, or pass the engine part of .pi/factory.json");
const models = config.models || {};
const OPUS = models.strong || "claude-bridge/claude-opus-5-5";
const SONNET = models.fast || "claude-bridge/claude-sonnet-5-5";
const HAIKU = models.small || "claude-bridge/claude-haiku-5-5";

const repo = input.repo;
const issue = input.issue;
const cwd = input.worktree;
const branch = input.branch;
// `code` always runs, whatever the caller names; the others are added to it.
const lenses = Array.from(new Set(["code"].concat(input.lenses || [])));
const LENS = config.lenses;
const unknownLenses = lenses.filter((l) => !LENS[l]);
if (unknownLenses.length) throw new Error(`no lens text in config for: ${unknownLenses.join(", ")}`);
const maxRounds = input.maxRounds || 2;
const seam = !!input.seam;
const STAGES = ["spec", "implement", "review"];
const startAt = input.startAt || "spec";
if (STAGES.indexOf(startAt) < 0) throw new Error(`startAt must be one of ${STAGES.join(", ")}`);
const stageRuns = (stage) => STAGES.indexOf(startAt) <= STAGES.indexOf(stage);
const parent = input.parent || null;
const NEEDS_HUMAN = "needs:human";
const SEAM_NOTE = seam
  ? `\nThis change is a SHARED SEAM: later issues build on it${config.seamNote ? ` (${config.seamNote})` : ""}. Rate by blast
radius, not by current reach: a defect every later caller would inherit or copy (a guard that can
be bypassed, a missing validation, a leaky contract) is at least "major", even if nothing reaches
it yet.`
  : "";
const specPath = `${config.specDir || "docs/specs"}/${issue}-${input.slug}.md`;
const CHECKS = config.checks;
const checkList = CHECKS.map((c) => `  - ${c.name}: ${c.command}`).join("\n");
const engineNote = input.engine && input.engine.commit
  ? `seandavi/pi-factory@${input.engine.commit}${input.engine.dirty ? " (with uncommitted changes)" : ""}`
  : "unknown (launched without /factory)";
// Single-quoted for the shell, so nothing in the configured identity is expanded.
const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const commitCmd = config.commitAuthor
  ? `git -c ${shellQuote(`user.name=${config.commitAuthor.name}`)} -c ${shellQuote(`user.email=${config.commitAuthor.email}`)} commit`
  : "git commit";

const cwdQ = shellQuote(cwd);
const CONTEXT = `
Repository: ${repo}, issue #${issue}. Working directory (a git worktree on branch ${branch}): ${cwdQ}
Read AGENTS.md in that directory first and follow it. ${config.design}
Work only inside ${cwdQ}. Never touch main, never merge, never force-push, never git stash.
Commit with: ${commitCmd}
and add the trailer "Co-Authored-By: Claude <noreply@anthropic.com>".`;
// The validator pins the names but cannot look at the disk: every stage that writes (spec,
// implement, revise, PR; all on the worker agent, which has bash) checks that the directory really
// is the issue's worktree before it does anything else. Reviewers are read-only and have no bash, so
// they get CONTEXT alone. A PR stage that stops here opens no PR, which the script flags below.
const COMMON = `${CONTEXT}
BEFORE ANYTHING ELSE run: git -C ${cwdQ} rev-parse --abbrev-ref HEAD
If the output is not exactly ${branch}, change nothing and stop: a stage with a status reports
"blocked" and names the mismatch in summary or blocking_questions; the PR stage reports pr_url as
an empty string.`;

// Skills handed to stages (config.skills). The built-in worker/reviewer agents set
// inheritSkills: false, so a child sees a skill only when named here. A missing skill is a warning.
const BUILD_SKILLS = (config.skills && config.skills.build) || undefined;
const LENS_SKILLS = (config.skills && config.skills.lenses) || {};
const withSkill = (skill) => (skill ? { skill } : {});

const statusSchema = (extra) => ({
  type: "object",
  required: ["status"],
  properties: Object.assign({ status: { type: "string", enum: ["done", "blocked"] } }, extra),
});
// One result per configured check, by name: "n/a" when the change cannot affect it.
const checksSchema = {
  type: "object",
  required: CHECKS.map((c) => c.name),
  properties: Object.fromEntries(CHECKS.map((c) => [c.name, { type: "string", enum: ["pass", "fail", "n/a"] }])),
};
const reviewSchema = {
  type: "object",
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "severity", "location", "problem", "fix"],
        properties: {
          id: { type: "string" },
          severity: { type: "string", enum: ["blocker", "major", "minor", "nit"] },
          location: { type: "string" },
          problem: { type: "string" },
          fix: { type: "string" },
        },
      },
    },
  },
};

// Label the issue (or the branch's PR) needs:human and say why. Used on every stop.
function flagHuman(key, why) {
  return runs.run(key, {
    label: `Flag issue #${issue} for a human`,
    agent: "worker",
    model: HAIKU,
    cwd,
    task: `${CONTEXT}

Do not change any file. Make sure the label exists, then add it (the first command does nothing
if the repository already has the label):
  gh label create ${NEEDS_HUMAN} -R ${repo} --description "Waiting on a person" 2>/dev/null || true
  gh issue edit ${issue} -R ${repo} --add-label ${NEEDS_HUMAN}
then post this as a comment on the issue with gh issue comment ${issue} -R ${repo} --body-file -:

The factory stopped and needs a human.

${why}`,
  });
}

// ---- 1. Spec -------------------------------------------------------------------------
let specOut = { status: "ready", spec_path: specPath, skipped: true };
if (stageRuns("spec")) {
  const spec = await runs.run("spec", {
    label: `Spec issue #${issue}`,
    agent: "worker",
    model: OPUS,
    cwd,
    outputSchema: {
      type: "object",
      required: ["status", "spec_path", "blocking_questions"],
      properties: {
        status: { type: "string", enum: ["ready", "blocked"] },
        spec_path: { type: "string" },
        blocking_questions: { type: "array", items: { type: "string" } },
      },
    },
    task: `${COMMON}

  You are the SPEC stage. Do not write any code.
  1. Read the issue: gh issue view ${issue} -R ${repo} --comments. Read AGENTS.md and the design
     sources above.
  2. Write ${specPath}: Goal; Non-goals; Design (${config.spec.design}); Acceptance criteria as a
     testable checklist; Test plan; Risks. Be concrete enough that an implementer never has to
     choose a library or an interface. Verify package APIs you rely on (the package manager's
     metadata or the package's docs) rather than guessing.
  3. Commit only that file ("Spec for #${issue}").
  Set status "blocked" only if a question has two reasonable answers with materially different
  outcomes that the issue and the design sources do not settle; list them in blocking_questions.`,
  });
  specOut = spec.structuredOutput || {};
  if (!spec.ok || specOut.status !== "ready") {
    const questions = (specOut.blocking_questions || []).map((q) => `- ${q}`).join("\n");
    const flag = await flagHuman("flag-spec", `Stage: spec. ${questions ? `Blocking questions:\n${questions}` : `Error: ${spec.error || "no structured output"}`}`);
    return { stage: "spec", stopped: true, flagged: flag.ok, spec: specOut, error: spec.error || null };
  }
}

// ---- 2. Implement --------------------------------------------------------------------
let implOut = { status: "done", changed_files: [], checks: {}, skipped: true };
if (stageRuns("implement")) {
  const impl = await runs.run("implement", {
    label: `Implement issue #${issue}`,
    agent: "worker",
    model: SONNET,
    ...withSkill(BUILD_SKILLS),
    cwd,
    outputSchema: statusSchema({
      summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      checks: checksSchema,
    }),
    task: `${COMMON}

  You are the IMPLEMENT stage. Implement exactly ${specPath}; it is the contract. Do not redesign.
  Work in the foreground (never leave background processes running).
  ${config.implement}
  Run these checks from ${cwdQ} and fix failures:
${checkList}
  Commit in small, well-described commits. Report changed_files (paths relative to the repo root)
  and each check's result by name ("n/a" only if the change cannot affect it).
  Set status "blocked" if the spec is wrong or impossible; explain in summary.`,
  });
  implOut = impl.structuredOutput || {};
  if (!impl.ok || implOut.status !== "done") {
    const flag = await flagHuman("flag-implement", `Stage: implement. ${implOut.summary || impl.error || "no structured output"}`);
    return { stage: "implement", stopped: true, flagged: flag.ok, spec: specOut, implement: implOut, error: impl.error || null };
  }
}

// ---- 3. Review, 4. Revise (≤ maxRounds) -----------------------------------------------
// Round ≥ 1 reviewers see what the previous round found and how it was answered, and judge the fix.
function priorRound(prior) {
  if (!prior) return "";
  return `
The previous round raised these findings:
${JSON.stringify(prior.findings, null, 2)}
The REVISE stage answered:
${JSON.stringify(prior.responses, null, 2)}
For each, judge the fix, not just whether the symptom is gone. A fix that patches the symptom but
leaves the root cause or the class of bug in place (e.g. checking a result after the unsafe action
has already happened) is a new "major" finding that names the old id. A "declined" response you
disagree with stays open at its old severity.`;
}
function reviewTask(lens, files, round, prior) {
  const scope = files.length
    ? `the changed files: ${files.join(", ")}`
    : `every file changed on this branch (git diff --name-only origin/main...HEAD)`;
  return `${CONTEXT}

You are a READ-ONLY reviewer (round ${round}). Lens: ${LENS[lens]}${SEAM_NOTE}
Read ${specPath} (if it does not exist, review against the issue), AGENTS.md and ${scope}.
Read any other file you need. Do not edit anything.${priorRound(prior)}
Report findings with severity: blocker (wrong or unsafe; must fix), major (should fix before merge),
minor, nit. Give each an id of the form "${lens}-r${round}-<n>" (e.g. "${lens}-r${round}-1");
when a finding repeats one from an earlier round, say so in problem. verdict is "changes" only if there is at
least one blocker or major finding. Do not pad: zero findings is a valid review.`;
}
function reviewBatch(lensList, files, round, prior) {
  return runs.all(lensList.map((lens) => Object.assign({
    key: `review-${lens}-r${round}`,
    label: `Review issue #${issue} ${lens} r${round}`,
    agent: "reviewer",
    model: OPUS,
    cwd,
    outputSchema: reviewSchema,
    task: reviewTask(lens, files, round, prior),
  }, withSkill(LENS_SKILLS[lens]))));
}
function blocking(results, lensList) {
  const out = [];
  results.forEach((r, i) => {
    const s = r.structuredOutput || { verdict: "changes", findings: [{ id: `${lensList[i]}-error`, severity: "major", location: "-", problem: `review failed: ${r.error || "no structured output"}`, fix: "re-run review" }] };
    (s.findings || []).forEach((f) => {
      if (f.severity === "blocker" || f.severity === "major") out.push(Object.assign({ lens: lensList[i] }, f));
    });
  });
  return out;
}
function minors(results, lensList) {
  const out = [];
  results.forEach((r, i) => {
    ((r.structuredOutput || {}).findings || []).forEach((f) => {
      if (f.severity === "minor" || f.severity === "nit") out.push(Object.assign({ lens: lensList[i] }, f));
    });
  });
  return out;
}

let files = implOut.changed_files || [];
let checks = implOut.checks || {};
let activeLenses = lenses.slice();
let results = await reviewBatch(activeLenses, files, 0);
let open = blocking(results, activeLenses);
let followUps = minors(results, activeLenses);
const history = [{ round: 0, lenses: activeLenses, blocking: open.length }];
let round = 0;

while (open.length && round < maxRounds) {
  round += 1;
  const rev = await runs.run(`revise-r${round}`, {
    label: `Revise issue #${issue} r${round}`,
    agent: "worker",
    model: SONNET,
    ...withSkill(BUILD_SKILLS),
    cwd,
    outputSchema: statusSchema({
      responses: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "action"],
          properties: {
            id: { type: "string" },
            action: { type: "string", enum: ["fixed", "declined"] },
            note: { type: "string" },
          },
        },
      },
      changed_files: { type: "array", items: { type: "string" } },
      checks: checksSchema,
    }),
    task: `${COMMON}

You are the REVISE stage, round ${round} of at most ${maxRounds}. Address these review findings:
${JSON.stringify(open, null, 2)}
Fix each, or decline it with a one-line reason if it contradicts ${specPath} or AGENTS.md.
Fix the root cause, not the symptom: prefer the change that makes the whole class of bug impossible
over a check that catches this instance. Reviewers will judge the fix itself.
If a fix changes an interface, a rule or an example the spec describes, update ${specPath} in the
same commit so the spec matches the code; later issues copy it.
Re-run the checks:
${checkList}
Commit ("Address review round ${round} for #${issue}").
Report every finding id in responses and all files you changed.`,
  });
  const revOut = rev.structuredOutput || {};
  if (!rev.ok || revOut.status !== "done") {
    history.push({ round, stopped: true, error: rev.error || null });
    break;
  }
  files = files.length ? Array.from(new Set(files.concat(revOut.changed_files || []))) : files;
  checks = revOut.checks || checks;
  const prior = { findings: open, responses: revOut.responses || [] };
  activeLenses = Array.from(new Set(open.map((f) => f.lens)));
  results = await reviewBatch(activeLenses, files, round, prior);
  open = blocking(results, activeLenses);
  followUps = followUps.concat(minors(results, activeLenses));
  history.push({ round, lenses: activeLenses, blocking: open.length, responses: revOut.responses || [] });
}

// ---- 5. Follow-up issue, PR -----------------------------------------------------------
const checksFailing = Object.keys(checks).some((k) => checks[k] === "fail");
const draft = open.length > 0 || checksFailing;
const pr = await runs.run("pr", {
  label: `Open PR for issue #${issue}`,
  agent: "worker",
  model: SONNET,
  cwd,
  outputSchema: {
    type: "object",
    required: ["pr_url"],
    properties: {
      pr_url: { type: "string" },
      draft: { type: "boolean" },
      followup_issue: { type: ["integer", "null"] },
    },
  },
  task: `${COMMON}

You are the PR stage. Do not change code.
1. git push -u origin ${branch}
2. ${followUps.length ? `File the minor/nit findings as one follow-up issue:
   gh issue create -R ${repo} --title "Follow-ups from the #${issue} review" --body-file -
   The body says they are minor/nit review findings on #${issue} not fixed before merge, then one
   checklist item per finding: "- [ ] **<id>** (<severity>) \`<location>\`: <problem> <fix>".
   Merge findings that repeat one another (keep the first id, list the others in it).
   Findings: ${JSON.stringify(followUps)}${parent ? `
   Then add it as a sub-issue of #${parent}:
   gh api -X POST repos/${repo}/issues/${parent}/sub_issues -F sub_issue_id=$(gh api repos/${repo}/issues/<new number> --jq .id)` : ""}` : "There are no minor/nit findings; skip this step and report followup_issue null."}
3. Write the PR body (to a file, then --body-file):
   - "Closes #${issue}" and a short summary from ${specPath}.
   - "Factory record": a table with one row per review round (round, lenses, blocking findings,
     what was fixed or declined, one line each) from ${JSON.stringify(history)}; then the checks
     ${JSON.stringify(checks)}; then the line "Engine: ${engineNote}".${startAt !== "spec" ? ` Note that this run started at the ${startAt} stage.` : ""}
   ${open.length ? `- "Unresolved review findings": one bullet per finding from ${JSON.stringify(open)}.` : ""}
   - "Follow-ups": one line linking the follow-up issue from step 2 (omit if none).
4. If a PR for ${branch} already exists (gh pr view ${branch} -R ${repo}), replace its body with
   gh pr edit and keep its title${draft ? " and mark it draft (gh pr ready --undo)" : ""}. Otherwise:
   gh pr create -R ${repo} --base main --head ${branch} ${draft ? "--draft " : ""}with a title naming the change.
   Either way, make sure the label exists and add it (the first command does nothing if the
   repository already has the label):
   gh label create ${NEEDS_HUMAN} -R ${repo} --description "Waiting on a person" 2>/dev/null || true
   gh pr edit ${branch} -R ${repo} --add-label ${NEEDS_HUMAN}
5. Report the PR URL and the follow-up issue number.`,
});
const prOut = pr.structuredOutput || {};
// No PR means nothing carries needs:human, so the stop has to be flagged on the issue.
if (!pr.ok || !prOut.pr_url) {
  const unresolvedNote = open.length ? `\nUnresolved findings:\n${open.map((f) => `- ${f.id}: ${f.problem}`).join("\n")}` : "";
  const flag = await flagHuman("flag-pr", `Stage: pr. ${pr.error || "No PR was opened (see the PR stage's output; a worktree on the wrong branch stops it)."}${unresolvedNote}`);
  return { stage: "pr", stopped: true, flagged: flag.ok, rounds: history, unresolved: open, checks, error: pr.error || null, engine: input.engine || null };
}

return {
  issue,
  startAt,
  pr: prOut.pr_url || null,
  draft,
  spec: specOut.spec_path,
  checks,
  rounds: history,
  unresolved: open,
  followUps: followUps.length,
  followUpIssue: prOut.followup_issue || null,
  engine: input.engine || null,
};
