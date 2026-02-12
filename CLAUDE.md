# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension for managing notes within the editor. Notes are stored as JSON in `.vscode/notes.json` within the workspace.

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
- `activate()` - Entry point, registers commands and tree view
- `NotesProvider` - TreeDataProvider implementation for the sidebar view
- `NoteItem` - TreeItem wrapper for individual notes
- Helper functions: `getWorkspaceFolder()`, `isNoteLike()`, `truncate()`

**Commands registered:**
- `notes.addNote` - Create new note via input boxes
- `notes.refresh` - Refresh the tree view
- `notes.openNote` - Open note as read-only markdown document

**Data format:** Notes are `{ id: string, title: string, text: string }` stored in `.vscode/notes.json`

## Testing

Tests use `@vscode/test-cli` and `@vscode/test-electron`. Test files go in `src/test/` and must match `*.test.ts`. Tests run against compiled JS in `out/test/`.
