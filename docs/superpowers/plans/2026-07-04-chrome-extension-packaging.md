# Listen 1 Extension Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Node-based packager that produces `dist/listen1-chrome-<version>.zip` and `dist/listen1-firefox-<version>.zip` from the existing source tree, plus three npm scripts to invoke it.

**Architecture:** A single Node script at `scripts/pack.js` walks the repo, applies a fixed exclude set plus per-target exclusions, and streams the surviving files into a version-named zip via `archiver`. The Firefox build renames `manifest_firefox.json` → `manifest.json` inside the archive entry name (no on-disk mutation). `package.json` gains three scripts and one devDependency.

**Tech Stack:** Node.js (built into the repo via the `node` binary the developer already needs), `archiver ^7.0.1` for zipping, plain JS (CommonJS) — no transpile step. No test runner is required: we use node's built-in `assert` and shell-out smoke tests, since this is a one-shot CLI tool, not a library.

## Global Constraints

- Single new file: `scripts/pack.js`.
- Three npm scripts: `pack:chrome`, `pack:firefox`, `pack`.
- One devDep: `archiver ^7.0.1`.
- Output dir: `dist/` (already gitignored).
- Exit codes: `0` success; `1` invalid `--target`; `2` manifest/unreadable/no version; `3` zip write failure.
- Filename pattern: `listen1-<browser>-<version>.zip` where `<version>` is read from the shipped manifest.
- Idempotent: reruns overwrite zips of the same name; no on-disk source mutation.
- After `npm run pack`, `git status` must show zero changes outside `dist/`.

---

## File Structure

| File              | Status      | Responsibility                                                                                               |
| ----------------- | ----------- | ------------------------------------------------------------------------------------------------------------ |
| `scripts/pack.js` | **Create**  | One CLI script. Reads argv, walks repo, applies excludes, applies per-target rename, streams zip to `dist/`. |
| `package.json`    | **Modify**  | Add `archiver` to `devDependencies`. Add three `pack*` scripts.                                              |
| `.gitignore`      | (no change) | Already excludes `dist/`.                                                                                    |
| `dist/`           | (runtime)   | Gitignored, created by the script.                                                                           |

No tests/ directory needed: this is a CLI tool, exercised by running it and inspecting the produced zip. We add a `--dry-run` mode for fast feedback (Task 4) and a smoke-test step (Task 6).

---

### Task 1: Install archiver and confirm shape

**Files:**

- Modify: `package.json` (add devDependency)
- Create: `node_modules/` (via npm install, gitignored)

**Goal:** Get `archiver` available via `require('archiver')` so we can build against it.

- [ ] **Step 1: Add archiver to devDependencies**

Edit `package.json`. In the `devDependencies` block, add a comma after the existing last entry (`"prettier": "^2.3.2"`) and append:

```json
    "archiver": "^7.0.1"
```

The block should read:

```json
  "devDependencies": {
    "archiver": "^7.0.1",
    "eslint": "^7.30.0",
    "eslint-config-airbnb-base": "^14.2.1",
    "eslint-config-prettier": "^8.3.0",
    "eslint-plugin-import": "^2.23.4",
    "husky": "^4.3.8",
    "lint-staged": "^10.5.4",
    "prettier": "^2.3.2"
  },
```

- [ ] **Step 2: Install**

Run: `npm install`
Expected: completes without error, prints something like `added 1 package` (archiver has zero deps of its own).

- [ ] **Step 3: Verify archiver is loadable**

Run:

```bash
node -e "console.log(typeof require('archiver'))"
```

Expected output: `function`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add archiver devDependency for packaging"
```

---

### Task 2: Create empty scripts/ directory and scaffold pack.js

**Files:**

- Create: `scripts/pack.js` (initially a stub that exits 0)

**Interfaces:**

- Consumes: nothing yet.
- Produces: a binary that prints usage when args are missing, exits 1 on `--target` validation failure, exits 0 on valid input.

- [ ] **Step 1: Create the file**

Create `scripts/pack.js` with the following exact contents:

```js
#!/usr/bin/env node
'use strict';

