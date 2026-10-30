// pi-crucible: spec (Opus) → implement (Sonnet) → [diff (host) → review lenses (Opus, parallel)]
// → revise ≤ maxRounds (Sonnet) → integrate (Haiku merges, the host runs the checks; one Sonnet fix
// round) → PR (Sonnet). See docs/crucible.md.
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
// The caller creates `worktree` on `branch` before launching; every stage runs there, and so must the
// workflow itself (its cwd), because that is where the host commands run.
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
// implement, revise, integrate, integrate-fix, PR; all on the worker agent, which has bash) checks that the directory really
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

// ---- Host commands ---------------------------------------------------------------------
// runs.host runs only what src/resource.ts grants: CRUCIBLE_HOST, key → { command, timeoutMs,
// output? }, each key once per run, with sh in the workflow cwd. Launched by path there is no table
// and no authority; the checks are in the table only when /crucible read them from origin/main.
// A command that exits nonzero or times out rejects with "Command exited with code N. <the start of
// its output>" or "Command timed out after …ms." (200 characters at most); stdout comes back as its
// first 4 KiB, and the full stdout and stderr (the first 1 MiB) are saved at `output` in the
// worktree, or else in the run's artifacts.
const HOST = typeof CRUCIBLE_HOST !== "undefined" ? CRUCIBLE_HOST : null;
const NO_HOST = "launched without the pi-crucible resource; host steps unavailable";
const NO_CHECK_GRANT = "the checks are granted only for a config /crucible read from origin/main in this session; relaunch with /crucible";
// { ok: true, stdout, outputPath } or { ok: false, failed, exitCode, error }: failed when the command
// ran and exited nonzero (exitCode N, or "unknown" after a signal) or timed out (exitCode "timeout");
// otherwise it could not run.
function host(key) {
  const step = HOST && HOST[key];
  if (!step) {
    const error = !HOST ? NO_HOST : /^(re)?check-/.test(key) ? `no host grant for ${key}: ${NO_CHECK_GRANT}` : `no host grant for ${key}`;
    return Promise.resolve({ ok: false, failed: false, exitCode: null, error });
  }
  const params = { kind: "command", command: step.command, timeoutMs: step.timeoutMs };
  if (step.output) params.output = step.output;
  return runs.host(key, params).then(
    (r) => ({ ok: true, stdout: String(r.stdout || ""), outputPath: String(r.outputPath || "") }),
    (e) => {
      const error = String((e && e.message) || e).replace(/^Host command '[^']*' failed: /, "");
      // "unknown": killed by a signal.
      const exit = /^Command exited with code (\d+|unknown)\./.exec(error);
      const timedOut = /^Command timed out after /.test(error);
      return { ok: false, failed: !!exit || timedOut, exitCode: exit ? (exit[1] === "unknown" ? "unknown" : Number(exit[1])) : timedOut ? "timeout" : null, error };
    },
  );
}
// Step one: the workflow must run in the issue's worktree on its branch, or no other host command
// runs (a hand launch from another directory would diff and check the wrong tree).
const hostBlocked = await host("host-worktree").then((r) => {
  if (!r.ok) return HOST ? `the worktree check failed: ${r.error.slice(0, 200)}` : NO_HOST;
  const seen = r.stdout.trim();
  return seen === `${cwd}\n${branch}` ? "" : `the workflow is not running in ${cwd} on ${branch} (git printed ${JSON.stringify(seen.slice(0, 200))}); host steps skipped`;
});
const hostStep = (key) => (hostBlocked ? Promise.resolve({ ok: false, failed: false, exitCode: null, error: hostBlocked }) : host(key));
// Reported text in inline code, so mentions and markdown in it do not render.
// One line, no backticks: a blank line or a backtick would end the code span and let markdown render.
const inlineCode = (text) => `\`${String(text).replace(/`/g, "'").replace(/\s+/g, " ")}\``;

