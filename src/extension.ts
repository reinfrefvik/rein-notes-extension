import * as vscode from "vscode";

type Note = {
	id: string;
	title: string;
	text: string;
	fileUri?: string;      // Linked file (workspace-relative path)
	lineStart?: number;    // 0-based line number
	lineEnd?: number;      // Optional end line for range
	closed?: boolean;      // Whether the note is closed/resolved
};

const NOTES_REL_PATH = ".vscode/notes.json";

let commentController: vscode.CommentController;
let notesViewProvider: NotesViewProvider;
const threadMap = new Map<string, vscode.CommentThread>();

export function activate(context: vscode.ExtensionContext) {
	notesViewProvider = new NotesViewProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("notesView", notesViewProvider)
	);

	// Create comment controller for inline notes
	commentController = vscode.comments.createCommentController("notes", "Notes");
	context.subscriptions.push(commentController);

	// Allow commenting on all lines in all files
	commentController.commentingRangeProvider = {
		provideCommentingRanges(document: vscode.TextDocument): vscode.Range[] {
			const lineCount = document.lineCount;
			return [new vscode.Range(0, 0, lineCount - 1, 0)];
		}
	};

	// Load existing notes and create comment threads
	loadCommentThreads();

	context.subscriptions.push(
		vscode.commands.registerCommand("notes.refresh", () => {
			notesViewProvider.refresh();
			loadCommentThreads();
		})
	);

	context.subscriptions.push(
		vscode.commands.registerCommand("notes.addNote", async () => {
			const ws = getWorkspaceFolder();
			if (!ws) {
				vscode.window.showErrorMessage("Open a folder/workspace to store notes.");
				return;
			}

			const title = await vscode.window.showInputBox({
				prompt: "Note title",
				validateInput: (v) => (v.trim().length ? undefined : "Title is required")
			});
			if (!title) { return; }

			const text = await vscode.window.showInputBox({
				prompt: "Note text",
				placeHolder: "Write something…"
			});
			if (text === undefined) { return; }

			const note: Note = {
				id: String(Date.now()),
				title: title.trim(),
				text
			};

			const notes = await notesViewProvider.loadNotes();
			notes.unshift(note);
			await notesViewProvider.saveNotes(notes);
			notesViewProvider.refresh();
		})
	);

	// Command to create a note from the comment UI
	context.subscriptions.push(
		vscode.commands.registerCommand("notes.createNote", async (reply: vscode.CommentReply) => {
			const ws = getWorkspaceFolder();
			if (!ws) {
				vscode.window.showErrorMessage("Open a folder/workspace to store notes.");
				return;
			}

			const title = await vscode.window.showInputBox({
				prompt: "Note title",
				validateInput: (v) => (v.trim().length ? undefined : "Title is required")
			});
			if (!title) { return; }

			const thread = reply.thread;
			const fileUri = vscode.workspace.asRelativePath(thread.uri, false);
			const range = thread.range;
			const lineStart = range?.start.line ?? 0;
			const lineEnd = range?.end.line ?? lineStart;

			const note: Note = {
				id: String(Date.now()),
				title: title.trim(),
				text: reply.text,
				fileUri,
				lineStart,
				lineEnd: lineEnd !== lineStart ? lineEnd : undefined
			};

			const notes = await notesViewProvider.loadNotes();
			notes.unshift(note);
			await notesViewProvider.saveNotes(notes);

			// Create the comment in the thread
			thread.comments = [createNoteComment(note)];
			thread.canReply = false;
			thread.label = note.title;
			threadMap.set(note.id, thread);

			notesViewProvider.refresh();
		})
	);

	// Command to edit a note
	context.subscriptions.push(
		vscode.commands.registerCommand("notes.editNote", async (comment: NoteComment) => {
			const note = comment.note;

			const newTitle = await vscode.window.showInputBox({
				prompt: "Edit note title",
				value: note.title,
				validateInput: (v) => (v.trim().length ? undefined : "Title is required")
			});
			if (!newTitle) { return; }

			const newText = await vscode.window.showInputBox({
				prompt: "Edit note text",
				value: note.text
			});
			if (newText === undefined) { return; }

			const notes = await notesViewProvider.loadNotes();
			const idx = notes.findIndex((n) => n.id === note.id);
			if (idx === -1) { return; }

			notes[idx].title = newTitle.trim();
			notes[idx].text = newText;
			await notesViewProvider.saveNotes(notes);

			// Update the thread
			const thread = threadMap.get(note.id);
			if (thread) {
				thread.comments = [createNoteComment(notes[idx])];
				thread.label = notes[idx].title;
			}

			notesViewProvider.refresh();
		})
	);

	// Command to create a file-level note (not tied to a specific line)
	context.subscriptions.push(
		vscode.commands.registerCommand("notes.createFileNote", async (uri?: vscode.Uri) => {
			const ws = getWorkspaceFolder();
			if (!ws) {
				vscode.window.showErrorMessage("Open a folder/workspace to store notes.");
				return;
			}

			// Get URI from argument (explorer context menu) or active editor
			const targetUri = uri ?? vscode.window.activeTextEditor?.document.uri;
			if (!targetUri || targetUri.scheme !== "file") {
				vscode.window.showErrorMessage("Open a file to add a note to it.");
				return;
			}

			const title = await vscode.window.showInputBox({
				prompt: "Note title",
				validateInput: (v) => (v.trim().length ? undefined : "Title is required")
			});
			if (!title) { return; }

			const text = await vscode.window.showInputBox({
				prompt: "Note text",
				placeHolder: "Write something…"
			});
			if (text === undefined) { return; }

			const fileUri = vscode.workspace.asRelativePath(targetUri, false);

			const note: Note = {
				id: String(Date.now()),
				title: title.trim(),
				text,
				fileUri,
				lineStart: 0  // File-level notes anchor at top
			};

			const notes = await notesViewProvider.loadNotes();
			notes.unshift(note);
			await notesViewProvider.saveNotes(notes);

			// Create comment thread at line 0
			const range = new vscode.Range(0, 0, 0, 0);
			const thread = commentController.createCommentThread(targetUri, range, [
				createNoteComment(note)
			]);
			thread.canReply = false;
			thread.label = note.title;
			threadMap.set(note.id, thread);

			notesViewProvider.refresh();
		})
	);

	// Command to delete a note/thread
	context.subscriptions.push(
		vscode.commands.registerCommand("notes.deleteNote", async (thread: vscode.CommentThread) => {
			const comment = thread.comments[0] as NoteComment | undefined;
			if (!comment?.note) { return; }

			const confirm = await vscode.window.showWarningMessage(
				`Delete note "${comment.note.title}"?`,
				{ modal: true },
				"Delete"
			);
			if (confirm !== "Delete") { return; }

			const notes = await notesViewProvider.loadNotes();
			const filtered = notes.filter((n) => n.id !== comment.note.id);
			await notesViewProvider.saveNotes(filtered);

			threadMap.delete(comment.note.id);
			thread.dispose();

			notesViewProvider.refresh();
		})
	);

	// Command to reveal a note in the sidebar
	context.subscriptions.push(
		vscode.commands.registerCommand("notes.revealInSidebar", async (noteId: string) => {
			// Reveal the sidebar
			await vscode.commands.executeCommand("notesView.focus");
			// Tell the webview to expand this note
			notesViewProvider.revealNote(noteId);
		})
	);
}

