# Disable, uninstall or remove dsh-win32

[中文：禁用、卸载与恢复](./uninstall.zh.md)

If a DSH upgrade leaves the old dsh-win32 plugin unusable, recovery must not depend on starting that host. From **0.17.14**, the standalone `disable` command can disconnect the legacy bundle offline. It does not load DSH or the installed plugin, run a package manager, or contact GitHub. This addresses [#92](https://github.com/sjh9714/dsh-win32/issues/92).

## Disable the legacy bundle without starting DSH

1. Close the affected DSH application and its sessions. Stop any profile package installation. Do not edit a running profile.
2. Identify the same profile and `DSH_HOME` used by that launcher. The default Web profile is `$DSH_HOME/profiles/web`; without `DSH_HOME`, the home is `%USERPROFILE%\.dsh`. Desktop can use an application-owned directory: confirm its actual location instead of assuming it is the `desktop` profile under this home.
3. Preview the exact manifest the command would change:

   ```powershell
   npx dsh-win32@0.17.14 disable --profile web
   ```

4. Check the printed path, then apply:

   ```powershell
   npx dsh-win32@0.17.14 disable --profile web --apply
   ```

For an application-owned profile outside the normal home, use its confirmed directory containing `package.json`:

```powershell
npx dsh-win32@0.17.14 disable --profile-dir "C:\your-confirmed-profile-directory"
npx dsh-win32@0.17.14 disable --profile-dir "C:\your-confirmed-profile-directory" --apply
```

Use either `--profile` or `--profile-dir`. The named profile defaults to `web`; it is never guessed from running processes. Linked profile directories/manifests and malformed or ambiguous JSON are refused. An absent profile is not initialized. If `package.json.lock` exists, the command refuses to take over that writer's lock: let the owner finish, or investigate an abandoned lock after all writers have stopped.

The preview writes nothing. Applying creates a unique `.dsh-win32-backup-*` directory **inside the selected profile**, saves the original `package.json` byte for byte, and removes only exact `dsh-win32` entries from `dsh.profile.bundles`. Other fields and their original text stay intact. The command prints the original backup path. Repeating it after deactivation makes no new backup or change.

The package remains installed. Dependencies, lockfiles, user patches, presets, conversations, credentials, BusyBox, shortcuts and package-manager settings are retained. This result confirms bundle deactivation, not that every custom configuration or session works. The profile patch is a separate layer; a warning about `cordis.patch.yml` or `cordis.yml` means the manual review below is still needed. The command does not search every custom `--patch` file or session snapshot.

`npx` may need to fetch the standalone CLI once. If you already have **0.17.14 or later** available locally, invoke its `dsh-win32` executable, or `node <that-package>/bin/cli.mjs disable ...`, for a fully offline run. Keep your existing package publication-age/build policy when acquiring it. If no working standalone CLI is available, use the manual procedure below.

## Manual recovery when no CLI can run

With DSH stopped, locate the actual profile directory and **copy its `package.json` and existing `cordis.patch.yml`/`cordis.yml` to a unique backup folder** before editing. Keep that backup private; profiles can contain credentials. Do not replace or delete the whole profile.

Open the existing `package.json` in a text editor. Inside **`dsh.profile.bundles` only**, remove the string `"dsh-win32"`. For example:

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-win32"]
```

becomes:

```json
["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
```

These are examples of the one array, not replacement manifests. Keep every other bundle, dependency and field. Save valid UTF-8 JSON without a BOM. Leaving `dependencies["dsh-win32"]` installed is fine while recovering; installed and activated are separate states in the [official profile loader](https://github.com/deepseek-ai/deepseek-harness/blob/46a7f68b0922371ce7144b668b90e377d8e799f4/packages/boot/app-boot/src/profile.ts).

If the bundle entry was already absent, or your profile has hand-written patches, review those separately:

- Search your backed-up profile patch/roster and any explicit launcher `--patch` files for `dsh-win32` or `subprocess-windows`.
- Older manual wiring may contain a pair: disabling the official `id: subprocess` row on Windows, then inserting `id: subprocess-windows` with `name: dsh-win32`. Remove only that known legacy pair together. Removing the inserted runtime alone can leave the official runtime disabled. Keep unrelated patch entries. Do not apply a blanket search-and-delete to custom compositions or change the permission policy.
- A custom roster can directly mount `dsh-win32/fs` or `dsh-win32/fs-confined`. Deactivating the profile bundle cannot rewrite that roster. Keep its backup and start a **new session using the official stock Minimal preset and Workspace Write** on current DSH. Do not continue the old `minimal-windows` or `minimal-windows-sandboxed` session as a migration test.

The two legacy presets live in `$DSH_HOME/.agent-presets/minimal-windows` and `minimal-windows-sandboxed` and may be shared by several profiles. To retire them, first confirm that no other profile/session needs them, then **move their complete directories to your backup outside `.agent-presets`**. Preserve all custom files and existing preset backups. Do not delete the whole `.agent-presets` directory. Renamed/custom copies need individual review.

## Uninstall the retained package after disabling it

Use the same installed DSH launcher and profile when its package command works:

```powershell
dsh plugin --profile web remove dsh-win32
```

Here `dsh` means your existing launcher, not a freshly downloaded host. If that entry point is still broken, use the **already installed pnpm** directly in the exact profile directory printed during the preview:

```powershell
pnpm --dir "C:\your-confirmed-profile-directory" remove dsh-win32
```

This is a separate package operation: it removes the dependency and updates that profile's lockfile/module tree. It does not require DSH to boot. Preserve the profile's pnpm settings and build/release-age policies; if removal fails, retain the error and backup rather than forcing a reinstall or deleting `node_modules`/the profile. The legacy bundle can remain disabled while removal is investigated.

Retiring a desktop `DeepSeek Harness` shortcut is optional: check its target first, then move only that shortcut to the Recycle Bin if it is no longer wanted. Current `setup` normally only checks the official stack and creates this shortcut; it does not install a legacy bundle. `npx` also does not itself globally install dsh-win32. If you explicitly installed the CLI globally, remove it separately with the same package manager, for example `npm uninstall --global dsh-win32` for an npm global install. Do not uninstall DSH, PowerShell, Git, or shared dependencies as part of this cleanup.

## Restore the backup

Stop DSH and profile package operations. Compare the printed backup with the current manifest first. If no later package/configuration changes need preserving, copy the saved `package.json` back over the same original file. If there have been later changes, merge only the intended bundle-list edit instead of replacing the newer manifest. This re-enables the old bundle and its compatibility limitations; it does not fix compatibility with a newer host. Restore moved preset directories only when their original destinations are free and their legacy host is still intended.

If restarting a new stock session still fails, report the exact host/CLI versions, the failed operation and a short redacted error in [#92](https://github.com/sjh9714/dsh-win32/issues/92). Do not post entire profiles, backup contents or credentials.
