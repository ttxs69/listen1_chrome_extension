# Listen 1 — Packaging Design Spec

**Date:** 2026-07-04
**Status:** Design approved, pending implementation

## Goal

Make the `listen1_chrome_extension` repo installable as a dev-mode Chrome MV3 and Firefox MV2 extension by adding a small Node-based packager. No changes to existing extension code.

## Non-Goals

- Publishing to Chrome Web Store or Firefox AMO (requires signing / review; out of scope).
- Bundling, transpiling, minifying, linting — the source tree is already shipped as-is.
- Cross-browser polyfills or migration tooling.
- CI/CD automation of the pack step.

## Constraints

- Cross-platform pack runs: must work on macOS, Linux, Windows where Node runs.
- Idempotent: running the packager multiple times must not corrupt the working tree.
- Idempotent on output: reruns overwrite previous zips of the same name.
- `git status` after a pack run must show zero changes outside `dist/`.

## Architecture

A single Node script (`scripts/pack.js`) is invoked once per target. It:

1. Parses `--target=chrome|firefox` from argv. Errors with exit code 1 on invalid input.
2. Reads the appropriate manifest, extracts `version`.
3. Walks the repo, building an in-memory file list with exclude rules applied.
4. For Firefox target, rewrites the entry name of `manifest_firefox.json` to `manifest.json` (no on-disk mutation).
5. Streams the surviving files into `dist/listen1-<browser>-<version>.zip` via `archiver`.
6. Prints a one-line success summary with the produced path.

## Files Added / Modified

### Modified
- `package.json`:
  - Add `archiver ^7.0.1` to `devDependencies`.
  - Add three scripts:
    - `"pack:chrome": "node scripts/pack.js --target=chrome"`
    - `"pack:firefox": "node scripts/pack.js --target=firefox"`
    - `"pack": "npm run pack:chrome && npm run pack:firefox"`

### Added
- `scripts/pack.js` — the packager (single file, ~80 lines).
- `docs/superpowers/specs/2026-07-04-chrome-extension-packaging-design.md` — this file.

### Excluded via `.gitignore` (already covered by existing rule)
- `dist/` is already in `.gitignore`. Output zips will not be committed.

## Exclude Rules

### Hard excludes (both targets)
- `.git/`, `.gitignore`, `.github/`
- `.eslintrc.json`, `.eslintcache`, `.prettierrc`
- `node_modules/`
- `dist/`
- `_metadata/`
- `package.json`, `package-lock.json`
- `scripts/`
- `README.md`, `README_EN.md`
- `LICENSE`
- `.DS_Store`, `.vscode/`

### Per-target excludes
- **Chrome build:** `manifest_firefox.json`
- **Firefox build:** none excluded by name — instead, `manifest_firefox.json` is *renamed* to `manifest.json` inside the archive via `archiver`'s `entryName` option. `manifest.json` is then excluded (it would conflict with the renamed entry).

## Implementation Outline (pack.js)

```js
#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

// Hard excludes apply to BOTH targets. Per-target rules add/subtract below.
const HARD_EXCLUDES = new Set([
  '.git', '.gitignore', '.github',
  '.eslintrc.json', '.eslintcache', '.prettierrc',
  'node_modules', 'dist', '_metadata',
  'package.json', 'package-lock.json',
  'scripts',
  'README.md', 'README_EN.md', 'LICENSE',
  '.DS_Store', '.vscode',
]);

const PER_TARGET = {
  chrome: {
    manifest: 'manifest.json',
    outputName: b => `listen1-chrome-${b}.zip`,
    // Chrome build ships only the MV3 manifest; drop the FF one.
    extraExcludes: ['manifest_firefox.json'],
    renames: {},
  },
  firefox: {
    manifest: 'manifest_firefox.json',
    outputName: b => `listen1-firefox-${b}.zip`,
    // Firefox loads `manifest.json` by that exact name. Drop the chrome
    // manifest under that name (it would shadow the rename) and rename
    // the firefox one into place.
    extraExcludes: ['manifest.json'],
    renames: { 'manifest_firefox.json': 'manifest.json' },
  },
};
```

(Full file written at implementation time, with: argv parsing, dir-walk with the exclude set applied as both top-level names and prefix matches, version extraction, archive creation, error handlers, exit codes, the summary line.)

## Output Contract

```
$ npm run pack:chrome
Packed dist/listen1-chrome-2.33.0.zip (87 files, 1.42 MB in 412 ms)
```

Exit codes:
- `0` success
- `1` invalid `--target`
- `2` manifest missing / no version
- `3` zip write failure

## Acceptance Criteria

1. `npm install` followed by `npm run pack` from a clean clone produces two zips in `dist/`.
2. Each zip, when extracted to a folder and loaded as "Load unpacked" (Chrome) or "Load Temporary Add-on" (Firefox), presents a working Listen 1 extension.
3. Running the script a second time produces the same named files without errors.
4. `git status` after `npm run pack` reports only `dist/` (which is gitignored), so the working tree is otherwise clean.
5. Zips do not contain `node_modules/`, `.git/`, dev config, or the off-target manifest.

## Install Steps (Documented, Not in Script)

### Chrome
1. `npm install`
2. `npm run pack:chrome`
3. Unzip: `unzip dist/listen1-chrome-<v>.zip -d listen1-chrome`
4. Visit `chrome://extensions` → enable Developer mode → **Load unpacked** → select the unzipped folder.

### Firefox
1. `npm install`
2. `npm run pack:firefox`
3. Unzip: `unzip dist/listen1-firefox-<v>.zip -d listen1-firefox`
4. Visit `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select the unzipped folder's `manifest.json`.

Note: Firefox temporary add-ons are removed on browser restart. Permanent install requires AMO signing, out of scope.

## Risks / Open Items

- **`archiver` is not yet installed.** First `npm install` will pull it. Confirm `archiver` license (BSD-3-Clause) is acceptable alongside the repo's MIT.
- **No automated test for the produced zip.** A manual smoke test in Chrome + Firefox is the only check that the extension loads. Could add a `--dry-run` flag later that prints the file list without writing.
- **Long path support on Windows.** `archiver` handles it; not a concern.
