import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
type ExtensionAPI = {
  on(event: string, handler: (...args: any[]) => unknown): unknown;
  registerCommand(name: string, definition: { description?: string; handler: (args: unknown, ctx: ExtensionCommandContext) => unknown }): unknown;
  appendEntry(customType: string, data: unknown): unknown;
};

type ExtensionCommandContext = {
  cwd: string;
  waitForIdle(): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean; label?: string }): Promise<{ cancelled: boolean }>;
  sessionManager: {
    getSessionId(): string;
    getEntries(): SessionEntry[];
    getEntry(id: string): SessionEntry | undefined;
    getBranch(leafId?: string | null): SessionEntry[];
    getLeafId(): string | null;
  };
  ui: {
    notify(message: string, level?: "warning" | "info" | "error"): void;
    setEditorText(text: string): void;
  };
};

type SessionEntry = {
  type: string;
  id: string;
  parentId: string | null;
  customType?: string;
  data?: unknown;
  message?: { role: string; content?: unknown };
  [key: string]: unknown;
};

const EXT = "pi-undo-redo";
const REDO_EXT = "pi-undo-redo-redo";
const DEFAULT_LARGE_FILE_LIMIT = 2 * 1024 * 1024;
const DEFAULT_GIT_TIMEOUT = 30_000;

type Settings = {
  enabled: boolean;
  storageDir: string;
  largeFileLimitBytes: number;
  gitTimeoutMs: number;
};

type Checkpoint = {
  userEntryId: string;
  beforeLeafId: string | null;
  finalLeafId: string;
  prompt: string;
  beforeSnapshot: string;
  afterSnapshot: string;
  files: string[];
  createdAt: number;
};

type ActiveCheckpoint = Omit<Checkpoint, "finalLeafId" | "afterSnapshot" | "files" | "createdAt"> & {
  snapshotFiles: Set<string>;
  touchedFiles: Set<string>;
  warnedNonGitShell: boolean;
  hadToolCall: boolean;
};

type PendingBeforeSnapshot = {
  prompt: string;
  beforeSnapshot: string;
  snapshotFiles?: string[];
};

type RedoItem = {
  checkpoint?: Checkpoint;
  leafId: string | null;
  prompt?: string;
  snapshot?: string;
  snapshotFiles?: string[];
};

type SnapshotRestoreGroup = {
  snapshot: string;
  files: string[];
};

type SnapshotTarget = {
  snapshot: string;
  files?: string[];
  restoreGroups?: SnapshotRestoreGroup[];
  score: number;
  reason: string;
};

type GitResult = { code: number; stdout: string; stderr: string };

