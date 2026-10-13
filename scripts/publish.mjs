#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const registry = "https://registry.npmjs.org/";

if (!existsSync("package.json")) {
  console.error("package.json not found; script root resolution failed");
  process.exit(1);
}

run("npm", ["run", "typecheck"]);
run("npm", ["test"]);
ensureNpmLogin();
run("npm", ["publish", "--access", "public", "--registry", registry, "--auth-type", "web"]);

function ensureNpmLogin() {
  const whoami = run("npm", ["whoami", "--registry", registry], { exitOnError: false });
  if (whoami.status === 0) return;
  console.log("\nNot logged in to npm. Starting web login...");
  run("npm", ["login", "--registry", registry, "--auth-type", "web"]);
}

function run(command, args, options = {}) {
  // Windows resolves `npm` only through the shell (the npm.cmd shim is rejected without
  // one), and shell mode warns when it concatenates a separate args array (DEP0190), so
  // Windows receives the command line as one pre-quoted string instead.
  const result =
    process.platform === "win32"
      ? spawnSync([command, ...args].map(quoteShellArg).join(" "), { stdio: "inherit", shell: true })
      : spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0 && options.exitOnError !== false) process.exit(result.status ?? 1);
  return result;
}

function quoteShellArg(value) {
  return /[\s"&|<>^]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}
