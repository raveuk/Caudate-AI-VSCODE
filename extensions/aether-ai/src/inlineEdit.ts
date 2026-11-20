/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AetherLLMClient } from './llmClient';

interface InlineDiffHunk {
	id: string;
	startLine: number; // 0-based line in current document
	endLine: number;   // inclusive 0-based line in current document (-1 if pure deletion placeholder)
	originalLines: string[];
	newLines: string[];
	resolved: boolean;
}

interface PendingInlineEdit {
	uri: vscode.Uri;
	instruction: string;
	startLine: number;
	originalText: string;
	hunks: InlineDiffHunk[];
}

export class InlineEditController implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	private readonly addedDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(46, 160, 67, 0.22)',
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: 'rgba(63, 185, 80, 0.85)',
		isWholeLine: true,
		overviewRulerColor: 'rgba(46, 160, 67, 0.85)',
		overviewRulerLane: vscode.OverviewRulerLane.Right,
	});

	private readonly modifiedDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(56, 139, 253, 0.16)',
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: 'rgba(56, 139, 253, 0.85)',
		isWholeLine: true,
		overviewRulerColor: 'rgba(56, 139, 253, 0.85)',
		overviewRulerLane: vscode.OverviewRulerLane.Right,
	});

	private pendingEdit: PendingInlineEdit | undefined;
	private activeAbort: AbortController | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly llm: AetherLLMClient) {
		this.disposables.push(
			this._onDidChangeCodeLenses,
			vscode.languages.registerCodeLensProvider({ pattern: '**/*' }, this),
			vscode.window.onDidChangeActiveTextEditor(() => this.refreshDecorations())
		);
	}

	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		if (!this.pendingEdit || this.pendingEdit.uri.toString() !== document.uri.toString()) {
			return [];
		}
		const activeHunks = this.pendingEdit.hunks.filter(h => !h.resolved);
		if (activeHunks.length === 0) {
			return [];
		}

		const lenses: vscode.CodeLens[] = [];
		const topLine = Math.max(0, Math.min(activeHunks[0].startLine, document.lineCount - 1));
		const topRange = new vscode.Range(topLine, 0, topLine, 0);

		lenses.push(
			new vscode.CodeLens(topRange, {
				title: activeHunks.length > 1 ? `$(check-all) Accept All (${activeHunks.length}) (Ctrl+Enter)` : '$(check) Accept (Ctrl+Enter)',
				command: 'aether.acceptInlineEdit',
			}),
			new vscode.CodeLens(topRange, {
				title: activeHunks.length > 1 ? '$(close-all) Reject All (Esc)' : '$(close) Reject (Esc)',
				command: 'aether.rejectInlineEdit',
			}),
			new vscode.CodeLens(topRange, {
				title: '$(refresh) Retry',
				command: 'aether.retryInlineEdit',
			})
		);

		// Per-hunk Accept / Reject controls when there are multiple distinct hunks
		if (activeHunks.length > 1) {
			for (let i = 0; i < activeHunks.length; i++) {
				const h = activeHunks[i];
				const hLine = Math.max(0, Math.min(h.startLine, document.lineCount - 1));
				const hRange = new vscode.Range(hLine, 0, hLine, 0);
				const summary = `+${h.newLines.length} -${h.originalLines.length}`;
				lenses.push(
					new vscode.CodeLens(hRange, {
						title: `$(check) Accept Hunk #${i + 1} (${summary})`,
						command: 'aether.acceptInlineHunk',
						arguments: [h.id],
					}),
					new vscode.CodeLens(hRange, {
						title: `$(close) Reject Hunk #${i + 1}`,
						command: 'aether.rejectInlineHunk',
						arguments: [h.id],
					})
				);
			}
		}

		return lenses;
	}

	public async trigger(retryInstruction?: string, explicitRange?: vscode.Range): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			vscode.window.showInformationMessage('Open a file to use Caudate Inline Edit (Ctrl+K).');
			return;
		}

		if (this.pendingEdit && !retryInstruction) {
			await this.reject();
		}

		const document = editor.document;
		const selection = explicitRange ?? editor.selection;
		const hasSelection = !selection.isEmpty;

		const targetRange = hasSelection
			? new vscode.Range(
				selection.start.line,
				0,
				selection.end.line,
				document.lineAt(selection.end.line).text.length
			)
			: new vscode.Range(selection.start, selection.start);

		const originalText = hasSelection ? document.getText(targetRange) : '';

		const instruction = retryInstruction ?? await vscode.window.showInputBox({
			title: 'Caudate AI · Inline Edit (Ctrl+K)',
			prompt: hasSelection
				? `Describe how to edit lines ${targetRange.start.line + 1}–${targetRange.end.line + 1}`
				: `Describe code to generate at line ${targetRange.start.line + 1}`,
			placeHolder: 'e.g. Add validation and error handling, refactor to async/await, fix bug...',
			ignoreFocusOut: true,
		});

		if (!instruction || !instruction.trim()) {
			return;
		}

		const beforeContextStart = Math.max(0, targetRange.start.line - 60);
		const afterContextEnd = Math.min(document.lineCount - 1, targetRange.end.line + 60);
		const beforeContext = document.getText(new vscode.Range(beforeContextStart, 0, targetRange.start.line, 0));
		const afterContext = document.getText(
			new vscode.Range(targetRange.end.line, document.lineAt(targetRange.end.line).text.length, afterContextEnd, document.lineAt(afterContextEnd).text.length)
		);

		this.activeAbort?.abort();
		const abort = new AbortController();
		this.activeAbort = abort;

		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: 'Caudate Inline Edit: Generating...',
				cancellable: true,
			},
			async (_progress, token) => {
				token.onCancellationRequested(() => abort.abort());

				try {
					const fileName = path.basename(document.fileName);
					const promptParts = hasSelection
						? [
							`File: ${fileName} (${document.languageId})`,
							`Instruction: ${instruction}`,
							`--- CODE BEFORE SELECTION ---\n${beforeContext}`,
							`--- SELECTED CODE TO REPLACE ---\n${originalText}`,
							`--- CODE AFTER SELECTION ---\n${afterContext}`,
							'Output ONLY the replacement code for the selected block. Do NOT include markdown fences or explanations.',
						]
						: [
							`File: ${fileName} (${document.languageId})`,
							`Instruction: ${instruction}`,
							`--- CODE BEFORE CURSOR ---\n${beforeContext}`,
							`--- CODE AFTER CURSOR ---\n${afterContext}`,
							'Output ONLY the exact code to insert at the cursor. Do NOT include markdown fences or explanations.',
						];

					const res = await this.llm.streamChat({
						temperature: 0.15,
						signal: abort.signal,
						messages: [
							{
								role: 'system',
								content:
									'You are Aether Inline Edit (Ctrl+K). Return strictly valid source code matching file indentation and style. ' +
									'Never wrap output in ``` fences or add commentary.',
							},
							{ role: 'user', content: promptParts.join('\n\n') },
						],
					});

					if (abort.signal.aborted) {
						return;
					}

					const cleaned = stripCodeFences(res.text);
					if (!cleaned.trim()) {
						vscode.window.showWarningMessage('Aether Inline Edit returned empty output.');
						return;
					}

					const applied = await editor.edit(editBuilder => {
						editBuilder.replace(targetRange, cleaned);
					});

					if (!applied) {
						vscode.window.showErrorMessage('Could not apply inline edit to editor.');
						return;
					}

					const hunks = computeDiffHunks(originalText, cleaned, targetRange.start.line);
					this.pendingEdit = {
						uri: document.uri,
						instruction,
						startLine: targetRange.start.line,
						originalText,
						hunks,
					};

					await vscode.commands.executeCommand('setContext', 'aether.inlineEditPending', true);
					this.refreshDecorations();
					this._onDidChangeCodeLenses.fire();
					const revealEnd = Math.min(document.lineCount - 1, targetRange.start.line + cleaned.split(/\r?\n/).length);
					editor.revealRange(new vscode.Range(targetRange.start.line, 0, revealEnd, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
				} catch (err) {
					if (!abort.signal.aborted) {
						vscode.window.showErrorMessage(`Aether Inline Edit failed: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
			}
		);
	}

	public async acceptHunk(hunkId: string): Promise<void> {
		if (!this.pendingEdit) {
			return;
		}
		const hunk = this.pendingEdit.hunks.find(h => h.id === hunkId);
		if (hunk) {
			hunk.resolved = true;
		}
		if (this.pendingEdit.hunks.every(h => h.resolved)) {
			await this.accept();
		} else {
			this.refreshDecorations();
			this._onDidChangeCodeLenses.fire();
		}
	}

	public async rejectHunk(hunkId: string): Promise<void> {
		if (!this.pendingEdit) {
			return;
		}
		const idx = this.pendingEdit.hunks.findIndex(h => h.id === hunkId && !h.resolved);
		if (idx === -1) {
			return;
		}
		const hunk = this.pendingEdit.hunks[idx];
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === this.pendingEdit!.uri.toString());
		if (!editor) {
			return;
		}
		const doc = editor.document;
		const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
		const replacement = hunk.originalLines.join(eol);

		let range: vscode.Range;
		if (hunk.newLines.length === 0) {
			const insertLine = Math.max(0, Math.min(hunk.startLine, doc.lineCount - 1));
			range = new vscode.Range(insertLine, 0, insertLine, 0);
			await editor.edit(b => b.insert(range.start, replacement + eol));
		} else {
			const startLine = Math.max(0, Math.min(hunk.startLine, doc.lineCount - 1));
			const endLine = Math.max(startLine, Math.min(hunk.endLine, doc.lineCount - 1));
			if (hunk.originalLines.length === 0 && endLine + 1 < doc.lineCount) {
				range = new vscode.Range(startLine, 0, endLine + 1, 0);
				await editor.edit(b => b.delete(range));
			} else {
				range = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
				await editor.edit(b => b.replace(range, replacement));
			}
		}

		// Shift subsequent hunks by the line delta
		const lineDelta = hunk.originalLines.length - hunk.newLines.length;
		hunk.resolved = true;
		for (let i = idx + 1; i < this.pendingEdit.hunks.length; i++) {
			this.pendingEdit.hunks[i].startLine += lineDelta;
			this.pendingEdit.hunks[i].endLine += lineDelta;
		}

		if (this.pendingEdit.hunks.every(h => h.resolved)) {
			await this.accept();
		} else {
			this.refreshDecorations();
			this._onDidChangeCodeLenses.fire();
		}
	}

	public async accept(): Promise<void> {
		if (!this.pendingEdit) {
			return;
		}
		this.pendingEdit = undefined;
		await vscode.commands.executeCommand('setContext', 'aether.inlineEditPending', false);
		this.clearDecorations();
		this._onDidChangeCodeLenses.fire();
	}

	public async reject(): Promise<void> {
		const pending = this.pendingEdit;
		if (!pending) {
			return;
		}
		// Reject all remaining hunks from bottom to top to preserve line numbers
		const remaining = pending.hunks.filter(h => !h.resolved).reverse();
		for (const h of remaining) {
			await this.rejectHunk(h.id);
		}
		if (this.pendingEdit) {
			this.pendingEdit = undefined;
			await vscode.commands.executeCommand('setContext', 'aether.inlineEditPending', false);
			this.clearDecorations();
			this._onDidChangeCodeLenses.fire();
		}
	}

	public async retry(): Promise<void> {
		const pending = this.pendingEdit;
		if (!pending) {
			return;
		}
		const prevInstruction = pending.instruction;
		await this.reject();
		await this.trigger(prevInstruction);
	}

	private refreshDecorations(): void {
		this.clearDecorations();
		if (!this.pendingEdit) {
			return;
		}
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === this.pendingEdit!.uri.toString());
		if (!editor) {
			return;
		}
		const addedRanges: vscode.Range[] = [];
		const modRanges: vscode.Range[] = [];

		for (const h of this.pendingEdit.hunks) {
			if (h.resolved) {
				continue;
			}
			const s = Math.max(0, Math.min(h.startLine, editor.document.lineCount - 1));
			const e = Math.max(s, Math.min(h.endLine, editor.document.lineCount - 1));
			const r = new vscode.Range(s, 0, e, editor.document.lineAt(e).text.length);
			if (h.originalLines.length === 0) {
				addedRanges.push(r);
			} else {
				modRanges.push(r);
			}
		}

		editor.setDecorations(this.addedDecoration, addedRanges);
		editor.setDecorations(this.modifiedDecoration, modRanges);
	}

	private clearDecorations(): void {
		for (const editor of vscode.window.visibleTextEditors) {
			editor.setDecorations(this.addedDecoration, []);
			editor.setDecorations(this.modifiedDecoration, []);
		}
	}

	public dispose(): void {
		this.activeAbort?.abort();
		this.addedDecoration.dispose();
		this.modifiedDecoration.dispose();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function computeDiffHunks(originalText: string, newText: string, baseStartLine: number): InlineDiffHunk[] {
	const oldLines = originalText ? originalText.split(/\r?\n/) : [];
	const newLines = newText ? newText.split(/\r?\n/) : [];

	// Fast LCS line diff (bounded for huge blocks)
	if (oldLines.length === 0 || oldLines.length * newLines.length > 250_000) {
		return [{
			id: `hunk_0_${Date.now()}`,
			startLine: baseStartLine,
			endLine: baseStartLine + Math.max(0, newLines.length - 1),
			originalLines: oldLines,
			newLines,
			resolved: false,
		}];
	}

	const m = oldLines.length;
	const n = newLines.length;
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = oldLines[i] === newLines[j]
				? dp[i + 1][j + 1] + 1
				: Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}

	const hunks: InlineDiffHunk[] = [];
	let i = 0;
	let j = 0;
	let hunkIdx = 0;

	while (i < m || j < n) {
		if (i < m && j < n && oldLines[i] === newLines[j]) {
			i++;
			j++;
			continue;
		}
		const origChunk: string[] = [];
		const newChunk: string[] = [];
		const chunkStartNew = j;

		while (i < m || j < n) {
			if (i < m && j < n && oldLines[i] === newLines[j]) {
				break;
			}
			if (i < m && (j === n || dp[i + 1][j] >= dp[i][j + 1])) {
				origChunk.push(oldLines[i++]);
			} else if (j < n) {
				newChunk.push(newLines[j++]);
			}
		}

		hunks.push({
			id: `hunk_${hunkIdx++}_${Date.now()}`,
			startLine: baseStartLine + chunkStartNew,
			endLine: baseStartLine + chunkStartNew + Math.max(0, newChunk.length - 1),
			originalLines: origChunk,
			newLines: newChunk,
			resolved: false,
		});
	}

	return hunks.length > 0 ? hunks : [{
		id: `hunk_0_${Date.now()}`,
		startLine: baseStartLine,
		endLine: baseStartLine + Math.max(0, newLines.length - 1),
		originalLines: oldLines,
		newLines,
		resolved: false,
	}];
}

function stripCodeFences(text: string): string {
	const trimmed = text.trim();
	const match = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);
	return match ? match[1] : text.replace(/^```[a-zA-Z0-9_-]*\r?\n/, '').replace(/\r?\n```$/, '');
}
