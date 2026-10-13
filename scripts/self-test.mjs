#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import undoRedo, { ShadowGit } from "../src/extension.ts";

const settings = { enabled: true, storageDir: "", largeFileLimitBytes: 1024 * 1024, gitTimeoutMs: 30_000 };

// Snapshots must prune ignored trees: node_modules-sized directories used to be enumerated in
// full on every call and then thrown away, which cost seconds per user message in real projects.
const IGNORED_NOISE_FILES = 200;

async function main() {
  testActivation();
  await testGitSnapshot();
  await testUntrackedListingPrunesIgnoredTrees();
  await testCleanTurnSkipsTheAfterSnapshot();
  await testCustomRunsSkipUserCheckpoints();
  await testTrackedIgnoredPathsStaySnapshotted();
  await testTrackedIgnoredSymlinksStaySnapshotted();
  await testNonGitTouchedPaths();
  await testExplicitPathSkipReason();
  await testToolCallNeverBlocksWrites();
  await testUndoLeavesUnsnapshottedPaths();
  await testTreeAndRedoRestoreSkippedContent();
  await testReloadedSessionKeepsSkippedPathsOut();
  console.log("self-test passed");
}

function testActivation() {
  const events = [];
  const commands = [];
  undoRedo({
    on: (name) => events.push(name),
    registerCommand: (name) => commands.push(name),
    appendEntry: () => undefined,
  });
  for (const command of ["undo", "redo", "undo-cleanup"]) {
    assert(commands.includes(command), `missing command ${command}`);
  }
  for (const event of ["session_start", "before_agent_start", "message_start", "agent_end", "tool_call"]) {
    assert(events.includes(event), `missing event ${event}`);
  }
}

