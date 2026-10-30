// pi-crucible: spec (Opus) → implement (Sonnet) → [diff (Haiku) → review lenses (Opus, parallel)]
// → revise ≤ maxRounds (Sonnet) → integrate (Haiku; one Sonnet fix round) → PR (Sonnet). See docs/crucible.md.
//
// args: { repo, issue, slug, worktree, branch, config, lenses?: string[], maxRounds?: number,
//         seam?: boolean, startAt?: "spec" | "implement" | "review", parent?: number,
//         engine?: { commit, dirty? } }
// (validated before launch by src/resource.ts when run as the named resource "pi-crucible"; keep both in step)
// config: the engine part of the repo's .pi/crucible.json (src/config.ts): design sources, lens texts,
// skills, checks and stage guidance. Everything project-specific comes from there; this script
// holds none of it. The /crucible command builds all of these args.
// engine: the pi-crucible commit that launched the run, recorded in the PR for provenance.
// seam: the change is a shared foundation later issues build on (label `seam`); reviewers
// then rate inherited defects by blast radius.
// startAt: skip earlier stages. "implement" needs the spec already committed on the branch;
// "review" re-reviews an existing branch (e.g. after hand edits) and updates its PR if one exists.
// parent: tracking issue; the follow-up issue is added to it as a sub-issue.
// The caller creates `worktree` on `branch` before launching; every stage runs there.
// Whenever the run stops for a person, the issue or PR gets the `needs:human` label.

// Launched by name (the pi-crucible resource, as /crucible does), pi-subagents gives the args only to
// the resource's resolve, which prepends them to this script as CRUCIBLE_ARGS. Launched by path, they
// are the sandbox's `args`.
const input = typeof CRUCIBLE_ARGS !== "undefined" ? CRUCIBLE_ARGS : args;

const config = input.config;
if (!config) throw new Error("args.config is required: launch with /crucible, or pass the engine part of .pi/crucible.json");
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
// Where the diff step writes the diff each review round reads; its .gitignore ("*") keeps the
// directory out of git without touching the repository's own ignore files.
const REVIEW_DIR = ".pi/crucible-review";
const diffFile = (round) => `${REVIEW_DIR}/r${round}.diff`;
const CHECKS = config.checks;
const checkList = CHECKS.length
  ? CHECKS.map((c) => `  - ${c.name}: ${c.command}`).join("\n")
  : "  (none configured: say so in summary, and in the PR say \"no checks configured\")";
const engineNote = input.engine && input.engine.commit
  ? `seandavi/pi-crucible@${input.engine.commit}${input.engine.dirty ? " (with uncommitted changes)" : ""}`
  : "unknown (launched without /crucible)";
// Single-quoted for the shell, so nothing in the configured identity is expanded.
const shellQuote = (text) => `'${String(text).replace(/'/g, "'\\''")}'`;
const gitAs = config.commitAuthor
  ? `git -c ${shellQuote(`user.name=${config.commitAuthor.name}`)} -c ${shellQuote(`user.email=${config.commitAuthor.email}`)}`
  : "git";
const commitCmd = `${gitAs} commit`;

const cwdQ = shellQuote(cwd);
const CONTEXT = `
Repository: ${repo}, issue #${issue}. Working directory (a git worktree on branch ${branch}): ${cwdQ}
Read AGENTS.md in that directory first and follow it. ${config.design}
Work only inside ${cwdQ}. Never touch main, never merge, never force-push, never git stash.
Commit with: ${commitCmd}
and add the trailer "Co-Authored-By: Claude <noreply@anthropic.com>".`;
// The validator pins the names but cannot look at the disk: every stage that writes (spec,
// implement, diff, revise, integrate, integrate-fix, PR; all on the worker agent, which has bash) checks that the directory really
// is the issue's worktree before it does anything else. Reviewers are read-only and have no bash, so
// they get CONTEXT alone. A PR stage that stops here opens no PR, which the script flags below.
const REPORT_ONCE = `Call structured_output once, as your last step, with the whole report. A later call replaces an
earlier one. If a call is rejected, fix the report and call it again.`;
const COMMON = `${CONTEXT}
BEFORE ANYTHING ELSE run: git -C ${cwdQ} rev-parse --abbrev-ref HEAD
If the output is not exactly ${branch}, change nothing and stop: a stage with a status reports
"blocked" and names the mismatch in summary or blocking_questions; the PR stage reports pr_url as
an empty string and followup_issue null.
${REPORT_ONCE}`;

