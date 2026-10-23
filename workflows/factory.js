// Factory: spec (Opus) → implement (Sonnet) → review lenses (Opus, parallel)
// → revise ≤ maxRounds (Sonnet) → PR (Sonnet). See .pi/factory.md.
//
// args: { repo, issue, slug, worktree, branch, lenses?: string[], maxRounds?: number, seam?: boolean,
//         startAt?: "spec" | "implement" | "review", parent?: number }
// seam: the change is a shared foundation later issues build on (label `seam`); reviewers
// then rate inherited defects by blast radius.
// startAt: skip earlier stages. "implement" needs the spec already committed on the branch;
// "review" re-reviews an existing branch (e.g. after hand edits) and updates its PR if one exists.
// parent: tracking issue; the follow-up issue is added to it as a sub-issue.
// The caller creates `worktree` on `branch` before launching; every stage runs there.
// Whenever the run stops for a person, the issue or PR gets the `needs:human` label.

const OPUS = "claude-bridge/claude-opus-5-5";
const SONNET = "claude-bridge/claude-sonnet-5-5";
const HAIKU = "claude-bridge/claude-haiku-5-5";
const SPEC_URL =
  "https://raw.githubusercontent.com/seandavi/bioc-infrastructure/spec/mcp/proposal-mcp.qmd";

const repo = args.repo;
const issue = args.issue;
const cwd = args.worktree;
const branch = args.branch;
const lenses = args.lenses && args.lenses.length ? args.lenses : ["code"];
const maxRounds = args.maxRounds || 2;
const seam = !!args.seam;
const STAGES = ["spec", "implement", "review"];
const startAt = args.startAt || "spec";
if (STAGES.indexOf(startAt) < 0) throw new Error(`startAt must be one of ${STAGES.join(", ")}`);
const stageRuns = (stage) => STAGES.indexOf(startAt) <= STAGES.indexOf(stage);
const parent = args.parent || null;
const NEEDS_HUMAN = "needs:human";
const SEAM_NOTE = seam
  ? `\nThis change is a SHARED SEAM: later issues build adapters and modules on it. Rate by blast
radius, not by current reach: a defect every later caller would inherit or copy (a guard that can
be bypassed, a missing validation, a leaky contract) is at least "major", even if nothing reaches
it yet.`
  : "";
const specPath = `docs/specs/${issue}-${args.slug}.md`;

const COMMON = `
Repository: ${repo}, issue #${issue}. Working directory (a git worktree on branch ${branch}): ${cwd}
Read AGENTS.md in that directory first and follow it. The design spec for the whole project is
${SPEC_URL} (fetch it with curl if you need it).
Work only inside ${cwd}. Never touch main, never merge, never force-push, never git stash.
Commit with: git -c user.name="Sean Davis" -c user.email=seandavi@gmail.com commit
and add the trailer "Co-Authored-By: Claude <noreply@anthropic.com>".`;

// Project skills (.agents/skills) handed to stages that write or review Worker code. The built-in
// worker/reviewer agents set inheritSkills: false, so a child sees a skill only when named here.
// A missing skill is a warning, not a failure.
const BUILD_SKILLS = "workers-best-practices";
const LENS_SKILLS = { code: "workers-best-practices", security: "workers-best-practices" };

const LENS = {
  code: `CODE review. Correctness against the issue spec and its acceptance criteria; tests that
would actually catch a regression (fixtures, no network); the one-capability-two-transports rule
(no logic in transports/); deep modules with clear seams; type safety; dead code; dependency choices
against AGENTS.md. The spec and the code must agree: rules, interfaces and example snippets in the
spec match what the code does, because later issues copy the spec (a stale spec is "major").`,
  ux: `AGENT + DEVELOPER UX review. Tool names; descriptions that say what the tool answers and
when to use another tool instead; input/output schema clarity and defaults; error messages an agent
can act on; result size (≤ ~8 KB text) and pagination; provenance on every result; REST paths,
query params and OpenAPI quality; README/connection instructions for a first-time user.`,
  security: `SECURITY review. SSRF (no capability fetches a caller-supplied URL or host); input
validation and bounds; secret handling (code, fixtures, logs, CI); fork-PR CI safety (no secrets on
pull_request, no pull_request_target); Host/Origin allowlist; rate limiting; that nothing
non-public can be returned.`,
};