export default function undoRedo(pi: ExtensionAPI) {
  const checkpoints = new Map<string, Checkpoint>();
  const redoStack: RedoItem[] = [];
  let active: ActiveCheckpoint | undefined;
  let pendingBeforeSnapshot: PendingBeforeSnapshot | undefined;
  let snapshotter: ShadowGit | undefined;
  let suppressTreeRestore = 0;
  let warnedCaptureSkip = false;
  const skippedPaths = new Set<string>();

  pi.on("session_start", async (_event, ctx) => {
    const settings = await loadSettings(ctx.cwd);
    snapshotter = new ShadowGit(ctx.cwd, ctx.sessionManager.getSessionId(), settings);
    checkpoints.clear();
    redoStack.length = 0;
    active = undefined;
    pendingBeforeSnapshot = undefined;

    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === EXT) {
        const checkpoint = repairCheckpoint(entry.data as Partial<Checkpoint> | undefined, ctx.sessionManager);
        if (checkpoint) checkpoints.set(checkpoint.userEntryId, checkpoint);
      }
      if (entry.customType === REDO_EXT) {
        redoStack.length = 0;
        redoStack.push(...parseRedoStack(entry.data));
      }
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Pi 1.2 also emits this for extension-triggered custom messages, which have
    // no submitted user prompt and must not invalidate user-turn redo history.
    if (event.messageType === "custom") return;

    redoStack.length = 0;
    pi.appendEntry(REDO_EXT, []);
    active = undefined;
    pendingBeforeSnapshot = undefined;
    warnedCaptureSkip = false;
    skippedPaths.clear();

    try {
      const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (!(await snap.available())) return;
      const gitMode = await snap.isGitMode();
      const snapshotFiles = gitMode ? undefined : cumulativeExplicitFiles();
      pendingBeforeSnapshot = {
        prompt: event.prompt,
        beforeSnapshot: await snap.track(snapshotFiles),
        snapshotFiles,
      };
    } catch (error) {
      pendingBeforeSnapshot = undefined;
      ctx.ui.notify(`Pi undo/redo checkpoint skipped: ${message(error)}`, "warning");
    }
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant" || active || pendingBeforeSnapshot === undefined) return;
    const pending = pendingBeforeSnapshot;

    const branch = ctx.sessionManager.getBranch();
    const userEntry = findLatestUserByText(branch, pending.prompt);
    if (!userEntry) {
      pendingBeforeSnapshot = undefined;
      ctx.ui.notify("Pi undo/redo checkpoint skipped: submitted user message was not found in the session branch", "warning");
      return;
    }

    pendingBeforeSnapshot = undefined;
    active = {
      userEntryId: userEntry.id,
      beforeLeafId: userEntry.parentId,
      prompt: userText(userEntry.message!),
      beforeSnapshot: pending.beforeSnapshot,
      snapshotFiles: new Set(pending.snapshotFiles ?? []),
      touchedFiles: new Set(),
      warnedNonGitShell: false,
      hadToolCall: false,
    };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (!active && !pendingBeforeSnapshot) return;
    if (active) active.hadToolCall = true;
    let snap: ShadowGit;
    try {
      snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (await snap.isGitMode()) return;
    } catch (error) {
      // Setup failures happen before a path is identified, so this turn's checkpoint is
      // dropped rather than keeping coverage the warning cannot stand behind.
      active = undefined;
      pendingBeforeSnapshot = undefined;
      notifyCaptureSkip(ctx, `non-git snapshot bookkeeping failed (${message(error)}); this turn's checkpoint is skipped`);
      return;
    }
    if (event.toolName === "write" || event.toolName === "edit") {
      await captureExplicitToolPath(snap, event.input?.path, event.toolName === "write" ? event.input?.content : undefined, ctx);
      return;
    }
    if (event.toolName === "bash" && active && !active.warnedNonGitShell) {
      active.warnedNonGitShell = true;
      ctx.ui.notify(
        "Pi undo/redo non-git mode only restores files explicitly touched by Pi write/edit tools; shell-created paths are not undo-restorable.",
        "warning",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    active = undefined;
    pendingBeforeSnapshot = undefined;
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (suppressTreeRestore > 0) return;
    if (active || pendingBeforeSnapshot) {
      active = undefined;
      pendingBeforeSnapshot = undefined;
    }
    try {
      const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (!(await snap.available())) return;
      const gitMode = await snap.isGitMode();
      const target = resolveSnapshotForLeaf(ctx.sessionManager.getBranch(event.preparation.targetId), event.preparation.targetId, gitMode);
      if (!target) return;
      const dirty = await snap.dirtyFiles(target.files);
      if (dirty.length === 0) return;
      const affected = await changedFilesForTarget(snap, target, gitMode);
      const risky = intersectRiskyPaths(dirty, affected);
      if (risky.length === 0) return;
      ctx.ui.notify(formatDirtyGuardMessage("/tree", risky), "warning");
      return { cancel: true };
    } catch (error) {
      ctx.ui.notify(`Dirty guard failed: ${message(error)}`, "error");
      return { cancel: true };
    }
  });

  pi.on("session_tree", async (event, ctx) => {
    if (suppressTreeRestore > 0) return;
    try {
      const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (!(await snap.available())) return;
      const gitMode = await snap.isGitMode();
      const target = resolveSnapshotForLeaf(ctx.sessionManager.getBranch(event.newLeafId ?? undefined), event.newLeafId, gitMode);
      if (!target) return;
      if (event.oldLeafId && event.oldLeafId !== event.newLeafId) {
        const previous = resolveSnapshotForLeaf(ctx.sessionManager.getBranch(event.oldLeafId), event.oldLeafId, gitMode);
        redoStack.length = 0;
        redoStack.push({ leafId: event.oldLeafId, snapshot: previous?.snapshot, snapshotFiles: previous?.files });
        pi.appendEntry(REDO_EXT, redoStack);
      }
      if (!gitMode && target.restoreGroups) {
        for (const group of target.restoreGroups) await snap.restoreSnapshot(group.snapshot, group.files);
      } else {
        await snap.restoreSnapshot(target.snapshot, target.files);
      }
      pi.appendEntry(REDO_EXT, redoStack);
      const modeNote = gitMode ? "" : ` (${target.files?.length ?? 0} explicit file(s))`;
      ctx.ui.notify(`Restored workspace for /tree (${target.reason})${modeNote}`, "info");
    } catch (error) {
      ctx.ui.notify(`Tree workspace restore failed: ${message(error)}`, "error");
    }
  });

  pi.on("agent_end", async (_event, ctx) => {
    await finalizeActiveCheckpoint(ctx);
  });

  registerUndo("undo", "Undo the last user message and restore its changed files");
  registerRedo("redo", "Redo the last undone message and changed files");
  pi.registerCommand("undo-cleanup", {
    description: "Conservatively prune old protected pi-undo-redo shadow-git snapshot refs",
    handler: async (_args, ctx) => cleanup(ctx),
  });

  function registerUndo(name: string, description: string) {
    pi.registerCommand(name, { description, handler: async (_args, ctx) => undo(ctx) });
  }

  function registerRedo(name: string, description: string) {
    pi.registerCommand(name, { description, handler: async (_args, ctx) => redo(ctx) });
  }

  async function undo(ctx: ExtensionCommandContext) {
    active = undefined;
    pendingBeforeSnapshot = undefined;
    await ctx.waitForIdle();
    const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
    if (!(await snap.available())) {
      ctx.ui.notify("Pi undo/redo is disabled for the current workspace", "warning");
      return;
    }

    const branch = ctx.sessionManager.getBranch();
    const target = [...branch].reverse().find(isUserMessageEntry);

    if (!target) {
      ctx.ui.notify("No user message to undo", "warning");
      return;
    }

    const checkpoint = checkpoints.get(target.id);
    const beforeLeafId = checkpoint?.beforeLeafId ?? target.parentId;
    if (!beforeLeafId) {
      ctx.ui.notify("Cannot undo the first session message in-place; fork before it instead.", "warning");
      return;
    }

    let pushedRedo = false;
    let restoredCheckpoint = false;
    let navigationCompleted = false;
    const popPushedRedo = () => {
      if (!pushedRedo) return;
      redoStack.pop();
      pushedRedo = false;
      pi.appendEntry(REDO_EXT, redoStack);
    };
    const restoreAfterSnapshotBestEffort = async () => {
      if (!checkpoint || !restoredCheckpoint) return undefined;
      try {
        await snap.revertFiles(checkpoint.afterSnapshot, checkpoint.files);
        restoredCheckpoint = false;
        return undefined;
      } catch (rollbackError) {
        return message(rollbackError);
      }
    };
    try {
      if (checkpoint) {
        const dirty = await snap.dirtyFiles(checkpoint.files);
        const risky = intersectRiskyPaths(dirty, new Set(checkpoint.files));
        if (risky.length > 0) {
          ctx.ui.notify(formatDirtyGuardMessage("/undo", risky), "warning");
          return;
        }
        await snap.revertFiles(checkpoint.beforeSnapshot, checkpoint.files);
        restoredCheckpoint = true;
      }

      redoStack.push({ checkpoint, leafId: ctx.sessionManager.getLeafId(), prompt: userText(target.message!) });
      pushedRedo = true;
      pi.appendEntry(REDO_EXT, redoStack);
      suppressTreeRestore++;
      let result: { cancelled: boolean };
      try {
        result = await ctx.navigateTree(beforeLeafId, { summarize: false, label: "undo" });
      } finally {
        suppressTreeRestore--;
      }
      if (result.cancelled) {
        popPushedRedo();
        const rollbackError = await restoreAfterSnapshotBestEffort();
        if (rollbackError) ctx.ui.notify(`Undo navigation cancelled; workspace rollback failed: ${rollbackError}`, "error");
        return;
      }
      navigationCompleted = true;
      ctx.ui.setEditorText(checkpoint?.prompt ?? userText(target.message!));
      const fileCount = checkpoint?.files.length ?? 0;
      ctx.ui.notify(fileCount > 0 ? `Undid message; restored ${fileCount} file(s)` : "Undid message", "info");
    } catch (error) {
      if (!navigationCompleted) popPushedRedo();
      const rollbackError = !navigationCompleted ? await restoreAfterSnapshotBestEffort() : undefined;
      const rollbackNote = rollbackError ? `; workspace rollback failed: ${rollbackError}` : "";
      ctx.ui.notify(`Undo failed: ${message(error)}${rollbackNote}`, "error");
    }
  }

  async function cleanup(ctx: ExtensionCommandContext) {
    await ctx.waitForIdle();
    try {
      const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (!(await snap.available())) {
        ctx.ui.notify("Pi undo/redo cleanup skipped: current workspace is not a git repository", "warning");
        return;
      }
      const removed = await snap.cleanupSnapshots(liveSnapshotIds());
      ctx.ui.notify(
        removed > 0
          ? `Pi undo/redo cleanup pruned ${removed} old protected snapshot ref(s)`
          : "Pi undo/redo cleanup found no old snapshot refs to prune",
        "info",
      );
    } catch (error) {
      ctx.ui.notify(`Pi undo/redo cleanup failed: ${message(error)}`, "error");
    }
  }

  async function redo(ctx: ExtensionCommandContext) {
    active = undefined;
    pendingBeforeSnapshot = undefined;
    await ctx.waitForIdle();
    const item = redoStack.pop();
    if (!item) {
      ctx.ui.notify("Nothing to redo", "warning");
      return;
    }

    try {
      const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (item.checkpoint) {
        const dirty = await snap.dirtyFiles(item.checkpoint.files);
        const risky = intersectRiskyPaths(dirty, new Set(item.checkpoint.files));
        if (risky.length > 0) {
          redoStack.push(item);
          ctx.ui.notify(formatDirtyGuardMessage("/redo", risky), "warning");
          return;
        }
        await snap.revertFiles(item.checkpoint.afterSnapshot, item.checkpoint.files);
      } else if (item.snapshot) {
        const pathLimit = (await snap.isGitMode()) ? undefined : item.snapshotFiles;
        const dirty = await snap.dirtyFiles(pathLimit);
        const affected = await snap.changedFilesForSnapshot(item.snapshot, pathLimit);
        const risky = intersectRiskyPaths(dirty, affected);
        if (risky.length > 0) {
          redoStack.push(item);
          ctx.ui.notify(formatDirtyGuardMessage("/redo", risky), "warning");
          return;
        }
        await snap.restoreSnapshot(item.snapshot, pathLimit);
      }
      if (item.leafId) {
        suppressTreeRestore++;
        let result: { cancelled: boolean };
        try {
          result = await ctx.navigateTree(item.leafId, { summarize: false, label: "redo" });
        } finally {
          suppressTreeRestore--;
        }
        if (result.cancelled) {
          redoStack.push(item);
          pi.appendEntry(REDO_EXT, redoStack);
          return;
        }
      }
      pi.appendEntry(REDO_EXT, redoStack);
      ctx.ui.setEditorText("");
      const fileCount = item.checkpoint?.files.length ?? 0;
      ctx.ui.notify(fileCount > 0 ? `Redid message; restored ${fileCount} file(s)` : "Redid message", "info");
    } catch (error) {
      redoStack.push(item);
      pi.appendEntry(REDO_EXT, redoStack);
      ctx.ui.notify(`Redo failed: ${message(error)}`, "error");
    }
  }

  function liveSnapshotIds() {
    const ids = new Set<string>();
    for (const checkpoint of checkpoints.values()) {
      ids.add(checkpoint.beforeSnapshot);
      ids.add(checkpoint.afterSnapshot);
    }
    for (const item of redoStack) {
      if (item.snapshot) ids.add(item.snapshot);
      if (item.checkpoint) {
        ids.add(item.checkpoint.beforeSnapshot);
        ids.add(item.checkpoint.afterSnapshot);
      }
    }
    if (active) ids.add(active.beforeSnapshot);
    if (pendingBeforeSnapshot) ids.add(pendingBeforeSnapshot.beforeSnapshot);
    return ids;
  }

  async function finalizeActiveCheckpoint(ctx: {
    cwd: string;
    sessionManager: { getSessionId(): string; getLeafId(): string | null };
    ui: { notify(message: string, level?: "warning" | "info" | "error"): void };
  }) {
    if (!active) return;
    const current = active;
    active = undefined;
    pendingBeforeSnapshot = undefined;

    try {
      const snap = await getSnapshotter(ctx.cwd, ctx.sessionManager.getSessionId());
      if (!(await snap.available())) return;
      const touchedFiles = [...current.touchedFiles];
      const snapshotFiles = unique([...current.snapshotFiles, ...touchedFiles]);
      const gitMode = await snap.isGitMode();
      // A turn without a single tool call cannot have changed the workspace, so the before
      // snapshot is still current: reuse it instead of walking the tree a second time.
      const untouchedTurn = gitMode && !current.hadToolCall;
      const afterSnapshot = untouchedTurn ? current.beforeSnapshot : await snap.track(gitMode ? touchedFiles : snapshotFiles);
      const files = untouchedTurn ? [] : await snap.patchFiles(current.beforeSnapshot, touchedFiles);
      const checkpoint: Checkpoint = {
        userEntryId: current.userEntryId,
        beforeLeafId: current.beforeLeafId,
        prompt: current.prompt,
        beforeSnapshot: current.beforeSnapshot,
        finalLeafId: ctx.sessionManager.getLeafId() ?? current.userEntryId,
        afterSnapshot,
        files,
        createdAt: Date.now(),
      };
      checkpoints.set(checkpoint.userEntryId, checkpoint);
      pi.appendEntry(EXT, checkpoint);
    } catch (error) {
      ctx.ui.notify(`Pi undo/redo checkpoint finalization failed: ${message(error)}`, "warning");
    }
  }

  function cumulativeExplicitFiles() {
    const files = new Set<string>();
    for (const checkpoint of checkpoints.values()) {
      for (const file of checkpoint.files) files.add(file);
    }
    return [...files];
  }

  async function changedFilesForTarget(snap: ShadowGit, target: SnapshotTarget, gitMode: boolean) {
    if (gitMode || !target.restoreGroups) return snap.changedFilesForSnapshot(target.snapshot, target.files);
    const affected = new Set<string>();
    for (const group of target.restoreGroups) {
      for (const file of await snap.changedFilesForSnapshot(group.snapshot, group.files)) affected.add(file);
    }
    return affected;
  }

  function resolveSnapshotForLeaf(branch: SessionEntry[], leafId: string | null, gitMode: boolean) {
    if (checkpoints.size === 0) return;
    const index = new Map(branch.map((entry, i) => [entry.id, i] as const));
    let best: SnapshotTarget | undefined;
    let fallback: SnapshotTarget | undefined;

    const addRestoreGroup = (groups: Map<string, Set<string>>, snapshot: string, files: Iterable<string>) => {
      let group = groups.get(snapshot);
      if (!group) {
        group = new Set<string>();
        groups.set(snapshot, group);
      }
      for (const file of files) group.add(file);
    };

    const firstTouchBeforeRestoreGroups = (files: Iterable<string>) => {
      const pending = new Set(files);
      const groups = new Map<string, Set<string>>();
      if (pending.size === 0) return [];
      for (const checkpoint of checkpoints.values()) {
        const firstTouchedHere = checkpoint.files.filter((file) => pending.has(file));
        if (firstTouchedHere.length === 0) continue;
        addRestoreGroup(groups, checkpoint.beforeSnapshot, firstTouchedHere);
        for (const file of firstTouchedHere) pending.delete(file);
        if (pending.size === 0) break;
      }
      return [...groups].map(([snapshot, groupFiles]) => ({ snapshot, files: [...groupFiles] }));
    };

    const rootRestoreTarget = () => {
      if (gitMode || leafId) return undefined;
      const files = cumulativeExplicitFiles();
      if (files.length === 0) return undefined;
      const restoreGroups = firstTouchBeforeRestoreGroups(files);
      return {
        snapshot: emptySnapshot(),
        files: filesForRestoreGroups(restoreGroups),
        restoreGroups,
        score: -1,
        reason: "before first checkpoint",
      };
    };

    const nonGitRestoreGroups = (targetSnapshot: string, score: number, includeFiles: string[] = []) => {
      if (gitMode) return undefined;
      const targetFiles = new Set<string>(includeFiles);
      const rootFiles = new Set<string>();
      for (const checkpoint of checkpoints.values()) {
        for (const file of checkpoint.files) rootFiles.add(file);
        const after = index.get(checkpoint.finalLeafId);
        if (after !== undefined && after <= score) {
          for (const file of checkpoint.files) targetFiles.add(file);
        }
      }
      const groups = new Map<string, Set<string>>();
      const existingAtTarget = [...targetFiles];
      if (existingAtTarget.length > 0) addRestoreGroup(groups, targetSnapshot, existingAtTarget);
      const absentAtTarget = [...rootFiles].filter((file) => !targetFiles.has(file));
      for (const group of firstTouchBeforeRestoreGroups(absentAtTarget)) addRestoreGroup(groups, group.snapshot, group.files);
      return [...groups].map(([snapshot, groupFiles]) => ({ snapshot, files: [...groupFiles] }));
    };

    const filesForRestoreGroups = (restoreGroups?: SnapshotRestoreGroup[]) => {
      if (gitMode) return undefined;
      const files = new Set<string>();
      for (const group of restoreGroups ?? []) {
        for (const file of group.files) files.add(file);
      }
      return [...files];
    };
    if (!leafId) return rootRestoreTarget();
    const keepBest = (candidate: SnapshotTarget) => {
      if (!best || candidate.score > best.score) best = candidate;
    };
    const keepFallback = (candidate: SnapshotTarget) => {
      if (!fallback || candidate.score > fallback.score) fallback = candidate;
    };

    for (const checkpoint of checkpoints.values()) {
      const after = index.get(checkpoint.finalLeafId);
      if (after !== undefined) {
        const restoreGroups = nonGitRestoreGroups(checkpoint.afterSnapshot, after);
        keepBest({
          snapshot: checkpoint.afterSnapshot,
          files: filesForRestoreGroups(restoreGroups),
          restoreGroups,
          score: after,
          reason: "after checkpoint",
        });
        continue;
      }

      const atUser = index.get(checkpoint.userEntryId);
      if (atUser !== undefined) {
        const restoreGroups = nonGitRestoreGroups(checkpoint.beforeSnapshot, atUser, checkpoint.files);
        keepBest({
          snapshot: checkpoint.beforeSnapshot,
          files: filesForRestoreGroups(restoreGroups),
          restoreGroups,
          score: atUser,
          reason: "before checkpoint",
        });
        continue;
      }

      if (checkpoint.beforeLeafId) {
        const before = index.get(checkpoint.beforeLeafId);
        if (before !== undefined) {
          const restoreGroups = nonGitRestoreGroups(checkpoint.beforeSnapshot, before, checkpoint.files);
          keepFallback({
            snapshot: checkpoint.beforeSnapshot,
            files: filesForRestoreGroups(restoreGroups),
            restoreGroups,
            score: before,
            reason: "before next checkpoint",
          });
        }
      }
    }

    return best ?? fallback ?? rootRestoreTarget();
  }

  async function getSnapshotter(cwd: string, sessionId: string) {
    if (!snapshotter) snapshotter = new ShadowGit(cwd, sessionId, await loadSettings(cwd));
    return snapshotter;
  }

  async function captureExplicitToolPath(
    snap: ShadowGit,
    rawPath: unknown,
    rawContent: unknown,
    ctx: { cwd: string; ui: { notify(message: string, level?: "warning" | "info" | "error"): void } },
  ) {
    let rel: string | undefined;
    try {
      if (typeof rawPath !== "string") throw new Error("tool input has no string path");
      rel = await snap.resolveWorkspacePath(rawPath, ctx.cwd);
      // A path skipped once this turn stays out of the checkpoint: capturing it later
      // would record a mid-turn state as the message's before-state.
      if (skippedPaths.has(rel)) return;
      const skipReason = await snap.explicitPathSkipReason(rel, rawContent);
      if (skipReason) {
        skippedPaths.add(rel);
        // Drop the turn's claim on this path. `snapshotFiles` stays cumulative so the
        // turn's after-snapshot keeps its current content for /tree and /redo.
        active?.touchedFiles.delete(rel);
        notifyCaptureSkip(ctx, `${rel} is not snapshotted this turn (${skipReason}); this change has no undo coverage`);
        return;
      }
      if (!active) return;
      if (!active.snapshotFiles.has(rel)) {
        active.beforeSnapshot = await snap.capturePathBefore(rel, active.beforeSnapshot);
        active.snapshotFiles.add(rel);
      }
      active.touchedFiles.add(rel);
    } catch (error) {
      if (rel) {
        skippedPaths.add(rel);
        active?.touchedFiles.delete(rel);
      }
      notifyCaptureSkip(ctx, `${String(rawPath)} is not snapshotted this turn (${message(error)}); this change has no undo coverage`);
    }
  }

  function notifyCaptureSkip(ctx: { ui: { notify(message: string, level?: "warning" | "info" | "error"): void } }, detail: string) {
    if (warnedCaptureSkip) return;
    warnedCaptureSkip = true;
    ctx.ui.notify(`Pi undo/redo: ${detail}. The edit is not blocked.`, "warning");
  }
}

class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.tail;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export class ShadowGit {
  private initialized = false;
  private repoRoot: string | undefined;
  private sourceGitDir: string | undefined;
  private gitdir: string | undefined;
  private readonly cwd: string;
  private readonly sessionId: string;
  private readonly settings: Settings;
  private readonly mutex = new AsyncMutex();

  constructor(cwd: string, sessionId: string, settings: Settings) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.settings = settings;
    // Match OpenCode's storage model: one shadow git repository per resolved
    // git worktree, not per chat session or launch cwd. The key is set after
    // rev-parse resolves the source repository root so subdirectory launches
    // share the same shadow repo.
  }

  async available(): Promise<boolean> {
    if (!this.settings.enabled) return false;
    try {
      return await this.mutex.run(async () => {
        await this.ensureRepoInfo();
        return Boolean(this.repoRoot && this.gitdir);
      });
    } catch {
      return false;
    }
  }

  async changedFilesForSnapshot(snapshot: string, files?: string[]): Promise<Set<string>> {
    return this.mutex.run(() => this.changedFilesForSnapshotImpl(snapshot, files));
  }

  async dirtyFiles(files?: string[]): Promise<string[]> {
    return this.mutex.run(() => this.dirtyFilesImpl(files));
  }

  async track(files?: string[]): Promise<string> {
    return this.mutex.run(() => this.trackImpl(files));
  }

  async patchFiles(from: string, files?: string[]): Promise<string[]> {
    return this.mutex.run(() => this.patchFilesImpl(from, files));
  }

  async restoreSnapshot(snapshot: string, files?: string[]): Promise<void> {
    return this.mutex.run(() => this.restoreSnapshotImpl(snapshot, files));
  }

  async revertFiles(snapshot: string, files: string[]): Promise<void> {
    return this.mutex.run(() => this.revertFilesImpl(snapshot, files));
  }

  async cleanupSnapshots(liveSnapshots: Iterable<string> = [], maxRefs = 256): Promise<number> {
    return this.mutex.run(() => this.cleanupSnapshotsImpl(maxRefs, new Set(liveSnapshots)));
  }

  getStorageKey(): string | undefined {
    return this.gitdir ? path.basename(path.dirname(this.gitdir)) : undefined;
  }

  getShadowGitDir(): string | undefined {
    return this.gitdir;
  }

  async isGitMode(): Promise<boolean> {
    await this.ensureRepoInfo();
    return Boolean(this.sourceGitDir);
  }

  async resolveWorkspacePath(rawPath: string, cwd: string): Promise<string> {
    await this.ensureRepoInfo();
    if (this.sourceGitDir) {
      const normalized = normalizeRelPath(rawPath);
      if (!normalized) throw new Error(`unsafe path: ${rawPath}`);
      return normalized;
    }
    return resolveSafeWorkspacePath(rawPath, cwd, this.root());
  }

  async capturePathBefore(rel: string, baseSnapshot: string): Promise<string> {
    return this.mutex.run(async () => {
      await this.ensure();
      if (this.sourceGitDir) return baseSnapshot;
      await this.readTree(baseSnapshot);
      await this.addChanged([rel]);
      return this.writeProtectedTree();
    });
  }

  async explicitPathSkipReason(rel: string, content?: unknown): Promise<string | undefined> {
    await this.ensureRepoInfo();
    if (this.sourceGitDir) return undefined;
    if (typeof content === "string" && Buffer.byteLength(content, "utf8") > this.settings.largeFileLimitBytes) {
      return `written content exceeds largeFileLimitBytes (${this.settings.largeFileLimitBytes})`;
    }
    const info = await stat(path.join(this.root(), rel)).catch(() => undefined);
    if (info?.isDirectory()) return "path is a directory";
    if (info?.isFile() && info.size > this.settings.largeFileLimitBytes) {
      return `existing file exceeds largeFileLimitBytes (${this.settings.largeFileLimitBytes})`;
    }
    return undefined;
  }

  private async changedFilesForSnapshotImpl(snapshot: string, files?: string[]): Promise<Set<string>> {
    await this.ensure();
    const paths = this.pathspecOrDot(files);
    if (!this.sourceGitDir && paths.length === 0) return new Set();
    const result = await this.git(this.shadowArgs(["diff", "--cached", "--name-only", "-z", "--no-renames", snapshot, "--", ...paths]));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git diff failed");
    return new Set(splitNul(result.stdout).map(normalizeRelPath).filter(isString));
  }

  private async dirtyFilesImpl(files?: string[]): Promise<string[]> {
    await this.ensure();
    const paths = this.pathspecOrDot(files);
    if (!this.sourceGitDir) {
      if (paths.length === 0) return [];
      const [managedDiff, managedTracked] = await Promise.all([
        this.git(this.shadowArgs(["diff-files", "--name-only", "-z", "--", ...paths])),
        this.git(this.shadowArgs(["ls-files", "-z", "--", ...paths])),
      ]);
      if (managedDiff.code !== 0 || managedTracked.code !== 0) {
        throw new Error(managedDiff.stderr || managedTracked.stderr || "failed to list dirty files");
      }
      const trackedByShadow = new Set(splitNul(managedTracked.stdout).map(normalizeRelPath).filter(isString));
      const untracked = await this.untrackedExistingPaths(paths, trackedByShadow);
      return unique([...splitNul(managedDiff.stdout).map(normalizeRelPath).filter(isString), ...untracked]);
    }

    const [managedDiff, managedTracked, sourceOther] = await Promise.all([
      this.git(this.shadowArgs(["diff-files", "--name-only", "-z", "--", ...paths])),
      this.git(this.shadowArgs(["ls-files", "-z", "--", ...paths])),
      this.git(this.sourceArgs(["ls-files", "--others", "--exclude-standard", "-z", "--", ...paths])),
    ]);
    if (managedDiff.code !== 0 || managedTracked.code !== 0 || sourceOther.code !== 0) {
      throw new Error(managedDiff.stderr || managedTracked.stderr || sourceOther.stderr || "failed to list dirty files");
    }
    const trackedByShadow = new Set(splitNul(managedTracked.stdout).map(normalizeRelPath).filter(isString));
    return unique([
      ...splitNul(managedDiff.stdout).map(normalizeRelPath).filter(isString),
      ...splitNul(sourceOther.stdout)
        .map(normalizeRelPath)
        .filter(isString)
        .filter((file) => !trackedByShadow.has(file)),
    ]);
  }

  private async trackImpl(files?: string[]): Promise<string> {
    await this.ensure();
    if (!this.sourceGitDir && files === undefined) {
      await this.clearIndex();
      return this.writeProtectedTree();
    }
    await this.addChanged(files);
    return this.writeProtectedTree();
  }

  private async patchFilesImpl(from: string, files?: string[]): Promise<string[]> {
    await this.ensure();
    await this.addChanged(files);
    const paths = this.pathspecOrDot(files);
    if (!this.sourceGitDir && paths.length === 0) return [];
    const result = await this.git(this.shadowArgs(["diff", "--cached", "--no-ext-diff", "--name-only", from, "--", ...paths]));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git diff failed");
    return unique(result.stdout.split("\n").map((line) => normalizeRelPath(line)).filter(isString));
  }

  private async restoreSnapshotImpl(snapshot: string, files?: string[]): Promise<void> {
    await this.ensure();
    const changed = [...(await this.changedFilesForSnapshotImpl(snapshot, files))];
    const safeFiles = this.sourceGitDir ? changed : this.limitToKnownFiles(changed, files);
    await this.revertFilesImpl(snapshot, safeFiles);
  }

  private async revertFilesImpl(snapshot: string, files: string[]): Promise<void> {
    await this.ensure();
    const reverted: string[] = [];
    for (const file of unique(files)) {
      const rel = normalizeRelPath(file);
      if (!rel) continue;
      const tree = await this.git(this.shadowArgs(["ls-tree", snapshot, "--", rel]));
      if (tree.code === 0 && tree.stdout.trim()) {
        const checkout = await this.git(this.shadowArgs(["checkout", snapshot, "--", rel]));
        if (checkout.code !== 0) throw new Error(checkout.stderr || checkout.stdout || `git checkout ${rel} failed`);
      } else {
        await this.safeRemovePath(rel);
      }
      reverted.push(rel);
    }
    await this.addChanged(this.sourceGitDir ? undefined : reverted);
  }

  private async cleanupSnapshotsImpl(maxRefs: number, liveSnapshots: Set<string>): Promise<number> {
    await this.ensure();
    const limit = Math.max(0, Math.floor(maxRefs));
    const list = await this.git(this.shadowArgs(["for-each-ref", "--sort=-creatordate", "--format=%(refname)", "refs/pi-undo-redo/snapshots"]), {
      allowFailure: true,
    });
    if (list.code !== 0) throw new Error(list.stderr || list.stdout || "git for-each-ref failed");
    const refs = list.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    let removed = 0;
    for (const ref of refs.slice(limit)) {
      if (!ref.startsWith("refs/pi-undo-redo/snapshots/")) continue;
      const snapshot = ref.slice("refs/pi-undo-redo/snapshots/".length);
      if (liveSnapshots.has(snapshot)) continue;
      const update = await this.git(this.shadowArgs(["update-ref", "-d", ref]));
      if (update.code !== 0) throw new Error(update.stderr || update.stdout || `git update-ref -d ${ref} failed`);
      removed++;
    }
    return removed;
  }

  private async safeRemovePath(rel: string): Promise<void> {
    const currentShadow = await this.pathKind(rel);
    if (currentShadow === "directory") {
      throw new Error(`Refusing to restore file over shadow-tracked directory: ${rel}`);
    }
    const target = path.join(this.root(), rel);
    const info = await lstat(target).catch(() => undefined);
    if (!info) return;
    if (info.isDirectory()) {
      const tracked = await this.git(this.shadowArgs(["ls-files", "-z", "--", rel]));
      const trackedFiles = splitNul(tracked.stdout).map(normalizeRelPath).filter(isString);
      if (trackedFiles.length > 0) {
        throw new Error(`Refusing to recursively remove directory with tracked contents: ${rel}`);
      }
      throw new Error(`Refusing to recursively remove directory for file restore: ${rel}`);
    }
    await rm(target, { force: true });
  }

  private async pathKind(rel: string): Promise<"file" | "directory" | undefined> {
    const result = await this.git(this.shadowArgs(["ls-tree", "-z", "HEAD", "--", rel]), { allowFailure: true });
    if (result.code !== 0 || !result.stdout) return undefined;
    const first = splitNul(result.stdout)[0] ?? "";
    const meta = first.split("\t", 1)[0] ?? "";
    const modeType = meta.split(/\s+/);
    const kind = modeType[1];
    if (kind === "tree") return "directory";
    if (kind === "blob" || kind === "commit") return "file";
    return undefined;
  }

  private async protectSnapshot(snapshot: string): Promise<void> {
    const ref = `refs/pi-undo-redo/snapshots/${snapshot}`;
    // Already protected: recreating the commit would add a dangling object and two git processes
    // for every no-op snapshot. Packed refs fall through to the explicit call below.
    if (existsSync(path.join(this.shadow(), "refs", "pi-undo-redo", "snapshots", snapshot))) return;
    const commit = await this.git(this.shadowArgs(["commit-tree", snapshot, "-m", `[pi-undo-redo] ${snapshot}`]));
    if (commit.code !== 0) throw new Error(commit.stderr || commit.stdout || "git commit-tree failed");
    const update = await this.git(this.shadowArgs(["update-ref", ref, commit.stdout.trim()]));
    if (update.code !== 0) throw new Error(update.stderr || update.stdout || "git update-ref failed");
  }

  private async ensure(): Promise<void> {
    await this.ensureRepoInfo();
    const gitdir = this.shadow();
    await mkdir(gitdir, { recursive: true });
    if (!this.initialized) {
      if (!existsSync(path.join(gitdir, "HEAD"))) {
        const init = await this.git(["init"], { env: { GIT_DIR: gitdir, GIT_WORK_TREE: this.root() } });
        if (init.code !== 0) throw new Error(init.stderr || init.stdout || "git init failed");
        await this.git(["--git-dir", gitdir, "config", "core.autocrlf", "false"]);
        await this.git(["--git-dir", gitdir, "config", "core.longpaths", "true"]);
        await this.git(["--git-dir", gitdir, "config", "core.symlinks", "true"]);
        await this.git(["--git-dir", gitdir, "config", "core.fsmonitor", "false"]);
      }
      // Written once per instance: running these on every call cost two git processes for values
      // that never change.
      const name = await this.git(["--git-dir", gitdir, "config", "user.name", "pi-undo-redo"]);
      if (name.code !== 0) throw new Error(name.stderr || name.stdout || "git config user.name failed");
      const email = await this.git(["--git-dir", gitdir, "config", "user.email", "pi-undo-redo@local"]);
      if (email.code !== 0) throw new Error(email.stderr || email.stdout || "git config user.email failed");
      this.initialized = true;
    }
  }

  private async ensureRepoInfo(): Promise<void> {
    if (this.repoRoot && this.gitdir) return;
    const root = await this.git(["-C", this.cwd, "rev-parse", "--show-toplevel"], { allowFailure: true });
    if (root.code === 0 && root.stdout.trim()) {
      this.repoRoot = path.resolve(root.stdout.trim());
      const gitDir = await this.git(["-C", this.repoRoot, "rev-parse", "--absolute-git-dir"]);
      if (gitDir.code !== 0) throw new Error("cannot resolve source git dir");
      this.sourceGitDir = path.resolve(gitDir.stdout.trim());
      const key = createHash("sha256").update(`git:${this.repoRoot}`).digest("hex").slice(0, 24);
      this.gitdir = path.join(this.settings.storageDir, "worktrees", key, "repo.git");
      return;
    }

    this.repoRoot = path.resolve(this.cwd);
    this.sourceGitDir = undefined;
    const key = createHash("sha256").update(`fs:${this.repoRoot}`).digest("hex").slice(0, 24);
    this.gitdir = path.join(this.settings.storageDir, "worktrees", key, "repo.git");
  }

  private async addChanged(files?: string[]): Promise<void> {
    await this.syncExclude();
    const paths = this.pathspecOrDot(files);
    if (!this.sourceGitDir && paths.length === 0) return;

    const trackedArgs = this.sourceGitDir ? this.sourceArgs(["ls-files", "-z", "--", ...paths]) : this.shadowArgs(["ls-files", "-z", "--", ...paths]);
    // One call covers both sides: --modified is index-vs-worktree (what diff-files reported) and
    // --others lists files the shadow index does not know. A git workspace has to prune ignored
    // trees there, or git descends into node_modules and every other ignored directory on each
    // snapshot, which costs seconds per message on ordinary web projects; every one of those paths
    // is then discarded by the check-ignore pass below. Tracked-but-ignored paths are re-admitted
    // from the shadow index, so pruning here does not shrink snapshot coverage.
    const changedArgs = ["ls-files", "--modified", "--others", ...(this.sourceGitDir ? ["--exclude-standard"] : [])];
    const [changed, sourceTracked] = await Promise.all([
      this.git(this.shadowArgs([...changedArgs, "-z", "--", ...paths])),
      this.git(trackedArgs),
    ]);
    if (changed.code !== 0 || sourceTracked.code !== 0) {
      throw new Error(changed.stderr || changed.stdout || sourceTracked.stderr || "failed to list snapshot files");
    }

    const sourceTrackedSet = new Set(splitNul(sourceTracked.stdout).map(normalizeRelPath).filter(isString));
    const candidates = unique([
      ...splitNul(changed.stdout).map(normalizeRelPath).filter(isString),
      ...(!this.sourceGitDir ? await this.untrackedExistingPaths(paths, new Set()) : await this.missingFromShadowIndex(sourceTrackedSet)),
    ]);
    if (candidates.length === 0) return;

    const sourceUntracked = candidates.filter((file) => !sourceTrackedSet.has(file));
    const sourceUntrackedSet = new Set(sourceUntracked);
    const ignored = await this.checkIgnored(sourceUntracked);
    if (ignored.size > 0) await this.drop([...ignored]);

    const large = new Set<string>();
    await Promise.all(
      sourceUntracked.map(async (file) => {
        if (ignored.has(file)) return;
        try {
          const s = await stat(path.join(this.root(), file));
          if (s.isFile() && s.size > this.settings.largeFileLimitBytes) large.add(file);
        } catch {
          // ignore races with deleted files
        }
      }),
    );

    if (large.size > 0) await this.syncExclude([...large]);
    const stage = candidates.filter((file) => !sourceUntrackedSet.has(file) || (!ignored.has(file) && !large.has(file)));
    if (stage.length === 0) return;

    const result = await this.git(this.shadowArgs(["add", "--all", "--sparse", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"]), {
      stdin: feed(stage),
    });
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git add failed");
  }

  private async readTree(snapshot: string): Promise<void> {
    const result = await this.git(this.shadowArgs(["read-tree", snapshot]));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git read-tree failed");
  }

  private async clearIndex(): Promise<void> {
    const result = await this.git(this.shadowArgs(["read-tree", "--empty"]));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git read-tree --empty failed");
  }

  private async writeProtectedTree(): Promise<string> {
    const result = await this.git(this.shadowArgs(["write-tree"]));
    if (result.code !== 0) throw new Error(result.stderr || result.stdout || "git write-tree failed");
    const snapshot = result.stdout.trim();
    await this.protectSnapshot(snapshot);
    return snapshot;
  }

  private pathspecOrDot(files?: string[]): string[] {
    if (!files) return this.sourceGitDir ? ["."] : [];
    return unique(files.map(normalizeRelPath).filter(isString));
  }

  private limitToKnownFiles(files: string[], known?: string[]): string[] {
    if (!known) return files;
    const knownSet = new Set(known.map(normalizeRelPath).filter(isString));
    return files.filter((file) => {
      const normalized = normalizeRelPath(file);
      return Boolean(normalized && knownSet.has(normalized));
    });
  }

  private async untrackedExistingPaths(paths: string[], trackedByShadow: Set<string>): Promise<string[]> {
    const files = await Promise.all(
      paths.map(async (rel) => {
        const normalized = normalizeRelPath(rel);
        if (!normalized || trackedByShadow.has(normalized)) return undefined;
        try {
          const info = await stat(path.join(this.root(), normalized));
          if (info.isFile()) return normalized;
        } catch {
          // deleted paths are handled by git add --all for tracked paths
        }
        return undefined;
      }),
    );
    return unique(files.filter(isString));
  }

  /**
   * Source-tracked paths the shadow index does not know yet. Pruning ignored trees while listing
   * untracked files also hides tracked files that match an ignore rule, so those are collected
   * here instead. Deleted paths and directories are skipped: git add rejects a pathspec that does
   * not resolve to a file, while symlinks are added as links.
   */
  private async missingFromShadowIndex(sourceTracked: Set<string>): Promise<string[]> {
    const listed = await this.git(this.shadowArgs(["ls-files", "-z"]));
    if (listed.code !== 0) throw new Error(listed.stderr || listed.stdout || "failed to list shadow index files");
    const known = new Set(splitNul(listed.stdout).map(normalizeRelPath).filter(isString));
    const missing = await Promise.all(
      [...sourceTracked].map(async (rel) => {
        const normalized = normalizeRelPath(rel);
        if (!normalized || known.has(normalized)) return undefined;
        try {
          const info = await lstat(path.join(this.root(), normalized));
          if (info.isFile() || info.isSymbolicLink()) return normalized;
        } catch {
          // deleted paths are not stageable
        }
        return undefined;
      }),
    );
    return unique(missing.filter(isString));
  }

  private async checkIgnored(files: string[]): Promise<Set<string>> {
    if (!files.length) return new Set();
    const args = this.sourceGitDir
      ? ["--git-dir", this.source(), "--work-tree", this.root(), "check-ignore", "--no-index", "--stdin", "-z"]
      : this.shadowArgs(["check-ignore", "--no-index", "--stdin", "-z"]);
    const result = await this.git(args, { cwd: this.root(), stdin: feed(files), allowFailure: true });
    if (result.code !== 0 && result.code !== 1) return new Set();
    return new Set(splitNul(result.stdout).map(normalizeRelPath).filter(isString));
  }

  private async drop(files: string[]): Promise<void> {
    if (!files.length) return;
    await this.git(this.shadowArgs(["rm", "--cached", "-f", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"]), {
      stdin: feed(files),
      allowFailure: true,
    });
  }

  private async syncExclude(extra: string[] = []): Promise<void> {
    const sourceExclude = this.sourceGitDir ? path.join(this.source(), "info", "exclude") : undefined;
    const source = sourceExclude ? await readFile(sourceExclude, "utf8").catch(() => "") : "";
    const lines = [source.trimEnd(), ...extra.map((item) => `/${item.replaceAll("\\", "/")}`)].filter(Boolean);
    const excludePath = path.join(this.shadow(), "info", "exclude");
    await mkdir(path.dirname(excludePath), { recursive: true });
    await writeFile(excludePath, lines.length ? `${lines.join("\n")}\n` : "", "utf8");
  }

  private sourceArgs(args: string[]): string[] {
    return [
      "-c",
      "core.longpaths=true",
      "-c",
      "core.symlinks=true",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.quotepath=false",
      "--git-dir",
      this.source(),
      "--work-tree",
      this.root(),
      ...args,
    ];
  }

  private shadowArgs(args: string[]): string[] {
    return [
      "-c",
      "core.longpaths=true",
      "-c",
      "core.symlinks=true",
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.quotepath=false",
      "--git-dir",
      this.shadow(),
      "--work-tree",
      this.root(),
      ...args,
    ];
  }

  private root(): string {
    if (!this.repoRoot) throw new Error("repo root not initialized");
    return this.repoRoot;
  }

  private source(): string {
    if (!this.sourceGitDir) throw new Error("source git dir not initialized");
    return this.sourceGitDir;
  }

  private shadow(): string {
    if (!this.gitdir) throw new Error("shadow git dir not initialized");
    return this.gitdir;
  }

  private git(args: string[], opts: { cwd?: string; env?: Record<string, string>; stdin?: string; allowFailure?: boolean } = {}) {
    return execFile("git", args, {
      cwd: opts.cwd ?? this.rootOrCwd(),
      env: opts.env,
      stdin: opts.stdin,
      timeoutMs: this.settings.gitTimeoutMs,
      allowFailure: opts.allowFailure,
    });
  }

  private rootOrCwd() {
    return this.repoRoot ?? this.cwd;
  }
}

async function execFile(
  command: string,
  args: string[],
  opts: { cwd: string; env?: Record<string, string>; stdin?: string; timeoutMs: number; allowFailure?: boolean },
): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true,
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${command} ${args.join(" ")} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const result = {
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (!opts.allowFailure && result.code !== 0) reject(new Error(result.stderr || result.stdout || `${command} exited ${result.code}`));
      else resolve(result);
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
    else child.stdin.end();
  });
}

