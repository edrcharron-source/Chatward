# Branches and CI

Three people work on this repo, each with their own Claude, so changes go through two branches:

```
feature branch --(PR, squash)--> develop --(PR, merge commit)--> main
```

- **Feature branches:** one per task, branched from `develop`. CI runs on the pull request, not on every push to the branch.
- **develop:** PRs are squash-merged, so each feature lands as one commit. `typecheck` and `e2e` must pass first.
- **main:** only takes PRs from `develop`, merged with a merge commit. A squash here would give main commits that develop does not have, and every later develop to main PR would drift further.

## Test installers
When `typecheck` and `e2e` pass on a push to `develop` or `main`, the CI workflow also builds the unsigned Windows installer.

- Find it under Actions → CI → the run → **Artifacts**, named `Chatward-Setup-<branch>-<commit>`.
- GitHub deletes it after **7 days**. Change `retention-days` in `.github/workflows/ci.yml` to keep them longer.
- A newer push to the same branch cancels a run that is still going, so only the latest commit gets an installer.
- Run it on any branch by hand: Actions → CI → **Run workflow**.

Real releases still go through the Release workflow (see [UPDATES.md](UPDATES.md)); its in-between artifacts are kept for 1 day, since the GitHub Release holds the files.

## One-time GitHub settings (needs a repo admin)
The rules live in `.github/rulesets/` but GitHub only applies them once they are imported.

1. **Settings → General → Pull Requests:** tick **Allow squash merging** and **Allow merge commits**, untick **Allow rebase merging**. Tick **Automatically delete head branches** so merged feature branches don't pile up.
2. **Settings → Rules → Rulesets → New ruleset → Import a ruleset:** pick `.github/rulesets/develop.json`, check it, then **Create**.
3. Do the same with `.github/rulesets/main.json`.

Nobody can bypass these rules, admins included. To allow yourself to push straight to a branch in an emergency, add **Repository admin** under **Bypass list** in that ruleset.