// Label the issue (or the branch's PR) needs:human and say why. Used on every stop. The comment is
// a quoted heredoc, so the shell posts `why` (which holds reported text) as written.
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
then post the comment by running this command exactly as written (a quoted heredoc: the shell
expands nothing in it, so the comment is posted verbatim):
gh issue comment ${issue} -R ${repo} --body-file - <<'CRUCIBLE_EOF'
pi-crucible stopped and needs a human.

${String(why).replace(/CRUCIBLE_EOF/g, "CRUCIBLE-EOF")}
CRUCIBLE_EOF`,
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
// Reviewers have no shell, so the host writes the branch's diff to .pi/crucible-review/r<round>.diff
// in the worktree (the table's `output`), which they read: git diff --numstat --shortstat -p
// origin/main...HEAD, i.e. one line per file, a summary line, the patch. Before the first, the host
// writes the directory's `*` .gitignore, so no stage commits it. The path is the same in every run,
// so a resumed run's reviewer tasks match and their results are reused.
let reviewIgnore = null;
function diffRun(round) {
  reviewIgnore = reviewIgnore || hostStep("host-review-ignore");
  return reviewIgnore.then((ignored) => (ignored.ok ? hostStep(`host-diff-r${round}`) : ignored));
}
const diffPath = (round) => `${cwd}/${HOST[`host-diff-r${round}`].output}`;

// What a round's reviewers get: the diff file and git's list of changed files, or why there is
// none. The list and the counts come from stdout's first 4 KiB; when the summary line is not in it,
// the list is partial and the counts unknown. `record` is the round's entry in the PR's crucible
// record; its lines are git's insertions and deletions.
function diffFor(result, round) {
  if (!result.ok) return { path: null, files: [], partial: false, counts: "", record: `unavailable: ${result.error.slice(0, 200)}` };
  const lines = result.stdout.split("\n");
  const statAt = lines.findIndex((l) => /^ \d+ files? changed/.test(l));
  const stat = statAt >= 0 ? /^ (\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?$/.exec(lines[statAt]) : null;
  const partial = !stat && result.stdout.trim() !== "";
  // The file lines are the ones before the summary line (patch lines can look like them). A cut
  // stdout ends mid-line: drop that line.
  const head = stat ? lines.slice(0, statAt) : partial ? lines.slice(0, -1) : [];
  const files = head.map((l) => /^(?:\d+|-)\t(?:\d+|-)\t(.+)$/.exec(l)).filter(Boolean).map((m) => m[1]);
  const counts = stat ? `+${stat[2] || 0} -${stat[3] || 0} lines, ${stat[1]} files` : partial ? `${files.length}+ files` : "+0 -0 lines, 0 files";
  return { path: diffPath(round), files, partial, counts, record: `r${round}.diff (${counts})` };
}
// Paths a branch chose, in inline code, so a crafted name reads as data.
const pathList = (paths) => paths.map(inlineCode).join(", ");

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
    ? `The branch's changes are in ${diff.path}: the output of git diff --numstat --shortstat -p