function parseArgs(argv) {
  const targetArg = argv.find((a) => a.startsWith('--target='));
  if (!targetArg) return { ok: false, reason: 'missing --target' };
  const target = targetArg.slice('--target='.length);
  if (target !== 'chrome' && target !== 'firefox') {
    return {
      ok: false,
      reason: `invalid --target=${target} (expected chrome|firefox)`,
    };
  }
  return { ok: true, target };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`pack.js: ${parsed.reason}`);
    console.error('Usage: node scripts/pack.js --target=chrome|firefox');
    process.exit(1);
  }
  console.log(`pack.js: target=${parsed.target} (stub)`);
  process.exit(0);
}

main();
```

- [ ] **Step 2: Smoke check invalid target**

Run: `node scripts/pack.js --target=edge`
Expected output (stderr): `pack.js: invalid --target=edge (expected chrome|firefox)`
Then exit code 1.

Run: `echo $?` immediately after to confirm `1`.

- [ ] **Step 3: Smoke check missing target**

Run: `node scripts/pack.js`
Expected output (stderr): `pack.js: missing --target`
Exit code 1.

- [ ] **Step 4: Smoke check valid chrome target (stub)**

Run: `node scripts/pack.js --target=chrome`
Expected output: `pack.js: target=chrome (stub)`
Exit code 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/pack.js
git commit -m "feat(pack): scaffold pack.js with argv parsing"
```

---

### Task 3: Add version extraction from the right manifest

**Files:**

- Modify: `scripts/pack.js`

**Interfaces:**

- Consumes: a target string (`chrome` or `firefox`).
- Produces: a `version` string read from `manifest.json` (chrome target) or `manifest_firefox.json` (firefox target).

- [ ] **Step 1: Replace the file**

Overwrite `scripts/pack.js` with:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

const TARGET_INFO = {
  chrome: { manifest: 'manifest.json' },
  firefox: { manifest: 'manifest_firefox.json' },
};

function parseArgs(argv) {
  const targetArg = argv.find((a) => a.startsWith('--target='));
  if (!targetArg) return { ok: false, reason: 'missing --target' };
  const target = targetArg.slice('--target='.length);
  if (!TARGET_INFO[target]) {
    return {
      ok: false,
      reason: `invalid --target=${target} (expected chrome|firefox)`,
    };
  }
  return { ok: true, target };
}

function readVersion(target) {
  const manifestPath = path.join(REPO_ROOT, TARGET_INFO[target].manifest);
  if (!fs.existsSync(manifestPath)) {
    console.error(`pack.js: missing manifest at ${manifestPath}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(
      `pack.js: manifest at ${manifestPath} is not valid JSON: ${e.message}`
    );
    process.exit(2);
  }
  if (
    !parsed ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    console.error(
      `pack.js: manifest at ${manifestPath} has no "version" field`
    );
    process.exit(2);
  }
  return parsed.version;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`pack.js: ${parsed.reason}`);
    console.error('Usage: node scripts/pack.js --target=chrome|firefox');
    process.exit(1);
  }
  const version = readVersion(parsed.target);
  console.log(`pack.js: target=${parsed.target} version=${version}`);
  process.exit(0);
}

main();
```

- [ ] **Step 2: Verify chrome target reads version**

Run: `node scripts/pack.js --target=chrome`
Expected output: `pack.js: target=chrome version=2.33.0`
Exit code 0.

- [ ] **Step 3: Verify firefox target reads version**

Run: `node scripts/pack.js --target=firefox`
Expected output: `pack.js: target=firefox version=2.33.0`
Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/pack.js
git commit -m "feat(pack): extract version from the target manifest"
```

---

### Task 4: Implement the file walker with exclude rules

**Files:**

- Modify: `scripts/pack.js`

**Interfaces:**

- Consumes: a target string.
- Produces: an array of `{ absPath, relPath }` records covering every file the zip should contain (manifest rename applied as path rewriting, not on disk). Add `--dry-run` mode that prints the list and exits 0 instead of zipping.

- [ ] **Step 1: Replace the file**

Overwrite `scripts/pack.js` with:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Top-level names that are never shipped, for either target.
const HARD_EXCLUDES = new Set([
  '.git',
  '.gitignore',
  '.github',
  '.eslintrc.json',
  '.eslintcache',
  '.prettierrc',
  'node_modules',
  'dist',
  '_metadata',
  'package.json',
  'package-lock.json',
  'scripts',
  'README.md',
  'README_EN.md',
  'LICENSE',
  '.DS_Store',
  '.vscode',
]);

const PER_TARGET = {
  chrome: {
    manifest: 'manifest.json',
    outputName: (v) => `listen1-chrome-${v}.zip`,
    extraExcludes: ['manifest_firefox.json'],
    renames: {},
  },
  firefox: {
    manifest: 'manifest_firefox.json',
    outputName: (v) => `listen1-firefox-${v}.zip`,
    // The chrome manifest must not collide with the renamed entry name.
    extraExcludes: ['manifest.json'],
    renames: { 'manifest_firefox.json': 'manifest.json' },
  },
};

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const remaining = argv.filter(
    (a) => !a.startsWith('--dry-run') && a !== '--dry-run'
  );
  const targetArg = remaining.find((a) => a.startsWith('--target='));
  if (!targetArg) return { ok: false, reason: 'missing --target' };
  const target = targetArg.slice('--target='.length);
  if (!PER_TARGET[target]) {
    return {
      ok: false,
      reason: `invalid --target=${target} (expected chrome|firefox)`,
    };
  }
  return { ok: true, target, dryRun };
}

function readVersion(target) {
  const manifestPath = path.join(REPO_ROOT, PER_TARGET[target].manifest);
  if (!fs.existsSync(manifestPath)) {
    console.error(`pack.js: missing manifest at ${manifestPath}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(
      `pack.js: manifest at ${manifestPath} is not valid JSON: ${e.message}`
    );
    process.exit(2);
  }
  if (
    !parsed ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    console.error(
      `pack.js: manifest at ${manifestPath} has no "version" field`
    );
    process.exit(2);
  }
  return parsed.version;
}

function walkRepo(root, exclusions) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue; // skip unreadable directories
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      const top = rel.split(path.sep)[0];
      if (exclusions.has(top)) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push({ absPath: abs, relPath: rel.split(path.sep).join('/') });
      }
    }
  }
  return out;
}