async function testGitSnapshot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-git-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);

    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    assert(await snap.available(), "git snapshotter should be available");
    const before = await snap.track();
    writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    writeFileSync(path.join(root, "shell-new.txt"), "created\n");
    const after = await snap.track();
    const files = await snap.patchFiles(before);
    assert(files.includes("tracked.txt"), "git patch should include tracked modify");
    assert(files.includes("shell-new.txt"), "git patch should include ordinary untracked file");
    await snap.revertFiles(before, files);
    assert(readFileSync(path.join(root, "tracked.txt"), "utf8") === "base\n", "git undo tracked content");
    assert(!existsSync(path.join(root, "shell-new.txt")), "git undo removes new file");
    await snap.revertFiles(after, files);
    assert(readFileSync(path.join(root, "tracked.txt"), "utf8") === "changed\n", "git redo tracked content");
    assert(readFileSync(path.join(root, "shell-new.txt"), "utf8") === "created\n", "git redo new file");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testUntrackedListingPrunesIgnoredTrees() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-ignored-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  // GIT_TRACE records every git invocation (including argv), which is how this test checks the
  // shape of the untracked listing without depending on wall-clock timings.
  const traceFile = path.join(storage, "git-trace.log");
  const previousTrace = process.env.GIT_TRACE;
  process.env.GIT_TRACE = traceFile;
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, ".gitignore"), "node_modules/\ndist/\n");
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", ".gitignore", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);

    mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
    for (let i = 0; i < IGNORED_NOISE_FILES; i++) writeFileSync(path.join(root, "node_modules", "pkg", `file-${i}.js`), "x\n");
    mkdirSync(path.join(root, "dist"), { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(path.join(root, "dist", `chunk-${i}.js`), "x\n");

    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    assert(await snap.available(), "git snapshotter should be available");
    const before = await snap.track();
    const listings = gitTraceCalls(traceFile).filter((line) => line.includes("ls-files") && line.includes("--others"));
    assert(listings.length > 0, "the snapshot should list untracked files");
    const unpruned = listings.filter((line) => !line.includes("--exclude-standard"));
    assert(unpruned.length === 0, `untracked listing must prune ignored trees: ${unpruned.join(" | ")}`);

    // Second snapshot on the same instance: the shadow identity must not be rewritten and the
    // worktree must be read once (--modified and --others in one call instead of two).
    const warmCalls = gitTraceCursor(traceFile);
    await snap.track();
    const warm = warmCalls();
    assert(!warm.some((line) => line.includes(" config ")), `a warm snapshot must not rewrite identity config: ${warm.join(" | ")}`);
    const worktreeListings = warm.filter(
      (line) => line.includes("diff-files") || (line.includes("ls-files") && (line.includes("--others") || line.includes("--modified"))),
    );
    assert(worktreeListings.length === 1, `one snapshot should need a single worktree listing, saw ${worktreeListings.length}: ${worktreeListings.join(" | ")}`);
    assert(warm.length <= 5, `a warm snapshot should stay within 5 git processes, saw ${warm.length}: ${warm.join(" | ")}`);

    writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    writeFileSync(path.join(root, "ordinary.txt"), "created\n");
    writeFileSync(path.join(root, "node_modules", "pkg", "file-0.js"), "changed\n");
    const after = await snap.track();
    const files = await snap.patchFiles(before);
    assert(files.includes("tracked.txt"), "pruning must keep tracked modifications");
    assert(files.includes("ordinary.txt"), "pruning must keep ordinary untracked files");
    assert(!files.some((file) => file.startsWith("node_modules/")), "ignored files must stay out of the snapshot");
    await snap.revertFiles(before, files);
    assert(readFileSync(path.join(root, "tracked.txt"), "utf8") === "base\n", "pruning must keep tracked undo");
    assert(!existsSync(path.join(root, "ordinary.txt")), "pruning must keep untracked undo");
    await snap.revertFiles(after, files);
    assert(readFileSync(path.join(root, "ordinary.txt"), "utf8") === "created\n", "pruning must keep untracked redo");
  } finally {
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testCleanTurnSkipsTheAfterSnapshot() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-clean-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-agent-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTrace = process.env.GIT_TRACE;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.GIT_TRACE = path.join(storage, "git-trace.log");
  const traceFile = path.join(storage, "git-trace.log");
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ undoRedo: { storageDir: storage, largeFileLimitBytes: 1024 } }));

    const hook = createHookHarness(root);
    await hook.emit("session_start", {});
    await hook.emit("before_agent_start", { prompt: HOOK_PROMPT });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });

    const cleanTurnCalls = gitTraceCursor(traceFile);
    await hook.emit("agent_end", {});
    const cleanTurn = cleanTurnCalls();

    const checkpoint = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").at(-1)?.data;
    assert(checkpoint, "a clean turn should still persist a checkpoint");
    assert(checkpoint.beforeSnapshot === checkpoint.afterSnapshot, "a clean turn should reuse its before snapshot");
    assert(checkpoint.files.length === 0, `a clean turn changes no files (got ${JSON.stringify(checkpoint.files)})`);
    assert(
      !cleanTurn.some((line) => line.includes("ls-files")),
      `a turn without tool calls must not walk the worktree again: ${cleanTurn.join(" | ") || "(no git calls)"}`,
    );

    // A turn that calls a tool still snapshots the workspace, so the shortcut stays honest.
    await hook.emit("before_agent_start", { prompt: HOOK_PROMPT });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    await hook.emit("tool_call", { toolName: "write", input: { path: path.join(root, "tracked.txt"), content: "changed\n" } });
    writeFileSync(path.join(root, "tracked.txt"), "changed\n");
    const toolTurnCalls = gitTraceCursor(traceFile);
    await hook.emit("agent_end", {});
    const toolTurn = toolTurnCalls();

    const toolCheckpoint = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").at(-1)?.data;
    assert(toolCheckpoint.files.includes("tracked.txt"), "a tool turn should record the changed file");
    assert(
      toolTurn.some((line) => line.includes("ls-files")),
      `a tool turn must snapshot the worktree again: ${toolTurn.join(" | ") || "(no git calls)"}`,
    );
    assert(toolCheckpoint.beforeSnapshot !== toolCheckpoint.afterSnapshot, "a tool turn must record a new after snapshot");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testCustomRunsSkipUserCheckpoints() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-custom-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-agent-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousTrace = process.env.GIT_TRACE;
  const traceFile = path.join(storage, "git-trace.log");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.GIT_TRACE = traceFile;
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["commit", "-m", "init"]);
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ undoRedo: { storageDir: storage } }));

    const session = createFlatSession();
    session.pushCustom("pi-undo-redo-redo", [{ leafId: "u1" }]);
    const hook = createHookHarness(root, session);
    await hook.emit("session_start", {});
    const customCalls = gitTraceCursor(traceFile);
    await hook.emit("before_agent_start", {
      messageType: "custom",
      message: { customType: "test-follow-up", content: "Continue", display: false },
    });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    await hook.emit("agent_end", {});
    assert(hook.appended.length === 0, "a custom run must not clear persisted redo history or append a user checkpoint");
    assert(hook.notifications.length === 0, "a custom run must not warn about a missing submitted user message");
    assert(!customCalls().some((line) => line.includes("ls-files")), "a custom run must not snapshot a user turn");

    // The Pi 1.2 user variant and older prompt-only events still use normal checkpoints.
    await hook.emit("before_agent_start", { messageType: "user", prompt: HOOK_PROMPT });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    await hook.emit("agent_end", {});
    assert(hook.appended.some((entry) => entry.customType === "pi-undo-redo"), "the next user run should persist its checkpoint");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (previousTrace === undefined) delete process.env.GIT_TRACE;
    else process.env.GIT_TRACE = previousTrace;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testTrackedIgnoredPathsStaySnapshotted() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-tracked-ignored-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, ".gitignore"), "dist/\n");
    mkdirSync(path.join(root, "dist"), { recursive: true });
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFileSync(path.join(root, "dist", "out.js"), "built\n");
    writeFileSync(path.join(root, "src", "app.js"), "base\n");
    git(root, ["add", ".gitignore", "src/app.js"]);
    git(root, ["add", "-f", "dist/out.js"]);
    git(root, ["commit", "-m", "init"]);

    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    assert(await snap.isGitMode(), "tracked repository expected");
    const before = await snap.track();
    writeFileSync(path.join(root, "dist", "out.js"), "rebuilt\n");
    const after = await snap.track();
    const files = await snap.patchFiles(before);
    assert(files.includes("dist/out.js"), "a tracked file matching an ignore rule must stay snapshotted");
    await snap.revertFiles(before, files);
    assert(readFileSync(path.join(root, "dist", "out.js"), "utf8") === "built\n", "tracked-but-ignored content should be restorable");
    await snap.revertFiles(after, files);
    assert(readFileSync(path.join(root, "dist", "out.js"), "utf8") === "rebuilt\n", "tracked-but-ignored content should be redoable");

    // Joins the repository after the shadow index already exists.
    writeFileSync(path.join(root, "dist", "late.js"), "late\n");
    git(root, ["add", "-f", "dist/late.js"]);
    const mid = await snap.track();
    writeFileSync(path.join(root, "dist", "late.js"), "later\n");
    const later = await snap.track();
    const lateFiles = await snap.patchFiles(mid);
    assert(lateFiles.includes("dist/late.js"), "a tracked-but-ignored file added later must stay snapshotted");
    await snap.revertFiles(mid, lateFiles);
    assert(readFileSync(path.join(root, "dist", "late.js"), "utf8") === "late\n", "later tracked-but-ignored content should be restorable");

    // Deleting one must not break the snapshot of everything else.
    rmSync(path.join(root, "dist", "out.js"));
    writeFileSync(path.join(root, "src", "app.js"), "changed\n");
    const afterDelete = await snap.track();
    const deleteFiles = await snap.patchFiles(later);
    assert(deleteFiles.includes("src/app.js"), "deleting a tracked-but-ignored file must not break the snapshot");
    await snap.revertFiles(later, deleteFiles);
    assert(readFileSync(path.join(root, "src", "app.js"), "utf8") === "base\n", "a snapshot taken after the deletion stays usable");
    await snap.revertFiles(afterDelete, deleteFiles);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