const statusSchema = (extra) => ({
  type: "object",
  required: ["status"],
  properties: Object.assign({ status: { type: "string", enum: ["done", "blocked"] } }, extra),
});
const checksSchema = {
  type: "object",
  properties: {
    tests: { type: "string", enum: ["pass", "fail", "n/a"] },
    typecheck: { type: "string", enum: ["pass", "fail", "n/a"] },
  },
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
    task: `${COMMON}

Do not change any file. Run:
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
  1. Read the issue: gh issue view ${issue} -R ${repo} --comments. Read the project spec and AGENTS.md.
  2. Write ${specPath}: Goal; Non-goals; Design (files to add/change, exported interfaces, zod
     schemas for every capability's input and output, MCP tool and REST route for each, upstream
     calls with example URLs and fixture files to record); Acceptance criteria as a testable
     checklist; Test plan; Risks. Be concrete enough that an implementer never has to choose a
     library or an interface. Verify package APIs you rely on (npm view, or read the package's docs)
     rather than guessing.
  3. Commit only that file ("Spec for #${issue}").
  Set status "blocked" only if a question has two reasonable answers with materially different
  outcomes that the issue and project spec do not settle; list them in blocking_questions.`,
  });
  specOut = spec.structuredOutput || {};
  if (!spec.ok || specOut.status !== "ready") {
    const questions = (specOut.blocking_questions || []).map((q) => `- ${q}`).join("\n");
    await flagHuman("flag-spec", `Stage: spec. ${questions ? `Blocking questions:\n${questions}` : `Error: ${spec.error || "no structured output"}`}`);
    return { stage: "spec", stopped: true, spec: specOut, error: spec.error || null };
  }
}

// ---- 2. Implement --------------------------------------------------------------------
let implOut = { status: "done", changed_files: [], checks: {}, skipped: true };
if (stageRuns("implement")) {
  const impl = await runs.run("implement", {
    label: `Implement issue #${issue}`,
    agent: "worker",
    model: SONNET,
    skill: BUILD_SKILLS,
    cwd,
    outputSchema: statusSchema({
      summary: { type: "string" },
      changed_files: { type: "array", items: { type: "string" } },
      checks: checksSchema,
    }),
    task: `${COMMON}

  You are the IMPLEMENT stage. Implement exactly ${specPath}; it is the contract. Do not redesign.
  Work in the foreground (never leave background processes running). Record fixtures by fetching
  the upstream URLs once with curl into test/fixtures/; tests must not use the network.
  Run the install, typecheck and test commands and fix failures. Commit in small, well-described
  commits. Report changed_files (paths relative to the repo root) and check results.
  Set status "blocked" if the spec is wrong or impossible; explain in summary.`,
  });
  implOut = impl.structuredOutput || {};
  if (!impl.ok || implOut.status !== "done") {
    await flagHuman("flag-implement", `Stage: implement. ${implOut.summary || impl.error || "no structured output"}`);
    return { stage: "implement", stopped: true, spec: specOut, implement: implOut, error: impl.error || null };
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
  return `${COMMON}

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
  }, LENS_SKILLS[lens] ? { skill: LENS_SKILLS[lens] } : {})));
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
    skill: BUILD_SKILLS,
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
Re-run typecheck and tests. Commit ("Address review round ${round} for #${issue}").
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
const checksFailing = checks.tests === "fail" || checks.typecheck === "fail";
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
     ${JSON.stringify(checks)}.${startAt !== "spec" ? ` Note that this run started at the ${startAt} stage.` : ""}
   ${open.length ? `- "Unresolved review findings": one bullet per finding from ${JSON.stringify(open)}.` : ""}
   - "Follow-ups": one line linking the follow-up issue from step 2 (omit if none).
4. If a PR for ${branch} already exists (gh pr view ${branch} -R ${repo}), replace its body with
   gh pr edit and keep its title${draft ? " and mark it draft (gh pr ready --undo)" : ""}. Otherwise:
   gh pr create -R ${repo} --base main --head ${branch} ${draft ? "--draft " : ""}with a title naming the change.
   Either way, add the label: gh pr edit ${branch} -R ${repo} --add-label ${NEEDS_HUMAN}
5. Report the PR URL and the follow-up issue number.`,
});
const prOut = pr.structuredOutput || {};

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
};