async function loadCommentThreads() {
	// Dispose existing threads
	for (const thread of threadMap.values()) {
		thread.dispose();
	}
	threadMap.clear();

	const ws = getWorkspaceFolder();
	if (!ws) { return; }

	const notes = await notesViewProvider.loadNotes();

	for (const note of notes) {
		if (note.fileUri !== undefined && note.lineStart !== undefined) {
			const uri = vscode.Uri.joinPath(ws.uri, note.fileUri);
			const lineEnd = note.lineEnd ?? note.lineStart;
			const range = new vscode.Range(note.lineStart, 0, lineEnd, 0);

			const thread = commentController.createCommentThread(uri, range, [
				createNoteComment(note)
			]);
			thread.canReply = false;
			thread.label = note.title;
			threadMap.set(note.id, thread);
		}
	}
}

function createNoteComment(note: Note): NoteComment {
	return new NoteComment(note, vscode.CommentMode.Preview);
}

class NoteComment implements vscode.Comment {
	body: vscode.MarkdownString;
	mode: vscode.CommentMode;
	author: vscode.CommentAuthorInformation;

	constructor(
		public readonly note: Note,
		mode: vscode.CommentMode
	) {
		// Show minimal preview with link to open in sidebar
		const preview = note.text.replace(/\s+/g, " ").slice(0, 50);
		const md = new vscode.MarkdownString();
		md.isTrusted = true;
		md.appendMarkdown(`${preview}${note.text.length > 50 ? "..." : ""}\n\n`);
		md.appendMarkdown(`[Open in Notes panel](command:notes.revealInSidebar?${encodeURIComponent(JSON.stringify(note.id))})`);
		this.body = md;
		this.mode = mode;
		this.author = { name: note.title };
	}
}