function buildFileList(target) {
  const exclusions = new Set(HARD_EXCLUDES);
  for (const name of PER_TARGET[target].extraExcludes) exclusions.add(name);
  const files = walkRepo(REPO_ROOT, exclusions);
  // Apply renames (manifest).
  return files.map((f) => {
    const renamed = PER_TARGET[target].renames[f.relPath];
    return renamed ? { ...f, relPath: renamed } : f;
  });
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`pack.js: ${parsed.reason}`);
    console.error(
      'Usage: node scripts/pack.js --target=chrome|firefox [--dry-run]'
    );
    process.exit(1);
  }
  const version = readVersion(parsed.target);
  const files = buildFileList(parsed.target);
  if (parsed.dryRun) {
    for (const f of files) console.log(f.relPath);
    console.error(
      `pack.js: ${files.length} files would be packed (dry run, version=${version})`
    );
    process.exit(0);
  }
  console.log(
    `pack.js: target=${parsed.target} version=${version} files=${files.length} (stub — not yet zipping)`
  );
  process.exit(0);
}

main();
```

- [ ] **Step 2: Dry-run chrome — verify manifest_firefox.json absent**

Run:

```bash
node scripts/pack.js --target=chrome --dry-run | grep -E 'manifest|_metadata|node_modules|^scripts/' || true
```

Expected output: empty (no matches). The excluded files must not appear.

- [ ] **Step 3: Dry-run chrome — verify keys files present**

Run:

```bash
node scripts/pack.js --target=chrome --dry-run | grep -E '^(manifest\.json|js/background\.js|css/cover\.css|listen1\.html|images/logo\.png)$'
```

Expected: all five lines printed (every grep match exists in the list).

- [ ] **Step 4: Dry-run firefox — verify manifest.json comes from the rename**

Run:

```bash
node scripts/pack.js --target=firefox --dry-run | grep -c '^manifest\.json$'
```

Expected: prints `1` (the chrome manifest is excluded; the renamed firefox one fills the slot).

Run:

```bash
node scripts/pack.js --target=firefox --dry-run | grep -c '^manifest_firefox\.json$'
```

Expected: prints `0` (the original filename should not appear under that name).

- [ ] **Step 5: Dry-run both — verify no dev junk**

Run:

```bash
node scripts/pack.js --target=chrome --dry-run | grep -E '^(node_modules|\.git/|dist/|_metadata|package\.json|package-lock\.json|scripts/|README\.md|LICENSE|\.eslintrc\.json)$' || true
```

Expected: empty.

- [ ] **Step 6: Commit**

```bash
git add scripts/pack.js
git commit -m "feat(pack): walk repo with exclude rules and per-target renames"
```

---

### Task 5: Wire up archiver and produce the actual zip

**Files:**

- Modify: `scripts/pack.js`

**Interfaces:**

- Consumes: a target string, the prepared file list.
- Produces: a zip at `dist/listen1-<browser>-<version>.zip`. Prints a one-line summary; sets exit code 3 on write failure.

- [ ] **Step 1: Replace the file**

Overwrite `scripts/pack.js` with:

```js
#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const REPO_ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(REPO_ROOT, 'dist');