// Skills handed to stages (config.skills). The built-in worker/reviewer agents set
// inheritSkills: false, so a child sees a skill only when named here. A missing skill is a warning.
const BUILD_SKILLS = (config.skills && config.skills.build) || undefined;
const LENS_SKILLS = (config.skills && config.skills.lenses) || {};
const withSkill = (skill) => (skill ? { skill } : {});

// Every report is closed (additionalProperties: false), so a stray or half-copied second report is
// rejected instead of replacing the real one (#56). `required` holds only what a "blocked" report
// has too; doneGaps checks the rest of a "done" report. No if/then in the schemas: not every model
// provider a config can name honours conditional keywords, and an unenforced rule is worse than none.
const statusSchema = (extra) => ({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary"],
  properties: Object.assign({ status: { type: "string", enum: ["done", "blocked"] }, summary: { type: "string" } }, extra),
});
// The fields of a report that are missing or do not match the schema (type, enum and, for an
// object, each required key in turn), as dotted paths.
function fieldGaps(value, schema, path) {
  if (value === undefined || value === null) return [path];
  const typed = schema.type === "array" ? Array.isArray(value)
    : schema.type === "integer" ? Number.isInteger(value)
    : schema.type === "object" ? typeof value === "object" && !Array.isArray(value)
    : typeof value === schema.type;
  if (!typed || (schema.enum && schema.enum.indexOf(value) < 0)) return [path];
  if (schema.type !== "object") return [];
  return (schema.required || []).reduce((gaps, k) => gaps.concat(fieldGaps(value[k], schema.properties[k], `${path}.${k}`)), []);
}
// Why a "done" report cannot be used ("" when it can, or when it is not "done"): a field the script
// reads is missing, so it must not be read as a result (a missing check is not a failing one).
function doneGaps(stage, out, schema, fields) {
  if (out.status !== "done") return "";
  const gaps = fields.reduce((all, f) => all.concat(fieldGaps(out[f], schema.properties[f], f)), []);
  return gaps.length ? `${stage} reported "done" without: ${gaps.join(", ")}` : "";
}
const reason = (result) => String((result.structuredOutput || {}).summary || result.error || "no structured output").slice(0, 200);
// A "done" report carries the checks only when some are configured.
const checksField = CHECKS.length ? ["checks"] : [];
// One result per configured check, by name: "n/a" when the change cannot affect it.
const checksSchema = {
  type: "object",
  additionalProperties: false,
  required: CHECKS.map((c) => c.name),
  properties: Object.fromEntries(CHECKS.map((c) => [c.name, { type: "string", enum: ["pass", "fail", "n/a"] }])),
};
const reviewSchema = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "findings"],
  properties: {
    verdict: { type: "string", enum: ["approve", "changes"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
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

pi-crucible stopped and needs a human.

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
      additionalProperties: false,
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
const implementSchema = statusSchema({
  changed_files: { type: "array", items: { type: "string" } },
  checks: checksSchema,
});
if (stageRuns("implement")) {
  const impl = await runs.run("implement", {
    label: `Implement issue #${issue}`,
    agent: "worker",
    model: SONNET,
    ...withSkill(BUILD_SKILLS),
    cwd,
    outputSchema: implementSchema,
    task: `${COMMON}

  You are the IMPLEMENT stage. Implement exactly ${specPath}; it is the contract. Do not redesign.
  Work in the foreground (never leave background processes running).
  ${config.implement}
  Run these checks from ${cwdQ} and fix failures:
${checkList}
  Commit in small, well-described commits. A "done" report has summary (one line), changed_files
  (paths relative to the repo root) and checks: each check's result by name ("n/a" only if the
  change cannot affect it).
  Set status "blocked" if the spec is wrong or impossible; explain in summary.`,
  });
  implOut = impl.structuredOutput || {};
  const implGap = doneGaps("implement", implOut, implementSchema, ["changed_files"].concat(checksField));
  if (!impl.ok || implOut.status !== "done" || implGap) {
    const flag = await flagHuman("flag-implement", `Stage: implement. ${implGap || implOut.summary || impl.error || "no structured output"}`);
    return { stage: "implement", stopped: true, flagged: flag.ok, spec: specOut, implement: implOut, error: impl.error || implGap || null };
  }
}

// ---- 3a. Diff (before each review batch) ---------------------------------------------
// Reviewers have no shell, so a Haiku worker writes the branch's diff where they can read it.
const diffSchema = statusSchema({
  changed_files: { type: "array", items: { type: "string" } },
  diff_lines: { type: "integer" },
});
function diffRun(round) {
  const dir = `${cwd}/${REVIEW_DIR}`;
  const file = `${cwd}/${diffFile(round)}`;
  const range = "origin/main...HEAD";
  return runs.run(`diff-r${round}`, {
    label: `Diff for issue #${issue} r${round}`,
    agent: "worker",
    model: HAIKU,
    cwd,
    outputSchema: diffSchema,
    task: `${COMMON}

You are the DIFF stage for review round ${round}. Do not edit, stage or commit any file in the
repository; you only write the review diff, which git ignores. Run these commands from ${cwdQ},
in order, exactly as written:
  mkdir -p ${shellQuote(dir)}
  printf '*\\n' > ${shellQuote(`${dir}/.gitignore`)}
  git -C ${cwdQ} diff --no-color --no-ext-diff --stat=200 ${range} > ${shellQuote(file)}
  git -C ${cwdQ} diff --no-color --no-ext-diff ${range} >> ${shellQuote(file)}
  wc -l < ${shellQuote(file)}
  git -C ${cwdQ} diff --name-only ${range}
Report status "done", summary (one line), diff_lines (the number wc printed) and changed_files (the
paths the last command printed, one per line; an empty list if it printed nothing). If a command
fails, stop, report status "blocked" and put the command and its error in summary.`,
  });
}

// What a round's reviewers get: the diff file and git's list of changed files, or why there is
// none. `record` is the round's entry in the PR's crucible record.
function diffFor(result, round) {
  const out = result.structuredOutput || {};
  const gap = doneGaps("diff", out, diffSchema, ["changed_files", "diff_lines"]);
  if (result.ok && out.status === "done" && !gap) {
    const files = out.changed_files;
    return {
      path: `${cwd}/${diffFile(round)}`,
      lines: out.diff_lines,
      files,
      record: `${diffFile(round)} (${out.diff_lines} lines, ${files.length} files)`,
    };
  }
  const why = String(gap || out.summary || result.error || "no structured output").slice(0, 200);
  return { path: null, lines: 0, files: [], record: `unavailable: ${why}` };
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
function reviewTask(lens, diff, files, round, prior, note) {
  const source = diff.path
    ? `The branch's changes are in ${diff.path}: the output of git diff origin/main...HEAD, a --stat
summary followed by the full diff (${diff.lines} lines). You cannot run git, so this file is how you
see the change: read all of it with your read tool, continuing with offset until the end (each read
returns at most 2000 lines). You may skip the hunks of generated files (lockfiles, build output) the
--stat names. The watchdog_diff tool does not see commits; do not use it.
${diff.files.length ? `Changed files: ${diff.files.join(", ")}.` : "The diff is empty: nothing on this branch differs from main."}`
    : `The diff for this round could not be prepared (${diff.record}) and you cannot run git. Review ${files.length ? `the changed files: ${files.join(", ")}` : "the files the spec says change"}.`;
  return `${CONTEXT}

You are a READ-ONLY reviewer (round ${round}). Lens: ${LENS[lens]}${SEAM_NOTE}
${source}
Read ${specPath} (if it does not exist, review against the issue), AGENTS.md and any other file you
need, including a changed file in full when its hunks are not enough. Do not edit anything.${priorRound(prior)}${note ? `\n${note}` : ""}
Report findings with severity: blocker (wrong or unsafe; must fix), major (should fix before merge),
minor, nit. Give each an id of the form "${lens}-r${round}-<n>" (e.g. "${lens}-r${round}-1");
when a finding repeats one from an earlier round, say so in problem. Set location to "path:line",
where line is the line's number in the branch's version of the file (in the diff, count from the
+start in the hunk's @@ header), or "-" when the finding is not about one place. verdict is
"changes" only if there is at least one blocker or major finding. Do not pad: zero findings is a
valid review.
${REPORT_ONCE}`;
}
function reviewBatch(lensList, diff, files, round, prior, note) {
  return runs.all(lensList.map((lens) => Object.assign({
    key: `review-${lens}-r${round}`,
    label: `Review issue #${issue} ${lens} r${round}`,
    agent: "reviewer",
    model: OPUS,
    cwd,
    outputSchema: reviewSchema,
    task: reviewTask(lens, diff, files, round, prior, note),
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
let diff = diffFor(await diffRun(0), 0);
let results = await reviewBatch(activeLenses, diff, files, 0);
let open = blocking(results, activeLenses);
let followUps = minors(results, activeLenses);
const history = [{ round: 0, lenses: activeLenses, diff: diff.record, blocking: open.length }];
let round = 0;
const reviseSchema = statusSchema({
  responses: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
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
});

while (open.length && round < maxRounds) {
  round += 1;
  const rev = await runs.run(`revise-r${round}`, {
    label: `Revise issue #${issue} r${round}`,
    agent: "worker",
    model: SONNET,
    ...withSkill(BUILD_SKILLS),
    cwd,
    outputSchema: reviseSchema,
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
A "done" report has summary (one line), every finding id in responses, changed_files (all files
you changed) and each check's result by name. If you cannot go on, report status "blocked" and
say why in summary.`,
  });
  const revOut = rev.structuredOutput || {};
  const reviseGap = doneGaps("revise", revOut, reviseSchema, ["responses", "changed_files"].concat(checksField));
  if (!rev.ok || revOut.status !== "done" || reviseGap) {
    history.push({ round, stopped: true, error: reviseGap || reason(rev) });
    break;
  }
  files = files.length ? Array.from(new Set(files.concat(revOut.changed_files || []))) : files;
  checks = revOut.checks || checks;
  const prior = { findings: open, responses: revOut.responses || [] };
  activeLenses = Array.from(new Set(open.map((f) => f.lens)));
  diff = diffFor(await diffRun(round), round);
  results = await reviewBatch(activeLenses, diff, files, round, prior);
  open = blocking(results, activeLenses);
  followUps = followUps.concat(minors(results, activeLenses));
  history.push({ round, lenses: activeLenses, diff: diff.record, blocking: open.length, responses: revOut.responses || [] });
}

// ---- 5. Integration --------------------------------------------------------------------
// Parallel runs pass their own checks and still break each other once merged (#5). Merge the latest
// origin/main into the branch and run every check; on a conflict or a failure, one Sonnet fix round
// and a re-check. The code lens re-reviews a fix that touched non-test files. Never stops the run: a
// branch that does not integrate opens as a draft.
const MERGE_MSG = `Merge origin/main into ${branch} for the integration check`;
const mergeCmd = `${gitAs} -C ${cwdQ} merge --no-edit -m ${shellQuote(MERGE_MSG)} -m ${shellQuote("Co-Authored-By: Claude <noreply@anthropic.com>")} origin/main`;
const MERGE_EXCEPTION = `Merging origin/main into ${branch} is this stage's job and the one exception to "never
merge": never merge anything else, never merge into main, and never push, rebase or reset.`;
// Every check, pass or fail: unlike implement and revise, "n/a" is not an answer here.
const fullChecksSchema = {
  type: "object",
  additionalProperties: false,
  required: CHECKS.map((c) => c.name),
  properties: Object.fromEntries(CHECKS.map((c) => [c.name, { type: "string", enum: ["pass", "fail"] }])),
};
// The tail of each failing check's output handed to the fix round.
const FAILURE_CHARS = 3000;

const integrateSchema = statusSchema({
  main: { type: "string" },
  merge: { type: "string", enum: ["merged", "up-to-date", "conflict"] },
  conflicts: { type: "array", items: { type: "string" } },
  checks: fullChecksSchema,
  failures: {
    type: "array",
    items: {
      type: "object",
      additionalProperties: false,
      required: ["check", "output"],
      properties: { check: { type: "string" }, output: { type: "string" } },
    },
  },
});
// What a "done" integration report carries: the conflicts when the merge stopped, else the checks,
// and failures when a check failed (only the fix round reads them).
const integrateFields = (out) => ["main", "merge"].concat(out.merge === "conflict" ? ["conflicts"]
  : CHECKS.length ? ["checks"].concat(CHECKS.some((c) => (out.checks || {})[c.name] === "fail") ? ["failures"] : []) : []);

function integrateRun(key, recheck) {
  return runs.run(key, {
    label: `${recheck ? "Re-check integration" : "Integrate main"} for issue #${issue}`,
    agent: "worker",
    model: HAIKU,
    cwd,
    outputSchema: integrateSchema,
    task: `${COMMON}

You are the INTEGRATION stage${recheck ? ", re-checking after the fix round" : ""}. ${MERGE_EXCEPTION}
Do not edit, stage or commit anything else, and do not try to fix a failure: report it. Work in the
foreground. Run these commands from ${cwdQ}, in order, exactly as written:
  git -C ${cwdQ} fetch origin
  git -C ${cwdQ} rev-parse --short origin/main
  ${mergeCmd}
If the merge stops on conflicts, run
  git -C ${cwdQ} diff --name-only --diff-filter=U
  git -C ${cwdQ} merge --abort
then report merge "conflict" and conflicts (the paths the first of those printed), do not run
the checks, and leave checks and failures out of the report. Otherwise report merge "up-to-date" if git printed "Already up to date.", else "merged",
and run every one of these checks from ${cwdQ}, each to the end even when an earlier one fails:
${checkList}
Report each check "pass" (it exited 0) or "fail", and for each failing check add an entry to
failures with the check's name and the last 80 lines of its output (an empty list when all pass).
Report main (the commit rev-parse printed), summary (one line) and status "done", whether or not
the checks pass. A "done" report has main, merge and then either conflicts or every check (and
failures when one fails); one without them is an error. If any other command fails
(the fetch, rev-parse, or a merge that fails without conflicts), stop, report status "blocked" and
put the command and its error in summary.`,
  });
}

const integrationPassed = (out) => out.merge !== "conflict" && CHECKS.every((c) => (out.checks || {})[c.name] === "pass");
const failingChecks = (out) => CHECKS.filter((c) => (out.checks || {})[c.name] !== "pass").map((c) => c.name);
// The record's view of one complete integration report.
const integrationOf = (out) => ({
  main: out.main || null,
  merge: out.merge || null,
  conflicts: out.conflicts || [],
  failing: out.merge === "conflict" ? [] : failingChecks(out),
  checks: out.checks || {},
});

// The PR's crucible record and the run's result: what integration did. After a fix round and a
// re-check, main, merge, conflicts, failing and checks are the re-check's, and firstAttempt keeps
// the first report's view when its conflicts or failing checks differ.
const integration = { status: "pass", main: null, merge: null, conflicts: [], failing: [], checks: {}, firstAttempt: null, fix: null, reReview: null, note: "" };
const first = await integrateRun("integrate", false);
const firstOut = first.structuredOutput || {};
const firstGap = doneGaps("integrate", firstOut, integrateSchema, integrateFields(firstOut));
if (!first.ok || firstOut.status !== "done" || firstGap) {
  integration.status = "error";
  integration.note = firstGap || reason(first);
} else {
  const firstView = integrationOf(firstOut);
  Object.assign(integration, firstView);
  if (!integrationPassed(firstOut)) {
    const conflicted = firstOut.merge === "conflict";
    const failures = (firstOut.failures || []).map((f) => ({ check: String(f.check), output: String(f.output).slice(-FAILURE_CHARS) }));
    const problem = conflicted
      ? `The merge conflicts in: ${integration.conflicts.join(", ")}. Nothing is merged yet. Run
  ${mergeCmd}
resolve every conflict, then commit the merge with
  ${commitCmd} --no-edit --cleanup=strip`
      : `The merge itself is committed, but these checks fail after it: ${integration.failing.join(", ")}. The end of their output:
${JSON.stringify(failures, null, 2)}`;
    const fixSchema = statusSchema({
      changed_files: { type: "array", items: { type: "string" } },
      non_test_files: { type: "array", items: { type: "string" } },
      checks: fullChecksSchema,
    });
    const fix = await runs.run("integrate-fix", {
      label: `Fix integration for issue #${issue}`,
      agent: "worker",
      model: SONNET,
      ...withSkill(BUILD_SKILLS),
      cwd,
      outputSchema: fixSchema,
      task: `${COMMON}

You are the INTEGRATION FIX stage, the only fix round. ${MERGE_EXCEPTION}
After review, merging origin/main${integration.main ? ` (${integration.main})` : ""} into ${branch} broke it.
${problem}
The break comes from combining this branch with changes that reached main after it was cut. Make the
branch work with main as it is now: keep both sides' intent, never revert or weaken main's changes,
and never delete or skip a failing test to make it pass. ${specPath} is still the contract; if main
changed something the spec relies on (a signature, a fixture, a rule), adapt to main and update
${specPath} in the same commit.
Project rules: ${config.implement}
Run every check, not only the failing ones, and fix failures:
${checkList}
Commit ("Fix integration with main for #${issue}"). If you cannot make it work, run
git -C ${cwdQ} merge --abort if a merge is still in progress, leave git status clean, and report
status "blocked" with the reason in summary.
Report changed_files: only the files you edited (conflict resolutions and fixes), not the files the
merge brought in from main unchanged; non_test_files: those of them that are not tests, test
fixtures or test data (when unsure, list the file); summary: one line on what broke and how you
fixed it; and each check's result by name.`,
    });
    const fixOut = fix.structuredOutput || {};
    const fixGap = doneGaps("integrate-fix", fixOut, fixSchema, ["changed_files"].concat(checksField));
    if (!fix.ok || fixOut.status !== "done" || fixGap) {
      integration.status = "fail";
      integration.fix = { status: "blocked", summary: fixGap || reason(fix), changed_files: [], non_test_files: [] };
    } else {
      const changed = fixOut.changed_files;
      // A missing non_test_files is not a gap: every changed file is then re-reviewed.
      integration.fix = { status: "done", summary: String(fixOut.summary || "").slice(0, 300), changed_files: changed, non_test_files: fixOut.non_test_files || changed };
      files = files.length ? Array.from(new Set(files.concat(changed))) : files;
      const re = await integrateRun("integrate-recheck", true);
      const reOut = re.structuredOutput || {};
      const reGap = doneGaps("integrate", reOut, integrateSchema, integrateFields(reOut));
      if (!re.ok || reOut.status !== "done" || reGap) {
        integration.status = "error";
        integration.note = `re-check: ${reGap || reason(re)}`;
        // The final merge is unknown: only the fix's checks and the first view are.
        Object.assign(integration, { main: null, merge: null, conflicts: [], failing: failingChecks(fixOut), checks: fixOut.checks || {}, firstAttempt: firstView });
      } else {
        const final = integrationOf(reOut);
        Object.assign(integration, final);
        integration.status = integrationPassed(reOut) ? "pass" : "fail";
        const hit = (v) => JSON.stringify([v.conflicts, v.failing]);
        if (hit(firstView) !== hit(final)) integration.firstAttempt = firstView;
      }
      if (integration.fix.non_test_files.length) {
        const r = round + 1;
        const note = `This round reviews the INTEGRATION FIX. After the review rounds, origin/main${firstView.main ? ` (${firstView.main})` : ""} was merged
into the branch and ${conflicted ? `conflicted in ${firstView.conflicts.join(", ")}` : `these checks failed: ${firstView.failing.join(", ")}`}. The fix round changed
${changed.join(", ") || "files it did not list"}: ${integration.fix.summary}
Judge whether the fix is right and keeps both this branch's and main's intent. The rest of the diff
was reviewed in earlier rounds: raise findings there only where the fix or main's changes affect it.`;
        diff = diffFor(await diffRun(r), r);
        const fixReview = await reviewBatch(["code"], diff, files, r, null, note);
        const fixBlocking = blocking(fixReview, ["code"]);
        open = open.concat(fixBlocking);
        followUps = followUps.concat(minors(fixReview, ["code"]));
        history.push({ round: r, lenses: ["code"], diff: diff.record, blocking: fixBlocking.length, after: "integration fix" });
        integration.reReview = r;
      }
    }
  }
}
if (Object.keys(integration.checks).length) checks = integration.checks;

// ---- 6. Follow-up issue, PR -----------------------------------------------------------
const checksFailing = Object.keys(checks).some((k) => checks[k] === "fail");
const draft = open.length > 0 || checksFailing || integration.status !== "pass";
const pr = await runs.run("pr", {
  label: `Open PR for issue #${issue}`,
  agent: "worker",
  model: SONNET,
  cwd,
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["pr_url", "followup_issue"],
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
   - "Crucible record": a table with one row per review round (round, lenses, the diff the
     reviewers read, blocking findings, what was fixed or declined, one line each; a row with
     "after": "integration fix" is the code lens re-reviewing the integration fix) from
     ${JSON.stringify(history)}; then an "Integration" line from ${JSON.stringify(integration)}:
     the origin/main commit merged (main) and how (merge: merged, up-to-date or conflict, naming
     the conflicts), each check's result after the merge, what the fix round did (fix; "none" when
     null) and the re-review round (reReview; "not needed" when null). These describe the final
     state (main and merge are null when the re-check failed); when firstAttempt is not null, also say what the first attempt hit before the fix round
     (its conflicts or failing checks). When status is not "pass",
     start that line with "Does not integrate with main:" and the reason (note, the conflicts or
     the failing checks). Then the checks ${JSON.stringify(checks)}; then the line "Engine: ${engineNote}".
     Put every string a stage reported (diffs, errors, notes, summaries, revise responses) in
     inline code, so mentions and markdown in it do not render.${startAt !== "spec" ? ` Note that this run started at the ${startAt} stage.` : ""}
   ${open.length ? `- "Unresolved review findings": one bullet per finding from ${JSON.stringify(open)}.` : ""}
   - "Follow-ups": one line linking the follow-up issue from step 2 (omit if none).
4. If a PR for ${branch} already exists (gh pr view ${branch} -R ${repo}), replace its body with
   gh pr edit and keep its title${draft ? " and mark it draft (gh pr ready --undo)" : ""}. Otherwise:
   gh pr create -R ${repo} --base main --head ${branch} ${draft ? "--draft " : ""}with a title naming the change.
   Either way, make sure the label exists and add it (the first command does nothing if the
   repository already has the label):
   gh label create ${NEEDS_HUMAN} -R ${repo} --description "Waiting on a person" 2>/dev/null || true
   gh pr edit ${branch} -R ${repo} --add-label ${NEEDS_HUMAN}
5. Report pr_url, draft, and followup_issue (the follow-up issue's number, or null).`,
});
const prOut = pr.structuredOutput || {};
// No PR means nothing carries needs:human, so the stop has to be flagged on the issue.
if (!pr.ok || !prOut.pr_url) {
  const unresolvedNote = open.length ? `\nUnresolved findings:\n${open.map((f) => `- ${f.id}: ${f.problem}`).join("\n")}` : "";
  const flag = await flagHuman("flag-pr", `Stage: pr. ${pr.error || "No PR was opened (see the PR stage's output; a worktree on the wrong branch stops it)."}${unresolvedNote}`);
  return { stage: "pr", stopped: true, flagged: flag.ok, rounds: history, unresolved: open, checks, integration, error: pr.error || null, engine: input.engine || null };
}

return {
  issue,
  startAt,
  pr: prOut.pr_url || null,
  draft,
  spec: specOut.spec_path,
  checks,
  integration,
  rounds: history,
  unresolved: open,
  followUps: followUps.length,
  followUpIssue: prOut.followup_issue || null,
  engine: input.engine || null,
};
