# Branch protection — manual setup required

**Status: NOT configured.** This has to be done by hand, and this file exists so it is a
five-minute task rather than an investigation.

## Why it is not automated

Both GitHub write paths were attempted and both are refused for the token available in
this environment:

```
PUT  /repos/Prakash2571/{repo}/branches/main/protection   -> 403
POST /repos/Prakash2571/{repo}/rulesets                   -> 403
```

Reads work (`GET /rulesets` returns `[]`, confirming no ruleset exists), so this is a
permission limit on repository-settings writes, not a missing feature or a malformed
request. Nothing in the codebase can grant itself that authority — a workflow cannot
protect the branch it runs on.

Until this is applied, `main` in all three repositories can be force-pushed and deleted,
and a red CI run does not block the merge button.

## Apply this, per repository

**Settings → Rules → Rulesets → New branch ruleset** (or Settings → Branches → Add rule).

Name: `main protection`
Enforcement: **Active**
Target: **Default branch**

Rules to enable:

- [x] **Restrict deletions** — `main` cannot be deleted
- [x] **Block force pushes** — history cannot be rewritten
- [x] **Require a pull request before merging**
  - Required approvals: `0` (single maintainer; the point here is the checks, not review)
  - [x] Require conversation resolution before merging
- [x] **Require status checks to pass**
  - [x] Require branches to be up to date before merging
  - Add the checks listed below **exactly** as written
- [ ] Bypass list: **leave empty**

An empty bypass list is deliberate. With admin bypass enabled, the owner — who is the
only person pushing — can still force-push by accident, which is most of what this
protects against. If a ruleset ever locks out a legitimate merge, an admin can edit or
delete the ruleset itself, so there is no lockout risk to hedge against.

## Required status checks

The names must match the **job name** in the workflow, not the file or step name.

### Trademart_B

| Check | Workflow |
| --- | --- |
| `typecheck, test, build` | `.github/workflows/ci.yml` |
| `docker image` | `.github/workflows/ci.yml` |
| `compose config` | `.github/workflows/ci.yml` |
| `no credentials in source` | `.github/workflows/secret-scan.yml` |

### Trademart_F

| Check | Workflow |
| --- | --- |
| `typecheck, lint, test, build` | `.github/workflows/ci.yml` |
| `docker image` | `.github/workflows/ci.yml` |
| `no credentials in source` | `.github/workflows/secret-scan.yml` |

> This job was named `typecheck, build`, then `typecheck, test, build`, and is now
> `typecheck, lint, test, build`. A stale required check never reports and blocks every
> merge forever, so if a rule already exists, update the name rather than adding to it.

### Kanay-Store

| Check | Workflow |
| --- | --- |
| `typecheck, lint, test, build` | `.github/workflows/ci.yml` |
| `docker image` | `.github/workflows/ci.yml` |
| `no credentials in source` | `.github/workflows/secret-scan.yml` |

## Verifying it works

1. Push a branch with a deliberate type error and open a PR — the merge button must be
   blocked.
2. From a clone, try `git push --force origin main` — it must be rejected.
3. `gh api repos/Prakash2571/{repo}/rulesets` must no longer return `[]`.

## One thing to know before enabling it

Both frontend CI configurations also run a **secret scan of the built bundle**, which is a
separate job in `secret-scan.yml`. If you want that to gate merges too, add its job name
as well. It is listed as optional here only because a bundle scan needs a successful build
first, so it is already covered indirectly by the build check failing.
