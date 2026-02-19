# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension for managing notes within the editor. Notes are stored as JSON in VS Code's extension storage directory (`context.storageUri`), keeping them out of the workspace and git.

## Commands

```bash
# Build
npm run compile

# Watch mode (auto-rebuild on changes)
npm run watch

# Lint
npm run lint

# Run tests (requires compile first)
npm run pretest  # compile + lint
npm run test     # runs vscode-test
```

## Architecture

**Single-file extension** (`src/extension.ts`) containing:
- `activate()` - Entry point, registers commands, webview, and comment controller
- `NotesViewProvider` - WebviewViewProvider for the sidebar panel with full note management UI
- `NoteComment` - Comment implementation for inline notes in editors
- `loadCommentThreads()` - Syncs notes with file-linked comments
- Helper functions: `getWorkspaceFolder()`, `isNoteLike()`, `createNoteComment()`

**Commands registered:**
- `notes.addNote` - Create project-wide note via input boxes
- `notes.refresh` - Refresh sidebar and comment threads
- `notes.createNote` - Create note from inline comment UI
- `notes.editNote` - Edit existing note
- `notes.deleteNote` - Delete note and its comment thread
- `notes.createFileNote` - Create note linked to current file (from explorer/editor context menu)
- `notes.revealInSidebar` - Open note in sidebar panel from inline comment

**Data format:** Notes stored in `reintest-notes.json` within VS Code's storage directory:
```typescript
{
  id: string;
  title: string;
  text: string;
  fileUri?: string;    // Workspace-relative path for file-linked notes
  lineStart?: number;  // 0-based line number
  lineEnd?: number;    // Optional end line for range
  closed?: boolean;    // Resolved/closed status
}
```

**UI Features:**
- Webview sidebar with collapsible sections (Current File, Project Wide, Other Files, Closed)
- Inline comments via VS Code Comments API for file-linked notes
- Filter to show only current file's notes
- Close/reopen notes without deleting

## Testing

Tests use `@vscode/test-cli` and `@vscode/test-electron`. Test files go in `src/test/` and must match `*.test.ts`. Tests run against compiled JS in `out/test/`.