// Top-level names that are never shipped, for either target.
const HARD_EXCLUDES = new Set([
  '.git',
  '.gitignore',
  '.github',
  '.eslintrc.json',
  '.eslintcache',
  '.prettierrc',
  'node_modules',
  'dist',
  '_metadata',
  'package.json',
  'package-lock.json',
  'scripts',
  'README.md',
  'README_EN.md',
  'LICENSE',
  '.DS_Store',
  '.vscode',
]);

const PER_TARGET = {
  chrome: {
    manifest: 'manifest.json',
    outputName: (v) => `listen1-chrome-${v}.zip`,
    extraExcludes: ['manifest_firefox.json'],
    renames: {},
  },
  firefox: {
    manifest: 'manifest_firefox.json',
    outputName: (v) => `listen1-firefox-${v}.zip`,
    // The chrome manifest must not collide with the renamed entry name.
    extraExcludes: ['manifest.json'],
    renames: { 'manifest_firefox.json': 'manifest.json' },
  },
};

function parseArgs(argv) {
  const dryRun = argv.includes('--dry-run');
  const remaining = argv.filter((a) => a !== '--dry-run');
  const targetArg = remaining.find((a) => a.startsWith('--target='));
  if (!targetArg) return { ok: false, reason: 'missing --target' };
  const target = targetArg.slice('--target='.length);
  if (!PER_TARGET[target]) {
    return {
      ok: false,
      reason: `invalid --target=${target} (expected chrome|firefox)`,
    };
  }
  return { ok: true, target, dryRun };
}

function readVersion(target) {
  const manifestPath = path.join(REPO_ROOT, PER_TARGET[target].manifest);
  if (!fs.existsSync(manifestPath)) {
    console.error(`pack.js: missing manifest at ${manifestPath}`);
    process.exit(2);
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (e) {
    console.error(
      `pack.js: manifest at ${manifestPath} is not valid JSON: ${e.message}`
    );
    process.exit(2);
  }
  if (
    !parsed ||
    typeof parsed.version !== 'string' ||
    parsed.version.length === 0
  ) {
    console.error(
      `pack.js: manifest at ${manifestPath} has no "version" field`
    );
    process.exit(2);
  }
  return parsed.version;
}

function walkRepo(root, exclusions) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      const top = rel.split(path.sep)[0];
      if (exclusions.has(top)) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push({ absPath: abs, relPath: rel.split(path.sep).join('/') });
      }
    }
  }
  return out;
}

