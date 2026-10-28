# Releasing

Maintainer procedure for publishing `dsh-win32` to npm. Every change to `master`, including the version bump, lands through a pull request.

## Branch rules

- `master` requires the `ci gate` check and an up-to-date branch. Before merging, run `gh pr update-branch <PR>` if the PR is behind and wait for CI to pass again.
- Admins can bypass these rules, so a direct push succeeds silently. Push to `master` only through a merged PR.
- Merge with squash. Use the PR title as the commit subject, in Conventional Commits form.

## Steps

1. Confirm `master` CI is green and that the change is user-facing. Docs and dev dependency updates alone do not need a release.
2. On a branch, run `npm version patch --no-git-tag-version` (or `minor`). This updates `package.json` and `package-lock.json`.
3. Run `npm ci`, `npm run build` and `npm test`. Check the contents with `npm pack --dry-run`.
4. Open a PR titled `chore(release): X.Y.Z` and squash-merge it once `ci gate` passes.
5. Pull `master`, tag the merge commit with `git tag vX.Y.Z` and push the tag.
6. Run `npm publish`. The `prepublishOnly` script builds and tests again.
7. Create the GitHub release with `gh release create vX.Y.Z --title vX.Y.Z --notes-file <file> --latest`.
8. Confirm the registry shows the version with `npm view dsh-win32 dist-tags`. The registry can take a few minutes to update after `npm publish` reports success.

## Release notes

Follow the shape of earlier releases.

- One opening sentence stating what the release fixes or adds.
- Bullets describing the user-visible behaviour change.
- A `Validation` paragraph listing the tests, build, audit and CI lanes that passed, and stating what the release does not fix or verify.
- Links to the PR and any related issues.
