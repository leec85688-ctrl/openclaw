#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const logLevel = process.env.OPENCLAW_BUILD_VERBOSE ? "info" : "warn";
const extraArgs = process.argv.slice(2);
const INEFFECTIVE_DYNAMIC_IMPORT_RE = /\[INEFFECTIVE_DYNAMIC_IMPORT\]/;

function resolveTsdownCommand() {
  const binDir = path.join(process.cwd(), "node_modules", ".bin");
  const candidates =
    process.platform === "win32"
      ? [path.join(binDir, "tsdown.cmd"), path.join(binDir, "tsdown")]
      : [path.join(binDir, "tsdown")];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return {
        command: candidate,
        args: ["--config-loader", "unrun", "--logLevel", logLevel, ...extraArgs],
        shell: process.platform === "win32",
      };
    }
  }

  return {
    command: "pnpm",
    args: ["exec", "tsdown", "--config-loader", "unrun", "--logLevel", logLevel, ...extraArgs],
    shell: process.platform === "win32",
  };
}

const tsdownCommand = resolveTsdownCommand();
const result = spawnSync(tsdownCommand.command, tsdownCommand.args, {
  encoding: "utf8",
  stdio: "pipe",
  shell: tsdownCommand.shell,
});

const stdout = result.stdout ?? "";
const stderr = result.stderr ?? "";
if (stdout) {
  process.stdout.write(stdout);
}
if (stderr) {
  process.stderr.write(stderr);
}

if (result.status === 0 && INEFFECTIVE_DYNAMIC_IMPORT_RE.test(`${stdout}\n${stderr}`)) {
  console.error(
    "Build emitted [INEFFECTIVE_DYNAMIC_IMPORT]. Replace transparent runtime re-export facades with real runtime boundaries.",
  );
  process.exit(1);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
