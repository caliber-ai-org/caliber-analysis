/**
 * normalizeRemote — git remote URL → canonical host/owner/repo.
 * Run: node --test plugins/caliber-analysis/test/repo.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRemote } from "../lib/repo.mjs";

test("normalizes the common remote URL shapes to host/owner/repo", () => {
  const want = "github.com/caliber-ai-org/caliber-platform";
  for (const url of [
    "git@github.com:caliber-ai-org/caliber-platform.git",
    "https://github.com/caliber-ai-org/caliber-platform.git",
    "https://github.com/caliber-ai-org/caliber-platform",
    "ssh://git@github.com/caliber-ai-org/caliber-platform.git",
    "https://github.com/Caliber-AI-Org/Caliber-Platform.git/", // case + trailing slash
  ]) {
    assert.equal(normalizeRemote(url), want, url);
  }
});

test("keeps nested paths (e.g. GitLab subgroups)", () => {
  assert.equal(
    normalizeRemote("git@gitlab.com:group/subgroup/repo.git"),
    "gitlab.com/group/subgroup/repo",
  );
});

test("returns null for empty / non-URL / non-string input", () => {
  assert.equal(normalizeRemote(""), null);
  assert.equal(normalizeRemote("   "), null);
  assert.equal(normalizeRemote("not-a-remote"), null); // no '/'
  assert.equal(normalizeRemote(null), null);
  assert.equal(normalizeRemote(undefined), null);
  assert.equal(normalizeRemote(42), null);
});