async function loadSettings(cwd: string): Promise<Settings> {
  const globalSettings = await readJson(path.join(getAgentDir(), "settings.json"));
  const projectSettings = await readJson(path.join(cwd, ".pi", "settings.json"));
  const raw = { ...(globalSettings.opencodeUndo ?? {}), ...(globalSettings.undoRedo ?? {}), ...(projectSettings.opencodeUndo ?? {}), ...(projectSettings.undoRedo ?? {}) } as Record<string, unknown>;
  return {
    enabled: raw.enabled !== false,
    storageDir: path.resolve(expandHome(typeof raw.storageDir === "string" ? raw.storageDir : path.join(getAgentDir(), "state", EXT))),
    largeFileLimitBytes: positiveInt(raw.largeFileLimitBytes, DEFAULT_LARGE_FILE_LIMIT),
    gitTimeoutMs: positiveInt(raw.gitTimeoutMs, DEFAULT_GIT_TIMEOUT),
  };
}

async function readJson(file: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return {};
  }
}

function getAgentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
}

function expandHome(value: string) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(homedir(), value.slice(2));
  return value;
}

function positiveInt(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function feed(values: string[]) {
  return values.join("\0") + "\0";
}

function splitNul(value: string) {
  return value.split("\0").filter(Boolean);
}

function emptySnapshot() {
  return "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
}

function normalizeRelPath(file: string): string | undefined {
  if (!file || file.includes("\0") || path.isAbsolute(file) || looksLikeWindowsAbsolute(file)) return;
  const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return;
  return normalized;
}

function looksLikeWindowsAbsolute(file: string) {
  return /^[A-Za-z]:[\\/]/.test(file) || file.startsWith("\\\\") || file.startsWith("//");
}

function resolveSafeWorkspacePath(rawPath: string, cwd: string, root: string): string {
  if (!rawPath || rawPath.includes("\0")) throw new Error("path is empty or contains NUL");
  if (isDangerousRootPath(rawPath)) throw new Error(`dangerous path is not restorable: ${rawPath}`);

  const rootAbs = path.resolve(root);
  const cwdAbs = path.resolve(cwd);
  if (!isInsideOrEqual(cwdAbs, rootAbs)) throw new Error(`cwd is outside workspace root: ${cwd}`);

  const inputPath = rawPath.replaceAll("\\", path.sep);
  const target = path.isAbsolute(inputPath) || looksLikeWindowsAbsolute(rawPath) ? path.resolve(inputPath) : path.resolve(cwdAbs, inputPath);
  if (!isInsideOrEqual(target, rootAbs)) throw new Error(`path escapes workspace root: ${rawPath}`);

  const rel = path.relative(rootAbs, target).replaceAll("\\", "/");
  const normalized = normalizeRelPath(rel);
  if (!normalized) throw new Error(`unsafe path: ${rawPath}`);
  if (isDangerousWorkspaceRel(normalized)) throw new Error(`dangerous path is not restorable: ${normalized}`);
  return normalized;
}

function isInsideOrEqual(candidate: string, root: string) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function isDangerousRootPath(rawPath: string) {
  const normalized = rawPath.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized === "/" || /^[A-Za-z]:$/.test(normalized) || /^[A-Za-z]:\/$/.test(normalized);
}

function isDangerousWorkspaceRel(rel: string) {
  const first = rel.split("/", 1)[0]?.toLowerCase();
  return first === ".git" || first === ".pi" || first === "node_modules";
}

function intersectRiskyPaths(dirty: string[], affected: Set<string>) {
  return dirty.filter((file) => {
    const normalized = normalizeRelPath(file);
    if (!normalized) return false;
    for (const item of affected) {
      if (pathsClash(normalized, item)) return true;
    }
    return false;
  });
}

function pathsClash(a: string, b: string) {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function formatDirtyGuardMessage(action: string, files: string[]) {
  const shown = files.slice(0, 12).map((file) => `  - ${file}`).join("\n");
  const more = files.length > 12 ? `\n  ... and ${files.length - 12} more` : "";
  return `Dirty guard blocked ${action}: ${files.length} unsnapshotted file(s) would be overwritten.\n\n${shown}${more}\n\nCommit/stash/revert those manual changes before retrying.`;
}

function unique<T>(values: T[]) {
  return [...new Set(values)];
}

function isString(value: string | undefined): value is string {
  return typeof value === "string";
}

function findLatestUserByText(branch: SessionEntry[], text: string) {
  return [...branch].reverse().find((entry) => isUserMessageEntry(entry) && userText(entry.message!) === text);
}

type UserMessageEntry = SessionEntry & { type: "message"; message: { role: "user"; content: unknown } };

function isUserMessageEntry(entry: SessionEntry): entry is UserMessageEntry {
  return entry.type === "message" && typeof entry.message === "object" && entry.message !== null && "role" in entry.message && entry.message.role === "user";
}

function userText(message: { content?: unknown }) {
  const content = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(block && typeof block === "object" && (block as { type?: unknown }).type === "text"),
    )
    .map((block) => block.text)
    .join("");
}

type ReadonlySessionLookup = {
  getEntry(id: string): SessionEntry | undefined;
  getBranch(fromId?: string): SessionEntry[];
};

function repairCheckpoint(value: Partial<Checkpoint> | undefined, sessions: ReadonlySessionLookup): Checkpoint | undefined {
  if (!isCheckpoint(value)) return;
  const original = sessions.getEntry(value.userEntryId);
  if (original && isUserMessageEntry(original) && userText(original.message!) === value.prompt) {
    return value;
  }
  const repairedUser = findLatestUserByText(sessions.getBranch(value.finalLeafId), value.prompt);
  if (!repairedUser) return;
  return { ...value, userEntryId: repairedUser.id, beforeLeafId: repairedUser.parentId };
}

function isCheckpoint(value: Partial<Checkpoint> | undefined): value is Checkpoint {
  return Boolean(
    value &&
      typeof value.userEntryId === "string" &&
      typeof value.finalLeafId === "string" &&
      typeof value.beforeSnapshot === "string" &&
      typeof value.afterSnapshot === "string" &&
      Array.isArray(value.files),
  );
}

function parseRedoStack(value: unknown): RedoItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): RedoItem[] => {
    if (!item || typeof item !== "object") return [];
    const raw = item as { checkpoint?: Partial<Checkpoint>; leafId?: unknown; prompt?: unknown; snapshot?: unknown; snapshotFiles?: unknown };
    const redo: RedoItem = {
      leafId: typeof raw.leafId === "string" ? raw.leafId : null,
      prompt: typeof raw.prompt === "string" ? raw.prompt : undefined,
      snapshot: typeof raw.snapshot === "string" ? raw.snapshot : undefined,
      snapshotFiles: Array.isArray(raw.snapshotFiles) ? raw.snapshotFiles.map((file) => normalizeRelPath(String(file))).filter(isString) : undefined,
    };
    if (isCheckpoint(raw.checkpoint)) redo.checkpoint = raw.checkpoint;
    return redo.leafId || redo.checkpoint ? [redo] : [];
  });
}

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
