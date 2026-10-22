before answering any request, mandatory:

pull main / branch, read repo readme, docs, invariants, and code overview, then answer the user prompt.

## Delivery workflow

The user authorizes the following completion workflow for this repository unless the current request says otherwise:

1. Implement changes on a feature or fix branch and verify the affected behavior.
2. Commit only task-owned files with Conventional Commits; preserve unrelated work.
3. Integrate the verified changes into `main`, check the combined result, and push `main` to `origin` without asking again. If the changes are already integrated, do not create a redundant merge.
4. Report the pushed commits and verification results. Do not stop at local commits and leave delivery unfinished.

This authorization does not include force pushes, destructive cleanup, manual releases, or changes to live installations or configuration. Report conflicts, failed checks, or remote access failures rather than bypassing them. Follow the release policy in README.md; do not edit CHANGELOG.md outside a release.