export function deactivate() { }

class NotesViewProvider implements vscode.WebviewViewProvider {
	private _view?: vscode.WebviewView;
	private _filterToCurrentFile = false;
	private _currentFileUri?: string;
	private _disposables: vscode.Disposable[] = [];

	constructor(private readonly _extensionUri: vscode.Uri) { }

	resolveWebviewView(webviewView: vscode.WebviewView) {
		this._view = webviewView;

		webviewView.webview.options = {
			enableScripts: true
		};

		// Track active editor changes
		this._disposables.push(
			vscode.window.onDidChangeActiveTextEditor((editor) => {
				const ws = getWorkspaceFolder();
				if (editor && ws && editor.document.uri.scheme === "file") {
					this._currentFileUri = vscode.workspace.asRelativePath(editor.document.uri, false);
				} else {
					this._currentFileUri = undefined;
				}
				this.refresh();
			})
		);

		// Initialize current file
		const activeEditor = vscode.window.activeTextEditor;
		const ws = getWorkspaceFolder();
		if (activeEditor && ws && activeEditor.document.uri.scheme === "file") {
			this._currentFileUri = vscode.workspace.asRelativePath(activeEditor.document.uri, false);
		}

		webviewView.onDidDispose(() => {
			this._disposables.forEach(d => d.dispose());
		});

		webviewView.webview.onDidReceiveMessage(async (msg) => {
			switch (msg.type) {
				case "add": {
					const note: Note = {
						id: String(Date.now()),
						title: msg.title.trim(),
						text: msg.text
					};
					// Attach to current file if requested
					if (msg.attachToFile && this._currentFileUri) {
						note.fileUri = this._currentFileUri;
						note.lineStart = 0;
					}
					const notes = await this.loadNotes();
					notes.unshift(note);
					await this.saveNotes(notes);
					this.refresh();
					break;
				}
				case "save": {
					const notes = await this.loadNotes();
					const idx = notes.findIndex((n) => n.id === msg.id);
					if (idx !== -1) {
						notes[idx].title = msg.title.trim();
						notes[idx].text = msg.text;
						await this.saveNotes(notes);
						// Update comment thread if exists
						const thread = threadMap.get(msg.id);
						if (thread) {
							thread.comments = [createNoteComment(notes[idx])];
							thread.label = notes[idx].title;
						}
					}
					this.refresh();
					break;
				}
				case "delete": {
					const notes = await this.loadNotes();
					const filtered = notes.filter((n) => n.id !== msg.id);
					await this.saveNotes(filtered);
					// Dispose comment thread if exists
					const thread = threadMap.get(msg.id);
					if (thread) {
						thread.dispose();
						threadMap.delete(msg.id);
					}
					this.refresh();
					break;
				}
				case "goToFile": {
					const ws = getWorkspaceFolder();
					if (!ws) { return; }
					const uri = vscode.Uri.joinPath(ws.uri, msg.fileUri);
					const line = msg.lineStart ?? 0;
					const doc = await vscode.workspace.openTextDocument(uri);
					const editor = await vscode.window.showTextDocument(doc);
					const pos = new vscode.Position(line, 0);
					editor.selection = new vscode.Selection(pos, pos);
					editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
					break;
				}
				case "toggleFilter": {
					this._filterToCurrentFile = msg.enabled;
					this.refresh();
					break;
				}
				case "toggleClosed": {
					const notes = await this.loadNotes();
					const idx = notes.findIndex((n) => n.id === msg.id);
					if (idx !== -1) {
						notes[idx].closed = !notes[idx].closed;
						await this.saveNotes(notes);
					}
					this.refresh();
					break;
				}
			}
		});

		this.refresh();
	}