origin/main...HEAD (${diff.counts}): one line per changed file (lines added, lines deleted, path), a
summary line, then the full diff (and anything git printed on stderr). The file holds at most its
first 1 MiB and ends in "..." when cut.
You cannot run git, so this file is how you see the change: read all of it with your read tool,
continuing with offset until the end (each read returns at most 2000 lines). You may skip the hunks
of generated files (lockfiles, build output). The watchdog_diff tool does not see commits; do not use it.
${diff.files.length || diff.partial ? `Changed files${diff.partial ? " (the first of them; the list at the top of the file has all)" : ""}: ${pathList(diff.files)}.` : "The diff is empty: nothing on this branch differs from main."}`
    : `The diff for this round could not be prepared (${diff.record}) and you cannot run git. Review ${files.length ? `the changed files: ${pathList(files)}` : "the files the spec says change"}.`;
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
// Parallel runs pass their own checks and still break each other once merged (#5). The host fetches
// origin, a Haiku worker merges origin/main into the branch, and the host records main and the
// branch head and runs every check; on a conflict or a failure, one Sonnet fix round and a re-check
// the same way. The code lens re-reviews a fix that touched non-test files. Never stops the run: a
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

const integrateSchema = statusSchema({
  merge: { type: "string", enum: ["merged", "up-to-date", "conflict"] },
  conflicts: { type: "array", items: { type: "string" } },
});
// What a "done" merge report carries: the conflicts when the merge stopped.
const integrateFields = (out) => ["merge"].concat(out.merge === "conflict" ? ["conflicts"] : []);

// `main`: the origin/main the host fetched. It is in the task so that a resume after main moved
// merges again instead of reusing the old merge.
function integrateRun(key, recheck, main) {
  return runs.run(key, {
    label: `${recheck ? "Re-check integration" : "Integrate main"} for issue #${issue}`,
    agent: "worker",
    model: HAIKU,
    cwd,
    outputSchema: integrateSchema,
    task: `${COMMON}

You are the INTEGRATION stage${recheck ? ", re-checking after the fix round" : ""}. ${MERGE_EXCEPTION}
Your only job is the merge. The workflow has fetched origin (origin/main is at ${main}) and runs
the checks itself after you: do not fetch, do not run any check, do not edit, stage or commit
anything else, and do not try to fix anything. Work in the foreground. Run from ${cwdQ}, exactly as written:
  ${mergeCmd}
If the merge stops on conflicts, run
  git -C ${cwdQ} diff --name-only --diff-filter=U
  git -C ${cwdQ} merge --abort
then report merge "conflict" and conflicts (the paths the first of those printed). Otherwise report
merge "up-to-date" if git printed "Already up to date.", else "merged". Report summary (one line)
and status "done". If the merge fails without conflicts, report status "blocked" and put the
command and its error in summary.`,
  });
}

// Every configured check on the host, one after another and each to the end: { checks, failures,
// error }. A check that exits nonzero or times out fails; one that cannot run at all is an error.
function runChecks(prefix) {
  return CHECKS.reduce((prev, c) => prev.then((acc) => hostStep(`${prefix}-${c.name}`).then((r) => {
    acc.checks[c.name] = r.ok ? "pass" : "fail";
    if (!r.ok && r.failed) acc.failures.push({ check: c.name, exit: r.exitCode, detail: r.error.slice(0, 200) });
    if (!r.ok && !r.failed && !acc.error) acc.error = `check ${c.name} could not run: ${r.error.slice(0, 200)}`;
    return acc;
  })), Promise.resolve({ checks: {}, failures: [], error: "" }));
}

// One integration attempt: fetch and origin/main (host), merge (agent), main and head (host), and
// unless the merge conflicted every check (host). { view, checks, failures }, or { error } when a step could not run.
function integrationAttempt(recheck) {
  const pre = recheck ? "host-recheck" : "host";
  return hostStep(`${pre}-fetch`).then((fetched) => {
    if (!fetched.ok) return { error: hostBlocked || `git fetch origin && git rev-parse --short origin/main: ${fetched.error.slice(0, 200)}` };
    const fetchedMain = fetched.stdout.trim().split("\n").pop();
    if (!/^[0-9a-f]{7,40}$/.test(fetchedMain)) return { error: `git rev-parse --short origin/main after the fetch: unexpected output` };
    return integrateRun(recheck ? "integrate-recheck" : "integrate", recheck, fetchedMain).then((result) => {
      const out = result.structuredOutput || {};
      const gap = doneGaps("integrate", out, integrateSchema, integrateFields(out));
      if (!result.ok || out.status !== "done" || gap) return { error: gap || reason(result) };
      return hostStep(`${pre}-heads`).then((heads) => {
        const [main, head] = heads.ok ? heads.stdout.trim().split("\n") : [];
        if (!main || !head) return { error: `git rev-parse --short origin/main HEAD: ${heads.ok ? "unexpected output" : heads.error.slice(0, 200)}` };
        const view = { main, head, merge: out.merge, conflicts: out.merge === "conflict" ? out.conflicts : [] };
        if (out.merge === "conflict") return { view, checks: {}, failures: [] };
        return runChecks(recheck ? "recheck" : "check").then((ran) => (ran.error ? { error: ran.error } : { view, checks: ran.checks, failures: ran.failures }));
      });
    });
  });
}