function buildFileList(target) {
  const exclusions = new Set(HARD_EXCLUDES);
  for (const name of PER_TARGET[target].extraExcludes) exclusions.add(name);
  const files = walkRepo(REPO_ROOT, exclusions);
  return files.map((f) => {
    const renamed = PER_TARGET[target].renames[f.relPath];
    return renamed ? { ...f, relPath: renamed } : f;
  });
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function pack(target, version, files) {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });
  const outPath = path.join(DIST_DIR, PER_TARGET[target].outputName(version));
  const output = fs.createWriteStream(outPath);
  const archive = archiver('zip', { zlib: { level: 9 } });
  let failed = false;
  output.on('close', () => {
    if (failed) return;
    console.log(
      `Packed ${path.relative(REPO_ROOT, outPath)} (${
        files.length
      } files, ${formatBytes(archive.pointer())})`
    );
    process.exit(0);
  });
  output.on('error', (err) => {
    failed = true;
    console.error(`pack.js: write stream error: ${err.message}`);
    process.exit(3);
  });
  archive.on('error', (err) => {
    failed = true;
    console.error(`pack.js: archive error: ${err.message}`);
    process.exit(3);
  });
  archive.on('warning', (err) => {
    if (err.code === 'ENOENT') {
      console.error(`pack.js: warning: ${err.message}`);
    } else {
      failed = true;
      console.error(`pack.js: archive warning escalated: ${err.message}`);
      process.exit(3);
    }
  });
  archive.pipe(output);
  for (const f of files) {
    archive.file(f.absPath, { name: f.relPath });
  }
  archive.finalize().catch((err) => {
    failed = true;
    console.error(`pack.js: finalize error: ${err.message}`);
    process.exit(3);
  });
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(`pack.js: ${parsed.reason}`);
    console.error(
      'Usage: node scripts/pack.js --target=chrome|firefox [--dry-run]'
    );
    process.exit(1);
  }
  const version = readVersion(parsed.target);
  const files = buildFileList(parsed.target);
  if (parsed.dryRun) {
    for (const f of files) console.log(f.relPath);
    console.error(
      `pack.js: ${files.length} files would be packed (dry run, version=${version})`
    );
    process.exit(0);
  }
  pack(parsed.target, version, files);
}

main();
```

- [ ] **Step 2: Smoke pack — chrome**

Run: `node scripts/pack.js --target=chrome`
Expected output: `Packed dist/listen1-chrome-2.33.0.zip (N files, M MB)` where N is ≥ 70 and M is between 0.5 MB and 5 MB.
Exit code 0.

Run: `ls -la dist/`
Expected: a single `listen1-chrome-2.33.0.zip` listed. No other files.

- [ ] **Step 3: Smoke pack — firefox**

Run: `node scripts/pack.js --target=firefox`
Expected output: `Packed dist/listen1-firefox-2.33.0.zip (N files, M MB)`.
Exit code 0.

Run: `ls -la dist/`
Expected: both zips present.

- [ ] **Step 4: Verify zip contents — chrome**

Run:

```bash
unzip -l dist/listen1-chrome-2.33.0.zip | head -20
```

Expected: starts with `Archive:`, lists `manifest.json` (MV3 one), `js/background.js`, `listen1.html`, etc. Use `q` if `unzip -l` opens a pager; or pipe: `unzip -l dist/listen1-chrome-2.33.0.zip | head -20 | cat`.

Run: `unzip -l dist/listen1-chrome-2.33.0.zip | grep -E 'manifest_firefox|node_modules|\.git/|scripts/' || true`
Expected: no matches.

- [ ] **Step 5: Verify zip contents — firefox (renamed manifest)**

Run:

```bash
unzip -l dist/listen1-firefox-2.33.0.zip | cat
```

Spot-check: `manifest.json` should appear exactly once; `manifest_firefox.json` should NOT appear.

Optional stronger check: extract to a temp dir and confirm
`grep '"manifest_version"' dist/listen1-firefox/manifest.json` returns `2` (Firefox MV2) and `grep '"manifest_version"' dist/listen1-chrome/manifest.json` returns `3`.

```bash
rm -rf /tmp/lc /tmp/lf
unzip -q dist/listen1-chrome-2.33.0.zip -d /tmp/lc
unzip -q dist/listen1-firefox-2.33.0.zip -d /tmp/lf
grep '"manifest_version"' /tmp/lc/manifest.json   # must print ", "manifest_version": 3,"
grep '"manifest_version"' /tmp/lf/manifest.json   # must print ", "manifest_version": 2,"
```

- [ ] **Step 6: Verify the working tree is clean**

Run:

```bash
git status --short
```

Expected output: empty, or shows only `dist/` entries (already gitignored, so they should not appear).

- [ ] **Step 7: Verify idempotency**

Run: `node scripts/pack.js --target=chrome && node scripts/pack.js --target=chrome`
Expected: both invocations exit 0 with the same `Packed …` line and no errors.

- [ ] **Step 8: Commit**

```bash
git add scripts/pack.js
git commit -m "feat(pack): stream the surviving files into a version-named zip"
```

---

### Task 6: Wire up the npm scripts

**Files:**

- Modify: `package.json` (add three scripts to the `scripts` block)

**Goal:** Provide `npm run pack`, `npm run pack:chrome`, `npm run pack:firefox`.

- [ ] **Step 1: Edit package.json**

In `package.json`, locate the existing `"scripts"` block:

```json
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
```

Replace it with:

```json
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1",
    "pack:chrome": "node scripts/pack.js --target=chrome",
    "pack:firefox": "node scripts/pack.js --target=firefox",
    "pack": "npm run pack:chrome && npm run pack:firefox"
  },