	async refresh(expandNoteId?: string) {
		if (!this._view) { return; }
		const allNotes = await this.loadNotes();

		// Filter notes if filter is enabled
		let notes = allNotes;
		if (this._filterToCurrentFile && this._currentFileUri) {
			notes = allNotes.filter(n => n.fileUri === this._currentFileUri);
		}

		// If we're revealing a specific note, make sure it's visible (disable filter if needed)
		if (expandNoteId) {
			const noteToReveal = allNotes.find(n => n.id === expandNoteId);
			if (noteToReveal && !notes.find(n => n.id === expandNoteId)) {
				// Note is filtered out, show all notes
				this._filterToCurrentFile = false;
				notes = allNotes;
			}
		}

		// Sort notes: current file notes first, then open notes, then closed notes
		const currentFile = this._currentFileUri;
		notes = [...notes].sort((a, b) => {
			const aIsCurrentFile = currentFile && a.fileUri === currentFile;
			const bIsCurrentFile = currentFile && b.fileUri === currentFile;
			const aIsClosed = !!a.closed;
			const bIsClosed = !!b.closed;

			// Current file notes come first
			if (aIsCurrentFile && !bIsCurrentFile) { return -1; }
			if (!aIsCurrentFile && bIsCurrentFile) { return 1; }

			// Closed notes come last
			if (aIsClosed && !bIsClosed) { return 1; }
			if (!aIsClosed && bIsClosed) { return -1; }

			return 0; // Maintain original order otherwise
		});

		// Count notes for current file (for badge)
		const currentFileNoteCount = this._currentFileUri
			? allNotes.filter(n => n.fileUri === this._currentFileUri).length
			: 0;

		this._view.webview.html = this._getHtml(notes, allNotes.length, currentFileNoteCount, expandNoteId);
	}

	revealNote(noteId: string) {
		this.refresh(noteId);
	}

	async loadNotes(): Promise<Note[]> {
		const ws = getWorkspaceFolder();
		if (!ws) { return []; }

		const uri = vscode.Uri.joinPath(ws.uri, NOTES_REL_PATH);

		try {
			const bytes = await vscode.workspace.fs.readFile(uri);
			const json = new TextDecoder("utf-8").decode(bytes);
			const parsed = JSON.parse(json);
			if (!Array.isArray(parsed)) { return []; }
			return parsed.filter(isNoteLike);
		} catch {
			return [];
		}
	}