function canCreateSymlinks() {
  const target = path.join(tmpdir(), `pi-undo-redo-symlink-target-${process.pid}`);
  const link = path.join(tmpdir(), `pi-undo-redo-symlink-link-${process.pid}`);
  try {
    writeFileSync(target, "x\n");
    symlinkSync(target, link, "file");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(link, { force: true });
    rmSync(target, { force: true });
  }
}

async function testTrackedIgnoredSymlinksStaySnapshotted() {
  if (!canCreateSymlinks()) {
    console.log("self-test: skipped tracked symlink case (this platform does not allow creating symlinks)");
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-tracked-symlink-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    git(root, ["init"]);
    git(root, ["config", "user.name", "self-test"]);
    git(root, ["config", "user.email", "self-test@example.local"]);
    writeFileSync(path.join(root, ".gitignore"), "dist/\n");
    mkdirSync(path.join(root, "dist"), { recursive: true });
    writeFileSync(path.join(root, "dist", "target.js"), "x\n");
    writeFileSync(path.join(root, "dist", "other.js"), "y\n");
    symlinkSync("target.js", path.join(root, "dist", "link.js"), "file");
    git(root, ["add", ".gitignore"]);
    try {
      git(root, ["add", "-f", "dist/target.js", "dist/other.js", "dist/link.js"]);
    } catch {
      console.log("self-test: skipped tracked symlink case (git does not track symlinks here)");
      return;
    }
    git(root, ["commit", "-m", "init"]);

    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    const before = await snap.track();
    rmSync(path.join(root, "dist", "link.js"));
    symlinkSync("other.js", path.join(root, "dist", "link.js"), "file");
    const after = await snap.track();
    const files = await snap.patchFiles(before);
    assert(files.includes("dist/link.js"), "a tracked symlink inside an ignored directory must stay snapshotted");
    await snap.revertFiles(after, files);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testNonGitTouchedPaths() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-nongit-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    writeFileSync(path.join(root, "target.txt"), "base\n");
    writeFileSync(path.join(root, "sentinel.txt"), "sentinel\n");
    const snap = new ShadowGit(root, "self-test", { ...settings, storageDir: storage });
    assert(await snap.available(), "non-git snapshotter should be available");
    assert(!(await snap.isGitMode()), "non-git mode expected");

    const emptyBefore = await snap.track();
    let before = await snap.capturePathBefore("target.txt", emptyBefore);
    writeFileSync(path.join(root, "target.txt"), "changed\n");
    const after = await snap.track(["target.txt"]);
    const files = await snap.patchFiles(before, ["target.txt"]);
    assert(files.length === 1 && files[0] === "target.txt", "non-git patch limited to explicit path");
    await snap.revertFiles(before, files);
    assert(readFileSync(path.join(root, "target.txt"), "utf8") === "base\n", "non-git undo explicit file");
    assert(readFileSync(path.join(root, "sentinel.txt"), "utf8") === "sentinel\n", "non-git leaves sentinel untouched");
    await snap.revertFiles(after, files);
    assert(readFileSync(path.join(root, "target.txt"), "utf8") === "changed\n", "non-git redo explicit file");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

const HOOK_PROMPT = "self-test hook prompt";

function createFlatSession() {
  const entries = [
    { type: "message", id: "u0", parentId: null, message: { role: "user", content: "earlier turn" } },
    { type: "message", id: "u1", parentId: "u0", message: { role: "user", content: HOOK_PROMPT } },
  ];
  return {
    getSessionId: () => "self-test-hook",
    getEntries: () => entries,
    getEntry: (id) => entries.find((entry) => entry.id === id),
    getBranch: () => entries,
    getLeafId: () => "u1",
    pushCustom: () => undefined,
  };
}

function createBranchSession() {
  const entries = [];
  let leafId = null;
  const lookup = () => new Map(entries.map((entry) => [entry.id, entry]));
  return {
    getSessionId: () => "self-test-branch",
    getEntries: () => entries,
    getEntry: (id) => lookup().get(id),
    getBranch: (fromId) => {
      const byId = lookup();
      const branch = [];
      let current = fromId === undefined ? leafId : fromId;
      while (current) {
        const entry = byId.get(current);
        if (!entry) break;
        branch.push(entry);
        current = entry.parentId;
      }
      return branch.reverse();
    },
    getLeafId: () => leafId,
    setLeaf: (id) => {
      leafId = id;
    },
    addTurn: (text) => {
      const user = { type: "message", id: `u${entries.length}-user`, parentId: leafId, message: { role: "user", content: text } };
      entries.push(user);
      leafId = user.id;
      return { userEntryId: user.id };
    },
    addAssistant: (id) => {
      const assistant = { type: "message", id, parentId: leafId, message: { role: "assistant", content: [] } };
      entries.push(assistant);
      leafId = assistant.id;
      return { assistantId: assistant.id };
    },
    pushCustom: (customType, data) => {
      const entry = { type: "custom", id: `custom-${entries.length}`, parentId: leafId, customType, data };
      entries.push(entry);
      leafId = entry.id;
      return entry;
    },
  };
}

function createHookHarness(cwd, sessionManager = createFlatSession()) {
  const handlers = new Map();
  const commands = new Map();
  const appended = [];
  const notifications = [];
  undoRedo({
    on: (name, handler) => {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
    registerCommand: (name, definition) => commands.set(name, definition),
    appendEntry: (customType, data) => {
      appended.push({ customType, data });
      sessionManager.pushCustom(customType, data);
    },
  });
  const ctx = {
    cwd,
    waitForIdle: async () => undefined,
    navigateTree: async () => ({ cancelled: false }),
    sessionManager,
    ui: {
      notify: (message, level) => notifications.push({ message, level }),
      setEditorText: () => undefined,
    },
  };
  const emit = async (name, event) => {
    let result;
    for (const handler of handlers.get(name) ?? []) {
      const value = await handler(event, ctx);
      if (value !== undefined && result === undefined) result = value;
    }
    return result;
  };
  return { emit, appended, notifications, commands, ctx };
}

async function testExplicitPathSkipReason() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-skip-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  try {
    writeFileSync(path.join(root, "small.txt"), "ok\n");
    mkdirSync(path.join(root, "adir"), { recursive: true });
    const snap = new ShadowGit(root, "self-test", { ...settings, largeFileLimitBytes: 16, storageDir: storage });
    assert((await snap.explicitPathSkipReason("small.txt")) === undefined, "small existing file should be snapshot-able");
    assert(Boolean(await snap.explicitPathSkipReason("new.txt", "x".repeat(64))), "oversized written content should report a skip reason");
    assert((await snap.explicitPathSkipReason("adir")) === "path is a directory", "directory path should report a skip reason");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testToolCallNeverBlocksWrites() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-hook-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-agent-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  const outside = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-outside-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ undoRedo: { storageDir: storage, largeFileLimitBytes: 1024 } }));
    writeFileSync(path.join(root, "target.txt"), "base\n");

    const hook = createHookHarness(root);
    await hook.emit("session_start", {});
    await hook.emit("before_agent_start", { prompt: HOOK_PROMPT });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });

    const snapshotScoped = path.join(root, "target.txt");
    const unsnapshottable = [
      [".pi config inside the workspace", "write", { path: path.join(root, ".pi", "settings.json"), content: "{}\n" }],
      ["node_modules file", "write", { path: path.join(root, "node_modules", "pkg", "index.js"), content: "x\n" }],
      ["oversized write", "write", { path: path.join(root, "huge.txt"), content: "y".repeat(2048) }],
      ["path outside the workspace", "write", { path: path.join(outside, "outside.txt"), content: "x\n" }],
      ["edit of a .pi config", "edit", { path: path.join(root, ".pi", "settings.json"), oldText: "a", newText: "b" }],
    ];

    assert(
      (await hook.emit("tool_call", { toolName: "write", input: { path: snapshotScoped, content: "changed\n" } })) === undefined,
      "snapshot-scoped write must not be blocked",
    );
    for (const [label, toolName, input] of unsnapshottable) {
      const result = await hook.emit("tool_call", { toolName, input });
      assert(result === undefined, `${label} must not be blocked`);
    }

    const warnings = hook.notifications.filter((note) => note.level === "warning" && note.message.includes("undo coverage"));
    assert(warnings.length === 1, `expected one capture-skip warning per turn, got ${warnings.length}`);
    assert(warnings[0].message.includes(".pi"), "capture-skip warning should name the skipped path");

    writeFileSync(path.join(root, "target.txt"), "changed\n");
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(path.join(root, ".pi", "settings.json"), "{}\n");
    await hook.emit("agent_end", {});

    const checkpoint = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").at(-1)?.data;
    assert(checkpoint, "agent_end should persist a checkpoint");
    assert(checkpoint.files.includes("target.txt"), "checkpoint should cover the snapshot-scoped path");
    assert(!checkpoint.files.some((file) => file.startsWith(".pi/")), "checkpoint must not claim unsnapshotted paths");

    await hook.emit("before_agent_start", { prompt: HOOK_PROMPT });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    assert(
      (await hook.emit("tool_call", { toolName: "write", input: { path: snapshotScoped, content: "changed again\n" } })) === undefined,
      "write before an injected failure must not be blocked",
    );
    const sessionId = hook.ctx.sessionManager.getSessionId;
    hook.ctx.sessionManager.getSessionId = () => {
      throw new Error("injected session failure");
    };
    hook.notifications.length = 0;
    const failed = await hook.emit("tool_call", { toolName: "write", input: { path: snapshotScoped, content: "changed once more\n" } });
    hook.ctx.sessionManager.getSessionId = sessionId;
    assert(failed === undefined, "a snapshot bookkeeping failure must not block the write");
    assert(
      hook.notifications.some((note) => note.level === "warning" && note.message.includes("bookkeeping failed")),
      "a snapshot bookkeeping failure should be reported",
    );

    const checkpointsBefore = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").length;
    writeFileSync(path.join(root, "target.txt"), "changed once more\n");
    await hook.emit("agent_end", {});
    const checkpointsAfter = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").length;
    assert(
      checkpointsAfter === checkpointsBefore,
      `a turn whose bookkeeping failed must not persist a checkpoint (${checkpointsBefore} -> ${checkpointsAfter})`,
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

async function testUndoLeavesUnsnapshottedPaths() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-undo-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-agent-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const oversized = "y".repeat(4096);
  try {
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ undoRedo: { storageDir: storage, largeFileLimitBytes: 1024 } }));
    writeFileSync(path.join(root, "target.txt"), "base\n");
    writeFileSync(path.join(root, "grow.txt"), "small\n");
    writeFileSync(path.join(root, "mixed.txt"), "m0\n");

    const hook = createHookHarness(root);
    await hook.emit("session_start", {});
    await hook.emit("before_agent_start", { prompt: HOOK_PROMPT });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });

    // Each hook is followed by the write the tool would perform, so the sequence models
    // real transitions instead of batching every hook before every write.
    const write = async (name, content) => {
      const file = path.join(root, name);
      const result = await hook.emit("tool_call", { toolName: "write", input: { path: file, content } });
      assert(result === undefined, `write of ${name} must not be blocked`);
      writeFileSync(file, content);
    };
    await write("target.txt", "changed\n");
    await write("grow.txt", oversized);
    await write("huge.txt", oversized);
    await write("flip.txt", oversized);
    await write("flip.txt", "small\n");
    await write("mixed.txt", "m1\n");
    await write("mixed.txt", oversized);
    await write("fresh.txt", "f1\n");
    await write("fresh.txt", oversized);
    await hook.emit("agent_end", {});

    const checkpoint = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").at(-1)?.data;
    assert(checkpoint, "agent_end should persist a checkpoint");
    assert(
      checkpoint.files.length === 1 && checkpoint.files[0] === "target.txt",
      `checkpoint should cover only the snapshotted path, got ${JSON.stringify(checkpoint.files)}`,
    );

    await hook.commands.get("undo").handler(undefined, hook.ctx);
    assert(readFileSync(path.join(root, "target.txt"), "utf8") === "base\n", "undo should restore the snapshotted file");
    assert(readFileSync(path.join(root, "grow.txt"), "utf8") === oversized, "undo should leave the regrown file untouched");
    assert(readFileSync(path.join(root, "huge.txt"), "utf8") === oversized, "undo should leave the created oversized file untouched");
    assert(readFileSync(path.join(root, "flip.txt"), "utf8") === "small\n", "undo should not revert a skipped path to a mid-turn state");
    assert(readFileSync(path.join(root, "mixed.txt"), "utf8") === oversized, "undo should leave a path skipped after capture untouched");
    assert(readFileSync(path.join(root, "fresh.txt"), "utf8") === oversized, "undo should leave an oversize-overwritten created file untouched");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testTreeAndRedoRestoreSkippedContent() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-tree-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-agent-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const covered = path.join(root, "covered.txt");
  const huge = "z".repeat(4096);
  try {
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ undoRedo: { storageDir: storage, largeFileLimitBytes: 1024 } }));
    writeFileSync(covered, "v1\n");

    const session = createBranchSession();
    const hook = createHookHarness(root, session);
    await hook.emit("session_start", {});

    const turn1 = session.addTurn("turn one");
    await hook.emit("before_agent_start", { prompt: "turn one" });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    session.addAssistant("a1");
    assert((await hook.emit("tool_call", { toolName: "write", input: { path: covered, content: "v2\n" } })) === undefined, "turn one write must not be blocked");
    writeFileSync(covered, "v2\n");
    await hook.emit("agent_end", {});

    session.addTurn("turn two");
    await hook.emit("before_agent_start", { prompt: "turn two" });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    session.addAssistant("a2");
    assert((await hook.emit("tool_call", { toolName: "write", input: { path: covered, content: huge } })) === undefined, "oversized overwrite must not be blocked");
    writeFileSync(covered, huge);
    await hook.emit("agent_end", {});

    const checkpoints = hook.appended.filter((entry) => entry.customType === "pi-undo-redo").map((entry) => entry.data);
    assert(checkpoints.length === 2, `expected two checkpoints, got ${checkpoints.length}`);
    assert(checkpoints[0].files.includes("covered.txt"), "turn one should cover covered.txt");
    assert(!checkpoints[1].files.includes("covered.txt"), "turn two must not claim the skipped path");

    assert(
      (await hook.emit("session_before_tree", { preparation: { targetId: turn1.userEntryId } })) === undefined,
      "/tree must not be cancelled by the dirty guard here",
    );
    session.setLeaf(turn1.userEntryId);
    await hook.emit("session_tree", { oldLeafId: "a2", newLeafId: turn1.userEntryId });
    // Navigating to a user node resolves to the state before that turn ran.
    assert(readFileSync(covered, "utf8") === "v1\n", "/tree should restore the selected node's workspace state");

    await hook.commands.get("redo").handler(undefined, hook.ctx);
    assert(readFileSync(covered, "utf8") === huge, "redo after /tree should restore the content /tree replaced");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

