/**
 * release.mjs
 * Creates a new GitHub Release for the native-translator repo.
 * Usage: node scripts/release.mjs v1.2.3 "Short release title"
 * @inputs GITHUB_TOKEN env var, version tag (argv[2]), title (argv[3])
 * @exports None (side-effect: creates GitHub Release via API)
 */

const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = 'ilihack';
const REPO  = 'native-translator';

if (!TOKEN) { console.error('❌  GITHUB_TOKEN not set'); process.exit(1); }

const tag   = process.argv[2];
const title = process.argv[3] || tag;

if (!tag || !/^v\d+\.\d+\.\d+/.test(tag)) {
  console.error('❌  Usage: node scripts/release.mjs v1.2.3 "Release title"');
  console.error('    Version must be semver: v1.0.0, v1.1.0, v2.0.0, etc.');
  process.exit(1);
}

// ── Read CHANGELOG.md for release notes ─────────────────────────────────────
import { readFileSync, existsSync } from 'fs';

let body = `See [CHANGELOG.md](https://github.com/${OWNER}/${REPO}/blob/main/CHANGELOG.md) for full details.\n\n**Live demo → [nativetranslator.app](https://nativetranslator.app)**`;

if (existsSync('CHANGELOG.md')) {
  const changelog = readFileSync('CHANGELOG.md', 'utf8');
  // Extract the first version section (between first ## and second ##)
  const match = changelog.match(/^## \[.*?\].*?\n([\s\S]*?)(?=^## |\z)/m);
  if (match) {
    body = match[1].trim() + `\n\n---\n\n**Live demo → [nativetranslator.app](https://nativetranslator.app)**`;
  }
}

// ── Create the release ───────────────────────────────────────────────────────
const res = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    tag_name: tag,
    target_commitish: 'main',
    name: `${tag} — ${title}`,
    body,
    draft: false,
    prerelease: false,
    make_latest: 'true',
  }),
});

const json = await res.json();

if (json.html_url) {
  console.log(`\n✅  Release created: ${json.tag_name}`);
  console.log(`   ${json.html_url}\n`);
} else {
  console.error('❌  Failed:', JSON.stringify(json, null, 2));
  process.exit(1);
}
