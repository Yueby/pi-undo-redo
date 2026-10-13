# pi-undo-redo

Undo/redo for Pi conversations and workspace changes with hybrid git/non-git behavior.

In git repositories this extension keeps file snapshots in a shadow git repository and records per-message patch metadata in the Pi session. `/undo` navigates the conversation tree back to the previous user message and reverts only the files changed by the undone message(s). `/redo` restores the files and conversation leaf captured before undo.

In non-git directories it does **not** scan or snapshot the whole workspace. It snapshots only explicit file paths touched by Pi file tools that provide a path (`write` and `edit`). Shell commands and custom tools without explicit path metadata are not parsed for paths and are not promised to be undo-restorable. A non-git path outside the snapshot scope - outside the workspace root, under `.git`, `.pi`, or `node_modules`, a directory, or a file above `largeFileLimitBytes` - stays out of that turn's checkpoint and is reported with a single warning per turn.

The extension only records snapshots and navigates the conversation tree; it does not rewrite tool arguments and does not veto `write`/`edit` execution.

A dirty guard blocks `/undo`, `/redo`, and `/tree` when unsnapshotted workspace changes would be overwritten.

Checkpoints and redo history track user-prompt runs. An extension-triggered custom-message run (Pi 1.2 `messageType: "custom"`) leaves both untouched, so files written during such a run stay outside that run's undo coverage.

## Commands

- `/undo` - undo the latest checkpointed user message and restore changed files
- `/redo` - restore the last undone conversation/file state
- `/undo-cleanup` - conservatively prune old protected snapshot refs while keeping snapshots referenced by the current session state

## Configuration

Configure in `~/.pi/agent/settings.json` or `.pi/settings.json`:

```json
{
  "undoRedo": {
    "storageDir": "E:/pi-undo-redo",
    "largeFileLimitBytes": 2097152,
    "gitTimeoutMs": 30000,
    "enabled": true
  }
}
```

Defaults:

- `storageDir`: `~/.pi/agent/state/pi-undo-redo`
- `largeFileLimitBytes`: `2097152` (2 MiB). In non-git mode a path above this limit is excluded from the turn's checkpoint with a warning instead of being silently advertised as undo-restorable.
- `gitTimeoutMs`: `30000`
- `enabled`: `true`

## Hybrid behavior

### Git repositories

- Uses the existing shadow git snapshot behavior.
- Catches tracked modifications and ordinary non-ignored untracked files, including files created by shell/filesystem commands.
- Respects `.gitignore` and `.git/info/exclude` from the source repository.
- Maintains a shadow snapshot of source tracked files plus changed ordinary non-ignored untracked files; ignored files and large untracked files are not copied into the shadow repository.
- `/tree` restores the workspace snapshot that matches the selected conversation node.

### Non-git directories

- Does not root-wide scan/snapshot the cwd, home directory, or project root.
- Before-agent snapshots are empty and cheap; when a Pi `write` or `edit` tool is about to run, the extension snapshots only that explicit path's current state.
- Finalization snapshots after-state for those touched files only, supporting create/modify/delete for normal files where possible.
- `/undo` and `/redo` restore only `checkpoint.files` from the session checkpoint.
- `/tree` restores only the cumulative explicit checkpoint files along the branch up to the target node; it never restores or diffs a whole cwd snapshot.
- Dirty guard checks only affected checkpoint/touched paths, so unrelated sentinel files are not included.
- Shell-created files in non-git mode are not parsed or restored. The extension warns once per agent turn when a bash tool runs in non-git mode.
- A `write`/`edit` path outside the non-git snapshot scope is reported once per turn as having no undo coverage, stays out of that turn's checkpoint claim, and is not captured later in the same turn. `/undo` and `/redo` therefore leave it alone; `/tree` still moves the workspace to the selected node's state, and `/redo` after `/tree` restores the previously covered files that `/tree` replaced. If snapshot bookkeeping itself fails before the path is known, that turn's checkpoint is dropped so nothing is claimed.

## Path safety in non-git mode

Explicit paths are normalized relative to the workspace root. Relative paths resolve against Pi's current `ctx.cwd`; absolute paths are accepted only when they remain inside the workspace root. Paths containing NUL, escaping via `..`, or targeting dangerous workspace directories such as `.git`, `.pi`, or `node_modules` are never snapshotted or restored in non-git mode, so no checkpoint ever lists them and `/undo` and `/redo` leave them alone: the pending `write`/`edit` still runs, and the extension reports the path once per turn as having no undo coverage. Windows-style paths normalize to `/`-separated relative paths in checkpoint metadata.

## Notes

- Snapshots are protected with internal shadow-git refs so stored tree objects are not immediately lost to Git GC.
- Restore avoids recursive directory deletion for file/dir conflicts; unsafe conflicts fail closed instead of deleting unknown directory contents.
- Non-git mode intentionally trades shell/filesystem auto-discovery for safety and bounded scope. Use a git repository when full OpenCode-style shell/file-system change capture is required.