	async saveNotes(notes: Note[]): Promise<void> {
		const ws = getWorkspaceFolder();
		if (!ws) { return; }

		const vscodeDir = vscode.Uri.joinPath(ws.uri, ".vscode");
		try {
			await vscode.workspace.fs.stat(vscodeDir);
		} catch {
			await vscode.workspace.fs.createDirectory(vscodeDir);
		}

		const uri = vscode.Uri.joinPath(ws.uri, NOTES_REL_PATH);
		const content = JSON.stringify(notes, null, 2);
		await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
	}

	private _getHtml(notes: Note[], totalCount: number, currentFileCount: number, expandNoteId?: string): string {
		const escapeHtml = (s: string) =>
			s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

		const currentFile = this._currentFileUri;
		const isFiltered = this._filterToCurrentFile;

		// Separate notes into categories
		const openNotes = notes.filter(n => !n.closed);
		const closedNotes = notes.filter(n => n.closed);

		// Further categorize open notes
		const currentFileNotes = currentFile ? openNotes.filter(n => n.fileUri === currentFile) : [];
		const globalNotes = openNotes.filter(n => !n.fileUri);
		const otherFileNotes = openNotes.filter(n => n.fileUri && n.fileUri !== currentFile);

		const renderNote = (n: Note) => {
			const isCurrentFile = currentFile && n.fileUri === currentFile;
			const isGlobal = !n.fileUri;
			const isExpanded = n.id === expandNoteId;
			const isClosed = !!n.closed;
			const fileMeta = n.fileUri
				? `<div class="file-link" onclick="goToFile('${escapeHtml(n.fileUri)}', ${n.lineStart ?? 0})">${escapeHtml(n.fileUri)}${n.lineStart !== undefined ? `:${n.lineStart + 1}` : ""}</div>`
				: "";
			return `
				<div class="note ${isCurrentFile ? "current-file" : ""} ${isGlobal ? "global" : ""} ${isExpanded ? "expanded" : ""} ${isClosed ? "closed" : ""}" data-id="${escapeHtml(n.id)}" ${isExpanded ? 'id="expanded-note"' : ""}>
					<div class="note-header" onclick="toggle('${escapeHtml(n.id)}')">
						<div class="note-header-top">
							<span class="note-title">${isClosed ? '<span class="closed-indicator">✓</span> ' : ""}${escapeHtml(n.title)}</span>
							<button class="close-toggle-btn" onclick="event.stopPropagation(); toggleClosed('${escapeHtml(n.id)}')" title="${isClosed ? "Reopen note" : "Close note"}">
								${isClosed ? "↩" : "✓"}
							</button>
						</div>
						<span class="note-preview">${escapeHtml(n.text.replace(/\s+/g, " ").slice(0, 30))}</span>
					</div>
					<div class="note-body ${isExpanded ? "open" : ""}" id="body-${escapeHtml(n.id)}">
						<input type="text" class="edit-title" value="${escapeHtml(n.title)}" placeholder="Title" />
						<textarea class="edit-text" placeholder="Note content...">${escapeHtml(n.text)}</textarea>
						${fileMeta}
						<div class="note-actions">
							<button class="save-btn" onclick="saveNote('${escapeHtml(n.id)}')">Save</button>
							<button class="close-btn" onclick="toggleClosed('${escapeHtml(n.id)}')">${isClosed ? "Reopen" : "Close"}</button>
							<button class="delete-btn" onclick="deleteNote('${escapeHtml(n.id)}')">Delete</button>
						</div>
					</div>
				</div>
			`;
		};

		const renderSection = (title: string, sectionNotes: Note[], sectionId: string, defaultOpen = true) => {
			if (sectionNotes.length === 0) { return ""; }
			return `
				<div class="notes-section">
					<div class="section-header" onclick="toggleSection('${sectionId}')">
						<span class="section-arrow ${defaultOpen ? "open" : ""}" id="${sectionId}-arrow">▶</span>
						<span class="section-title">${title}</span>
						<span class="section-count">${sectionNotes.length}</span>
					</div>
					<div class="section-content ${defaultOpen ? "open" : ""}" id="${sectionId}-content">
						${sectionNotes.map(renderNote).join("")}
					</div>
				</div>
			`;
		};

		const currentFileSection = renderSection(
			currentFile ? `Current File` : "Current File",
			currentFileNotes,
			"current-file",
			true
		);
		const globalSection = renderSection("Project Wide", globalNotes, "global", true);
		const otherFilesSection = renderSection("Other Files", otherFileNotes, "other-files", false);

		// Categorize closed notes
		const closedCurrentFileNotes = currentFile ? closedNotes.filter(n => n.fileUri === currentFile) : [];
		const closedGlobalNotes = closedNotes.filter(n => !n.fileUri);
		const closedOtherFileNotes = closedNotes.filter(n => n.fileUri && n.fileUri !== currentFile);

		const closedNotesHtml = closedNotes.length > 0 ? `
			<div class="closed-section">
				<div class="closed-section-header" onclick="toggleClosedSection()">
					<span class="closed-section-arrow" id="closed-arrow">▶</span>
					<span>Closed (${closedNotes.length})</span>
				</div>
				<div class="closed-section-content" id="closed-section-content">
					${renderSection("Current File", closedCurrentFileNotes, "closed-current-file", false)}
					${renderSection("Project Wide", closedGlobalNotes, "closed-global", false)}
					${renderSection("Other Files", closedOtherFileNotes, "closed-other-files", false)}
				</div>
			</div>
		` : "";

		const filterSection = currentFile ? `
			<div class="filter-section">
				<button class="filter-btn ${isFiltered ? "active" : ""}" onclick="toggleFilter()">
					${isFiltered ? "Show All" : `This File (${currentFileCount})`}
				</button>
				${isFiltered ? `<span class="filter-info">${escapeHtml(currentFile)}</span>` : ""}
			</div>
		` : "";

		const emptyMessage = isFiltered
			? '<div class="empty">No notes for this file</div>'
			: '<div class="empty">No notes yet</div>';

		const hasAnyOpenNotes = openNotes.length > 0;
		const sectionsHtml = currentFileSection + globalSection + otherFilesSection;
		const notesContent = hasAnyOpenNotes ? sectionsHtml : (closedNotes.length > 0 ? '' : emptyMessage);

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		* { box-sizing: border-box; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family);
			font-size: 13px;
			color: var(--vscode-foreground);
			background: var(--vscode-sideBar-background);
			padding: 8px;
		}
		.filter-section {
			margin-bottom: 8px;
			display: flex;
			align-items: center;
			gap: 8px;
			flex-wrap: wrap;
		}
		.filter-btn {
			padding: 4px 10px;
			border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
			border-radius: 3px;
			cursor: pointer;
			font-size: 11px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.filter-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.filter-btn.active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.filter-info {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}
		.add-section {
			margin-bottom: 12px;
			padding-bottom: 12px;
			border-bottom: 1px solid var(--vscode-widget-border);
		}
		.add-section input, .add-section textarea {
			width: 100%;
			margin-bottom: 6px;
		}
		.add-type-toggle {
			display: flex;
			gap: 4px;
			margin-bottom: 6px;
		}
		.type-btn {
			flex: 1;
			padding: 4px 8px;
			font-size: 11px;
			border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
			border-radius: 3px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			cursor: pointer;
		}
		.type-btn:hover:not(.disabled) {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		.type-btn.active {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.type-btn.disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}
		input, textarea {
			padding: 6px 8px;
			border: 1px solid var(--vscode-input-border);
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border-radius: 3px;
			font-family: inherit;
			font-size: 12px;
		}
		input:focus, textarea:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}
		textarea { resize: vertical; min-height: 60px; }
		button {
			padding: 4px 10px;
			border: none;
			border-radius: 3px;
			cursor: pointer;
			font-size: 11px;
		}
		.add-btn {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.add-btn:hover { background: var(--vscode-button-hoverBackground); }
		.note {
			margin-bottom: 4px;
			border-radius: 4px;
			background: var(--vscode-editor-background);
			overflow: hidden;
		}
		.note.current-file {
			border-left: 3px solid var(--vscode-textLink-foreground);
		}
		.note.expanded {
			box-shadow: 0 0 0 2px var(--vscode-focusBorder);
		}
		.note-header {
			padding: 8px 10px;
			cursor: pointer;
			display: flex;
			flex-direction: column;
			gap: 2px;
		}
		.note-header:hover { background: var(--vscode-list-hoverBackground); }
		.note-title { font-weight: 500; }
		.note-preview {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
		}
		.note-body {
			display: none;
			padding: 8px 10px;
			border-top: 1px solid var(--vscode-widget-border);
		}
		.note-body.open { display: block; }
		.note-body input, .note-body textarea { width: 100%; margin-bottom: 8px; }
		.note-actions { display: flex; gap: 6px; margin-top: 4px; }
		.save-btn {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		.delete-btn {
			background: transparent;
			color: var(--vscode-errorForeground);
			border: 1px solid var(--vscode-errorForeground);
		}
		.delete-btn:hover { background: var(--vscode-errorForeground); color: white; }
		.file-link {
			font-size: 11px;
			color: var(--vscode-textLink-foreground);
			cursor: pointer;
			margin-bottom: 8px;
		}
		.file-link:hover { text-decoration: underline; }
		.empty {
			text-align: center;
			padding: 20px;
			color: var(--vscode-descriptionForeground);
		}
		.note.closed {
			opacity: 0.6;
			background: var(--vscode-editor-inactiveSelectionBackground, rgba(128, 128, 128, 0.1));
		}
		.note.closed .note-title {
			color: var(--vscode-disabledForeground, #888);
			text-decoration: line-through;
		}
		.closed-indicator {
			color: var(--vscode-charts-green, #89d185);
			text-decoration: none;
			display: inline;
		}
		.note-header-top {
			display: flex;
			justify-content: space-between;
			align-items: center;
			gap: 8px;
		}
		.close-toggle-btn {
			background: transparent;
			border: 1px solid var(--vscode-button-border, var(--vscode-contrastBorder, transparent));
			color: var(--vscode-descriptionForeground);
			padding: 2px 6px;
			font-size: 10px;
			border-radius: 3px;
			cursor: pointer;
			opacity: 0;
			transition: opacity 0.15s;
		}
		.note-header:hover .close-toggle-btn {
			opacity: 1;
		}
		.close-toggle-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground);
			color: var(--vscode-button-secondaryForeground);
		}
		.close-btn {
			background: transparent;
			color: var(--vscode-descriptionForeground);
			border: 1px solid var(--vscode-descriptionForeground);
		}
		.close-btn:hover {
			background: var(--vscode-descriptionForeground);
			color: var(--vscode-editor-background);
		}
		.note.global {
			border-left: 3px solid var(--vscode-charts-orange, #d18616);
		}
		.notes-section {
			margin-bottom: 4px;
		}
		.section-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 8px;
			cursor: pointer;
			font-size: 11px;
			font-weight: 500;
			color: var(--vscode-foreground);
			background: var(--vscode-sideBarSectionHeader-background, transparent);
			border-radius: 3px;
			text-transform: uppercase;
			letter-spacing: 0.5px;
		}
		.section-header:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.section-arrow {
			font-size: 10px;
			transition: transform 0.15s;
		}
		.section-arrow.open {
			transform: rotate(90deg);
		}
		.section-title {
			flex: 1;
		}
		.section-count {
			font-size: 10px;
			color: var(--vscode-descriptionForeground);
			background: var(--vscode-badge-background);
			color: var(--vscode-badge-foreground);
			padding: 1px 6px;
			border-radius: 10px;
		}
		.section-content {
			display: none;
		}
		.section-content.open {
			display: block;
		}
		.closed-section {
			margin-top: 12px;
			border-top: 1px solid var(--vscode-widget-border);
			padding-top: 8px;
		}
		.closed-section-header {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 6px 8px;
			cursor: pointer;
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			border-radius: 3px;
		}
		.closed-section-header:hover {
			background: var(--vscode-list-hoverBackground);
		}
		.closed-section-arrow {
			font-size: 10px;
			transition: transform 0.15s;
		}
		.closed-section-arrow.open {
			transform: rotate(90deg);
		}
		.closed-section-content {
			display: none;
			margin-top: 4px;
		}
		.closed-section-content.open {
			display: block;
		}
	</style>
</head>
<body>
	${filterSection}
	<div class="add-section">
		<input type="text" id="new-title" placeholder="Note title" />
		<textarea id="new-text" placeholder="Note content..."></textarea>
		<div class="add-type-toggle">
			<button class="type-btn active" id="type-project" onclick="setNoteType('project')">Project Wide</button>
			<button class="type-btn ${currentFile ? "" : "disabled"}" id="type-file" onclick="setNoteType('file')" ${currentFile ? "" : "disabled"}>Current File</button>
		</div>
		<button class="add-btn" onclick="addNote()">Add Note</button>
	</div>
	${notesContent}
	${closedNotesHtml}
	<script>
		const vscode = acquireVsCodeApi();
		let filterEnabled = ${isFiltered};
		let noteType = 'project';

		function toggle(id) {
			const body = document.getElementById('body-' + id);
			body.classList.toggle('open');
		}

		function setNoteType(type) {
			noteType = type;
			document.getElementById('type-project').classList.toggle('active', type === 'project');
			document.getElementById('type-file').classList.toggle('active', type === 'file');
		}

		function addNote() {
			const title = document.getElementById('new-title').value.trim();
			const text = document.getElementById('new-text').value;
			if (!title) { return; }
			vscode.postMessage({ type: 'add', title, text, attachToFile: noteType === 'file' });
		}

		function saveNote(id) {
			const note = document.querySelector('.note[data-id="' + id + '"]');
			const title = note.querySelector('.edit-title').value.trim();
			const text = note.querySelector('.edit-text').value;
			if (!title) { return; }
			vscode.postMessage({ type: 'save', id, title, text });
		}

		function deleteNote(id) {
			vscode.postMessage({ type: 'delete', id });
		}

		function goToFile(fileUri, lineStart) {
			vscode.postMessage({ type: 'goToFile', fileUri, lineStart });
		}

		function toggleFilter() {
			filterEnabled = !filterEnabled;
			vscode.postMessage({ type: 'toggleFilter', enabled: filterEnabled });
		}

		function toggleClosed(id) {
			vscode.postMessage({ type: 'toggleClosed', id });
		}

		function toggleSection(sectionId) {
			const content = document.getElementById(sectionId + '-content');
			const arrow = document.getElementById(sectionId + '-arrow');
			if (content && arrow) {
				content.classList.toggle('open');
				arrow.classList.toggle('open');
			}
		}

		function toggleClosedSection() {
			const content = document.getElementById('closed-section-content');
			const arrow = document.getElementById('closed-arrow');
			if (content && arrow) {
				content.classList.toggle('open');
				arrow.classList.toggle('open');
			}
		}

		// Scroll to expanded note on load
		const expandedNote = document.getElementById('expanded-note');
		if (expandedNote) {
			setTimeout(() => expandedNote.scrollIntoView({ behavior: 'smooth', block: 'center' }), 100);
		}
	</script>
</body>
</html>`;
	}
}

function getWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
	return vscode.workspace.workspaceFolders?.[0];
}

function isNoteLike(x: any): x is Note {
	return (
		x &&
		typeof x.id === "string" &&
		typeof x.title === "string" &&
		typeof x.text === "string"
	);
}
