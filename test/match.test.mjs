/**
 * pi-git-safeguard pattern tests.
 *
 * Run: node test/match.test.mjs
 *
 * These tests exercise the guard's pure logic (pattern matching and mode
 * resolution) without loading the pi extension API, which is only available
 * inside a running pi process. jiti is used to import the TypeScript source
 * directly, mirroring how pi loads extensions at runtime.
 */

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { matchBlockedCommand, resolveGuardMode, BLOCKED_COMMANDS } =
  await jiti.import("../src/index.ts");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}\n    ${err.message}`);
  }
}

console.log("resolveGuardMode:");

test("unset → block", () => {
  assert.equal(resolveGuardMode({}), "block");
});
test("off → off", () => {
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "off" }), "off");
});
test("0/false/no → off", () => {
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "0" }), "off");
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "FALSE" }), "off");
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "No" }), "off");
});
test("warn/log → warn", () => {
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "warn" }), "warn");
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "LOG" }), "warn");
});
test("garbage → block (fail-safe)", () => {
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "banana" }), "block");
});
test("whitespace trimmed", () => {
  assert.equal(resolveGuardMode({ PI_GIT_SAFEGUARD: "  off  " }), "off");
});

console.log("blocked commands:");

const blocked = [
  ["git commit -m 'x'", "git commit"],
  ["git commit", "git commit"],
  ["GIT push origin main", "git push"], // case-insensitive? no — see below
  ["git push --force origin main", "git push"],
  ["git rebase -i HEAD~3", "git rebase"],
  ["git reset --hard HEAD~1", "git reset --hard/--keep/--merge"],
  ["git revert abc1234", "git revert"],
  ["git cherry-pick abc", "git cherry-pick"],
  ["git merge feature", "git merge"],
  ["git am patch.mbox", "git am"],
  ["git tag -d v1.0.0", "git tag delete"],
  ["git branch -D feature", "git branch delete/rename"],
  ["git stash drop stash@{0}", "git stash drop/clear"],
  ["git update-ref refs/heads/x abc", "git update-ref"],
  ["gh pr create --fill", "gh pr create/merge/edit/close/ready"],
  ["gh pr merge 123 --squash", "gh pr create/merge/edit/close/ready"],
  ["gh pr review 123 --approve", "gh pr review --approve/--request-changes"],
  ["gh issue close 42", "gh issue create/edit/close"],
  ["gh repo delete owner/repo", "gh repo delete"],
];

for (const [cmd, label] of blocked) {
  test(`blocks: ${cmd}`, () => {
    const m = matchBlockedCommand(cmd);
    assert.ok(m, `expected a match for "${cmd}"`);
    assert.equal(m.label, label);
  });
}

console.log("allowed (read-only) commands:");

const allowed = [
  "git status",
  "git diff HEAD~1",
  "git log --oneline -5",
  "git show abc1234",
  "git branch",
  "git branch -a",
  "git remote -v",
  "git stash list",
  "git tag",
  "git tag -l 'v*'",
  "git blame file.ts",
  "git describe --tags",
  "gh pr view 123",
  "gh pr list",
  "gh pr checks 123",
  "gh pr diff 123",
  "gh issue view 42",
  "gh issue list",
  "gh repo view owner/repo",
  "ls -la",
  "cat package.json",
  "npm install",
  // NOTE: 'echo git commit' IS blocked (fail-safe: any command whose text
  // matches a write pattern is gated, even inside quotes/strings).
];

for (const cmd of allowed) {
  test(`allows: ${cmd}`, () => {
    assert.equal(matchBlockedCommand(cmd), null, `should not match "${cmd}"`);
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
