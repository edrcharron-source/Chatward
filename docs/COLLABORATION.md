# Working together (three people, three Claudes)

Caleb, Jacob and Ed each drive their own Claude against this repo, often at the same time. These rules keep the agents from doing the same work twice, overwriting each other, or breaking `develop`. Branching and CI are in [PIPELINE.md](PIPELINE.md); this file is how to use them.

If you are an agent: follow this file without being asked. Where your person tells you otherwise in the session, they win, but say which rule you are skipping.

## 1. Claim before you code
GitHub issues are the lock. Before writing code:

1. Search open issues and open pull requests (drafts too) for the same feature, bug or files. If someone else already has it, stop and tell your person; don't start a parallel version.
2. If nothing exists, open an issue (one line of what and which area is enough). If one exists and is unassigned, take it.
3. Assign the issue to your person and add the `in-progress` label.
4. Open a **draft** pull request into `develop` as soon as you have the first commit, with `Closes #<issue>` in the body. The draft is how the other agents see what files you are touching.

A claim with no commits or comments for 48 hours is stale. Comment on the issue asking if it's still being worked on; take it over only after the owner says so or a further 24 hours pass with no answer.

## 2. Branches
- Branch from the latest `origin/develop`, never from `main` or another person's branch.
- If you can choose the name, use `<person>/<short-topic>`, for example `caleb/voice-bitrate` or `jacob/fix-gif-search`. If your environment assigns the branch name (cloud sessions use `claude/...`), keep it; the issue and PR assignee say whose it is.
- One task per branch. Never push to a branch another person or agent created, unless its owner asked you to.

## 3. Keep pull requests small
- One feature or fix per PR. Aim for under ~400 changed lines, not counting `package-lock.json` or generated files. Split bigger work into PRs that each leave `develop` working.
- Don't fold drive-by refactors, renames or reformatting into a feature PR. They touch files nobody expected and cause conflicts for the other two. Open a separate small PR instead.
- Run `npm run typecheck` and the e2e tests (`npm run test:e2e -w @chatward/server`, `npm run test:e2e-client -w @chatward/client`) before marking a PR ready.
- PR title is what lands on `develop` (squash merge), so write it as the commit you want to read later.

## 4. Stay current with develop
Bring in `develop` when you start a session on an existing branch, before marking a PR ready, and whenever GitHub says the branch is out of date or conflicting:

```
git fetch origin develop
git merge origin/develop
```

Merging (not rebasing) is the default because it never needs a force push, and the squash merge flattens the history anyway. Rebasing your own branch is fine if you prefer; push with `--force-with-lease`, never plain `--force`, and never rebase a branch someone else also pushes to.

## 5. Shared files (conflict hotspots)
These files are touched by almost every feature. Keep edits to them minimal and additive, and mention them in the PR description so the others know.

| File | Rule |
| --- | --- |
| `packages/server/src/db.ts` (schema + migrations) | Never edit or reorder an existing `CREATE TABLE` in a way an existing database won't get. Add columns by appending a new guarded migration at the end of the migration section (`PRAGMA table_info` check, then `ALTER TABLE ... ADD COLUMN`), the same as the ones already there. Live data on lebserver depends on this. |
| `package-lock.json` | Never hand-edit or hand-resolve. On conflict, take develop's version (`git checkout origin/develop -- package-lock.json`) and run `npm install` to regenerate it. Add new dependencies in their own small PR when you can. |
| `packages/shared/**`, `docs/CONTRACT.md` | The contract client and server both build on. Only add fields and messages; don't rename or remove without asking your person, because another branch may be using them. |
| `styles/theme.css`, `styles/layout.css` | Add new tokens at the end of the relevant block; don't reorder or rename existing ones. A PR meant to change the look needs the `visual-change` label (see [SKINS.md](SKINS.md)). |
| `App.tsx`, `state/session.ts`, `state/settings.ts`, `main/`, `preload/` | Central wiring. Keep the change to the few lines that hook your feature in; put the feature itself in its own files. |
| root `package.json` `version` | Only changed by whoever cuts a release, never in a feature PR. |
| `.github/**`, `deploy/**` | CI, rulesets and deployment. Change only when that is the task, in its own PR. |

## 6. Merging
- **Into `develop`:** squash merge, after `typecheck` and `e2e` pass. An agent may merge its own PR into `develop` only when its person has said to; otherwise mark it ready and leave it for a human. Don't merge another person's PR.
- **Into `main`:** a human opens and merges the `develop` → `main` PR, with a merge commit, after trying the test installer from the `develop` build. Agents never open, approve or merge PRs into `main`, and never push to `main` or `develop` directly.
- After a merge, close the issue (the `Closes #` line does this) and remove `in-progress`.

## 7. lebserver and deployment
The live server (chat.lebserver.com, Caleb's home box) is Caleb's. Don't SSH to it, copy code onto it, restart it, or change its config, DNS, ports or firewall unless Caleb asked for it in that session. Changes to `deploy/home/` or `docs/HOME_SERVER.md` that would change what runs there need Caleb's review on the PR. A merge to `develop` or `main` does not deploy anything by itself.

## 8. When things collide
- **Merge conflict in your branch:** resolve it yourself, keeping both sides' intent. If you can't tell what the other change was for, read its PR, and if still unsure, ask your person instead of guessing. Re-run typecheck and tests after resolving.
- **Two PRs doing overlapping work:** the one opened second stops and comments on the first. The two people decide which continues; the other is closed or rebuilt on top.
- **`develop` is red and it isn't your change:** don't pile fixes into your feature PR. Check whether someone's already on it (open PRs, issues); if not, open a small fix PR and say so on the PR or issue that broke it.
- **You need a change in a file another open PR is rewriting:** comment on that PR and wait for it to land, or keep your change to a line or two and flag it.
- Never resolve a conflict by deleting the other person's code, force pushing over their commits, or disabling a test.
