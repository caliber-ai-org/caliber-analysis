/**
 * Unit tests for laptop email resolution + loadConfig MDM behavior.
 * Run: `node --test plugins/caliber-analysis/test/resolve-email.test.mjs`
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const configPath = require.resolve("../lib/config.mjs");

function runUnderHome(home, source, extraEnv = {}) {
  return spawnSync(
    process.execPath,
    ["--input-type=module", "-e", source],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: home,
        // Isolate from the developer's real git identity.
        GIT_CONFIG_GLOBAL: join(home, ".gitconfig-empty"),
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        CALIBER_EMAIL: "",
        ...extraEnv,
      },
    },
  );
}

test("emailFromClaudeLogin reads oauthAccount.emailAddress", async () => {
  const home = mkdtempSync(join(tmpdir(), "caliber-email-"));
  try {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "Dev@Acme.COM" } }),
    );
    const { emailFromClaudeLogin } = await import("../lib/resolve-email.mjs");
    assert.equal(emailFromClaudeLogin(home), "dev@acme.com");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveLaptopEmail prefers Claude over CALIBER_EMAIL", async () => {
  const home = mkdtempSync(join(tmpdir(), "caliber-email-"));
  try {
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "claude@acme.com" } }),
    );
    const { resolveLaptopEmail } = await import("../lib/resolve-email.mjs");
    assert.equal(
      resolveLaptopEmail({ home, env: { CALIBER_EMAIL: "mdm@acme.com" } }),
      "claude@acme.com",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("resolveLaptopEmail falls back to CALIBER_EMAIL when Claude missing", async () => {
  const home = mkdtempSync(join(tmpdir(), "caliber-email-"));
  try {
    const { resolveLaptopEmail } = await import("../lib/resolve-email.mjs");
    assert.equal(
      resolveLaptopEmail({ home, env: { CALIBER_EMAIL: "mdm@acme.com" } }),
      "mdm@acme.com",
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig resolves missing email and persists into capture.json", () => {
  const home = mkdtempSync(join(tmpdir(), "caliber-cfg-"));
  try {
    mkdirSync(join(home, ".caliber"), { recursive: true });
    writeFileSync(
      join(home, ".claude.json"),
      JSON.stringify({ oauthAccount: { emailAddress: "later@acme.com" } }),
    );
    writeFileSync(
      join(home, ".caliber", "capture.json"),
      JSON.stringify({ endpoint: "https://app.trycaliber.ai", token: "clbi_test" }),
    );
    writeFileSync(join(home, ".gitconfig-empty"), "");

    const r = runUnderHome(
      home,
      `
      const { loadConfig, CAPTURE_CONFIG_PATH } = await import(${JSON.stringify(configPath)});
      const cfg = loadConfig();
      if (!cfg || cfg.email !== "later@acme.com") { console.error(cfg); process.exit(1); }
      const fs = await import("node:fs");
      const saved = JSON.parse(fs.readFileSync(CAPTURE_CONFIG_PATH, "utf8"));
      if (saved.email !== "later@acme.com") { console.error(saved); process.exit(1); }
      `,
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
    const saved = JSON.parse(readFileSync(join(home, ".caliber", "capture.json"), "utf8"));
    assert.equal(saved.email, "later@acme.com");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("loadConfig stays silent when email cannot be resolved", () => {
  const home = mkdtempSync(join(tmpdir(), "caliber-cfg-"));
  try {
    mkdirSync(join(home, ".caliber"), { recursive: true });
    writeFileSync(
      join(home, ".caliber", "capture.json"),
      JSON.stringify({ endpoint: "https://app.trycaliber.ai", token: "clbi_test" }),
    );
    writeFileSync(join(home, ".gitconfig-empty"), "");

    const r = runUnderHome(
      home,
      `
      const { loadConfig } = await import(${JSON.stringify(configPath)});
      const cfg = loadConfig();
      if (cfg !== null) { console.error(cfg); process.exit(1); }
      `,
    );
    assert.equal(r.status, 0, r.stderr || r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
