# Working on En-GYM

On Windows, double-click **Start En-GYM.cmd** in the checkout to prepare the private development runtime, speech tools and dependencies. Closing its console stops the development server. To use a disposable profile, set `FIELDWORK_DATA` to an empty directory before starting the development server. The installed app has its own profile at `%LOCALAPPDATA%\En-GYM\user`.

With the private runtime first on PowerShell’s path, the normal checks are:

```powershell
$env:Path = "$PWD\.work\node-win;$env:Path"
npm run build
npm test
node scripts/check-installed-session.mjs
node scripts/vocabulary-check.mjs
node scripts/check-site.mjs
```

Browser checks use Chrome. Set `FIELDWORK_CHROME` to a compatible browser executable if needed. To refresh the website screenshots after building the interface, run `node scripts/capture-site.mjs`. It uses a temporary database with example answers.

## Package a Windows build

Use the official x64 Node 24.22.2 runtime. In Windows PowerShell run `.\scripts\package-windows.ps1`; the resulting installer is `.work/release/En-GYM-Setup.exe`. The script prepares Inno Setup 6.7.4, or accepts `-CompilerPath` for a portable ISCC.exe. Development tools, learner profiles and signing keys stay outside the packaged payload. The installed app pins the public key from `scripts/release-trust.json`.

## Publish from GitHub

1. Configure GitHub Pages with **GitHub Actions** as its source. Configure a protected **stable** environment for publishing from `main`. Ordinary pushes and pull requests run **Check En-GYM**.
2. Use the established publisher key for this application. Keep a secured offline backup of the root private key. Put the contents of `root.pub` and `delegation.b64` in the repository variables `EN_GYM_ROOT_PUBLIC_KEY` and `EN_GYM_DELEGATION_B64`. Put the contents of `release.pem` in the **stable** environment secret `EN_GYM_RELEASE_PRIVATE_KEY`. Never commit private keys. A fork under a new publisher can create its own hierarchy with `node scripts/release-keys.mjs init <private-directory-outside-the-checkout>` and pin its public key before its first release.
3. For an application release, set the version in package.json and the lockfile. For a speech update, update the pinned model assets, their hashes and the component version in `scripts/release-versions.json`. Test the installer, an upgrade from an earlier internal build, and a saved speaking recording in a disposable Windows profile.
4. Run **Publish stable release** from `main` and choose app or speech. The workflow builds the files, signs their catalog and publishes the release. Speech-only releases keep the same installer. Renew the signed catalog before its expiry, and renew the delegation before its own expiry.
5. On a clean Windows x64 installation, download **En-GYM-Setup.exe** from the website’s actual download URL. Install, open the desktop shortcut, record a speaking answer, quit via the tray, reopen and play the answer from History. Also check occupied port handling and recovery from failed downloads and updates.
6. After that check, run **Publish website** with the SHA-256 of the tested download (`Get-FileHash .\En-GYM-Setup.exe`). The workflow verifies the current public installer against the signed catalog and that hash before enabling the download page. Source for the site lives in `site/`.