const failingChecks = (checks) => CHECKS.filter((c) => checks[c.name] !== "pass").map((c) => c.name);
const integrationPassed = (a) => a.view.merge !== "conflict" && !failingChecks(a.checks).length;
// The record's view of one complete attempt.
const integrationOf = (a) => ({
  main: a.view.main,
  head: a.view.head,
  merge: a.view.merge,
  conflicts: a.view.conflicts,
  failing: a.view.merge === "conflict" ? [] : failingChecks(a.checks),
  checks: a.checks,
});

// The PR's crucible record and the run's result: what integration did. After a fix round and a
// re-check, main, head, merge, conflicts, failing and checks are the re-check's, and firstAttempt
// keeps the first attempt's view when its conflicts or failing checks differ.
const integration = { status: "pass", main: null, head: null, merge: null, conflicts: [], failing: [], checks: {}, firstAttempt: null, fix: null, reReview: null, note: "" };
const first = await integrationAttempt(false);
if (first.error) {
  integration.status = "error";
  integration.note = first.error;
} else {
  const firstView = integrationOf(first);
  Object.assign(integration, firstView);
  if (!integrationPassed(first)) {
    const conflicted = first.view.merge === "conflict";
    const problem = conflicted
      ? `The merge conflicts in: ${integration.conflicts.join(", ")}. Nothing is merged yet. Run
  ${mergeCmd}
resolve every conflict, then commit the merge with
  ${commitCmd} --no-edit --cleanup=strip`
      : `The merge itself is committed, but these checks fail after it: ${integration.failing.join(", ")}. Each one's exit
code ("timeout" if it ran out of time) and the start of its output, cut to 200 characters:
${JSON.stringify(first.failures, null, 2)}
That is not the full output: run each failing check yourself to see it.`;
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
After review, merging origin/main (${integration.main}) into ${branch} broke it.
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
      const re = await integrationAttempt(true);
      if (re.error) {
        integration.status = "error";
        integration.note = `re-check: ${re.error}`;
        // The final merge is unknown: only the fix's checks and the first view are.
        const fixChecks = fixOut.checks || {};
        Object.assign(integration, { main: null, head: null, merge: null, conflicts: [], failing: failingChecks(fixChecks), checks: fixChecks, firstAttempt: firstView });
      } else {
        const final = integrationOf(re);
        Object.assign(integration, final);
        integration.status = integrationPassed(re) ? "pass" : "fail";
        const hit = (v) => JSON.stringify([v.conflicts, v.failing]);
        if (hit(firstView) !== hit(final)) integration.firstAttempt = firstView;
      }
      if (integration.fix.non_test_files.length) {
        const r = round + 1;
        const note = `This round reviews the INTEGRATION FIX. After the review rounds, origin/main (${firstView.main}) was merged
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
     the origin/main commit merged (main), the branch commit the checks ran on (head) and how it
     merged (merge: merged, up-to-date or conflict, naming the conflicts), each check's result
     after the merge, what the fix round did (fix; "none" when null) and the re-review round
     (reReview; "not needed" when null). These describe the final state (main, head and merge are
     null when the re-check failed); when firstAttempt is not null, also say what the first attempt hit before the fix round
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
  const unresolvedNote = open.length ? `\nUnresolved findings:\n${open.map((f) => `- ${inlineCode(f.id)}: ${inlineCode(f.problem)}`).join("\n")}` : "";
  const integrationNote = integration.note ? `\nIntegration: ${inlineCode(integration.note)}` : "";
  const flag = await flagHuman("flag-pr", `Stage: pr. ${pr.error || "No PR was opened (see the PR stage's output; a worktree on the wrong branch stops it)."}${unresolvedNote}${integrationNote}`);
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
