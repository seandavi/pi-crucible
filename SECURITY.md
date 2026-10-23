# Security

pi-factory launches coding agents that run shell commands, push branches and edit GitHub issues
and pull requests with your credentials. A flaw here can therefore reach every repository that
uses the engine. Examples:

- a prompt or argument that lets issue text steer an agent outside its worktree;
- a stage that could merge, force-push or touch `main`;
- a way to inject a workflow script or widen the `pi-factory` resource's authority;
- secrets leaking into specs, commits, PR bodies or run receipts.

## Reporting

Please report privately through
[GitHub private vulnerability reporting](https://github.com/seandavi/pi-factory/security/advisories/new),
not in a public issue. Expect an acknowledgement within a week. Fixes land on `main`, which is
what every install tracks (`pi update` picks them up).

Only `main` is supported; there are no release branches.