async function testReloadedSessionKeepsSkippedPathsOut() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-reload-"));
  const agentDir = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-agent-"));
  const storage = await mkdtemp(path.join(tmpdir(), "pi-undo-redo-storage-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const covered = path.join(root, "covered.txt");
  const huge = "z".repeat(4096);
  try {
    writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ undoRedo: { storageDir: storage, largeFileLimitBytes: 1024 } }));
    writeFileSync(covered, "v1\n");

    const session = createBranchSession();
    const hook = createHookHarness(root, session);
    await hook.emit("session_start", {});
    session.addTurn("turn one");
    await hook.emit("before_agent_start", { prompt: "turn one" });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    session.addAssistant("a1");
    await hook.emit("tool_call", { toolName: "write", input: { path: covered, content: "v2\n" } });
    writeFileSync(covered, "v2\n");
    await hook.emit("agent_end", {});

    session.addTurn("turn two");
    await hook.emit("before_agent_start", { prompt: "turn two" });
    await hook.emit("message_start", { message: { role: "assistant", content: [] } });
    session.addAssistant("a2");
    await hook.emit("tool_call", { toolName: "write", input: { path: covered, content: huge } });
    writeFileSync(covered, huge);
    await hook.emit("agent_end", {});

    const reloaded = createHookHarness(root, session);
    await reloaded.emit("session_start", {});
    await reloaded.commands.get("undo").handler(undefined, reloaded.ctx);
    assert(readFileSync(covered, "utf8") === huge, "a reloaded session must still leave the skipped path untouched");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
    await rm(agentDir, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  return result.stdout;
}

function gitTraceCalls(traceFile) {
  let text = "";
  try {
    text = readFileSync(traceFile, "utf8");
  } catch {
    return [];
  }
  return text.split(/\r?\n/).filter((line) => line.includes("built-in: git "));
}

/** Returns a reader that yields only git invocations recorded after the reader was created. */
function gitTraceCursor(traceFile) {
  let seen = gitTraceCalls(traceFile).length;
  return () => {
    const lines = gitTraceCalls(traceFile);
    const slice = lines.slice(seen);
    seen = lines.length;
    return slice;
  };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
