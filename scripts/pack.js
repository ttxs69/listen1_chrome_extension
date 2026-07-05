#!/usr/bin/env node
/* eslint-env node */
/* eslint-disable no-console, import/no-extraneous-dependencies */

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
  // Spec: docs/superpowers/specs/...-packaging-design.md (Hard excludes).
  '.pi-subagents',
  '.superpowers',
  'docs',
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
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    entries.forEach((entry) => {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs);
      const top = rel.split(path.sep)[0];
      if (exclusions.has(top)) return;
      if (entry.isDirectory()) {
        visit(abs);
      } else if (entry.isFile()) {
        out.push({ absPath: abs, relPath: rel.split(path.sep).join('/') });
      }
    });
  }
  visit(root);
  return out;
}

function buildFileList(target) {
  const exclusions = new Set([
    ...HARD_EXCLUDES,
    ...PER_TARGET[target].extraExcludes,
  ]);
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
  files.forEach((f) => {
    archive.file(f.absPath, { name: f.relPath });
  });
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
    files.forEach((f) => console.log(f.relPath));
    console.error(
      `pack.js: ${files.length} files would be packed (dry run, version=${version})`
    );
    process.exit(0);
  }
  pack(parsed.target, version, files);
}

main();
