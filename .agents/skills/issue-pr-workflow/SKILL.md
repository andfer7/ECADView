---
name: issue-pr-workflow
description: Follow the user's branch, pull request, and approval workflow whenever implementing or fixing a repository issue.
---

# Issue and pull request workflow

1. Before changing files for an issue, create a dedicated branch from an up-to-date `master`. Use the `codex/` prefix and a descriptive issue identifier or name unless the user specifies another branch name. When continuing the same issue, use its existing branch. Preserve unrelated local changes; never implement an issue directly on `master`.
2. Complete the modification and run the relevant tests and checks. Resolve failures and inspect the final diff until there is reasonable confidence that the change works. If verification is blocked, explain the limitation and do not claim the change is ready.
3. Once the modification is complete and verified, commit and push the issue branch, then create a pull request targeting `master`. Describe the change and its validation, and provide the PR link to the user. Attach the PR to the current chat when the environment provides that capability.
4. The user must personally review and approve the pull request before it can be merged. Stop at the review stage while approval is pending. Passing checks, automated reviews, approval from someone else, silence, or the original request to implement the issue do not count as the user's approval.
5. After the user explicitly approves the current PR changes, merging that PR into `master` is authorized. Confirm that the approval covers the current revision, required checks pass, and there are no unresolved review requests or merge conflicts, then merge the approved PR. If substantive changes are needed after approval, have the user review and approve those changes before merging. Report the merge result.

If `master` is unavailable, ask the user which target branch to use before substituting another branch. If repository permissions, protection rules, or unavailable tooling block a required action, report the blocker and leave the work available for review; never bypass the approval requirement.