```

- [ ] **Step 2: Sanity: npm run pack:chrome**

Run:

```bash
npm run pack:chrome
```

Expected: same as Task 5 Step 2.

- [ ] **Step 3: Sanity: npm run pack (both)**

Run:

```bash
npm run pack
```

Expected: chrome packs first, then firefox. Two `Packed …` lines. Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "build: add pack, pack:chrome, pack:firefox scripts"
```

---

### Task 7: End-to-end smoke verification in the repo

**Files:** none modified.

**Goal:** Prove that a developer can take a clean clone, run one command, and get installable zips.

- [ ] **Step 1: Clean previous outputs**

Run: `rm -rf dist/`
Expected: silent success.

- [ ] **Step 2: Run the full pack**

Run: `npm run pack`
Expected: two `Packed …` lines, no errors, exit code 0.

- [ ] **Step 3: Verify both zips exist with expected sizes**

Run:

```bash
ls -la dist/
```

Expected: two zips, each between 1 MB and 4 MB on disk.

- [ ] **Step 4: Verify git status is clean outside dist**

Run:

```bash
git status --short
```

Expected: empty (since `dist/` is gitignored).

- [ ] **Step 5: Verify Chrome zip can be unzipped and has MV3 manifest**

```bash
rm -rf /tmp/lc && unzip -q dist/listen1-chrome-2.33.0.zip -d /tmp/lc
grep -E '"manifest_version"' /tmp/lc/manifest.json
ls /tmp/lc/js /tmp/lc/css /tmp/lc/images | head
```

Expected:

- `grep` line shows `"manifest_version": 3,`
- `ls` shows `background.js` (under `js/`), at least one CSS file, at least one image.

- [ ] **Step 6: Verify Firefox zip can be unzipped and has MV2 manifest**

```bash
rm -rf /tmp/lf && unzip -q dist/listen1-firefox-2.33.0.zip -d /tmp/lf
grep -E '"manifest_version"' /tmp/lf/manifest.json
ls /tmp/lf/js/vendor | head
```

Expected:

- `grep` line shows `"manifest_version": 2,`
- `js/vendor` directory present with vendor JS files (Firefox depends on these being present).

- [ ] **Step 7: Manual install follow-up (informational, no code change)**

Document these for the developer (no commit needed — covered by the spec already):

- Chrome: `chrome://extensions` → Developer mode → **Load unpacked** → select unzipped chrome folder.
- Firefox: `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → select unzipped folder's `manifest.json`.

- [ ] **Step 8: Final commit if anything remains**

If Step 4 produced no diffs, skip this step. Otherwise:

```bash
git status --short
git add -A
git commit -m "chore: post-smoke pack cleanup" --allow-empty
```

---

## Spec coverage self-check

| Spec section                                                 | Covered by                         |
| ------------------------------------------------------------ | ---------------------------------- |
| Goal (dev-mode installable MV3 + MV2 zips)                   | Tasks 5, 6, 7                      |
| Non-goals (publishing, bundling, polyfills, CI)              | Not addressed in tasks (correctly) |
| Constraints (cross-platform, idempotent, no source mutation) | Tasks 4, 5, 7 Step 4               |
| Architecture (argv → walk → exclude → rename → zip → exit)   | Tasks 2–5                          |
| Files added/modified                                         | Tasks 1, 2, 6                      |
| Exclude rules (hard + per-target)                            | Task 4                             |
| Manifest rename via entryName                                | Task 5 Step 1                      |
| Output contract (`Packed …` line)                            | Task 5 Step 2                      |
| Exit codes                                                   | Tasks 2, 3, 5                      |
| Acceptance criteria                                          | Task 7                             |
| Install steps                                                | Task 7 Step 7                      |

## Open risks

- `archiver` license: BSD-3-Clause, compatible with MIT.
- The acceptance criterion of "extension works in Chrome/Firefox after Load unpacked" requires a real browser — we verify zip shape and manifest content but not runtime. A human should do a one-time manual load and confirm.
