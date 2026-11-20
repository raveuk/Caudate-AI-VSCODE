/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AetherLLMClient } from './llmClient';

interface PendingNesPrediction {
	uri: vscode.Uri;
	startLine: number;
	endLine: number;
	originalText: string;
	replacementText: string;
	summary: string;
}

/**
 * Cursor Tab / Next Edit Suggestion (NES) Engine:
 * Observes recent user edits and predicts follow-up multi-line edits or next-line jumps.
 * Press Tab to jump to and apply the predicted edit, or Esc to dismiss.
 */
export class NextEditPredictionController implements vscode.Disposable {
	private readonly previewDecoration = vscode.window.createTextEditorDecorationType({
		backgroundColor: 'rgba(56, 139, 253, 0.14)',
		borderWidth: '0 0 0 3px',
		borderStyle: 'solid',
		borderColor: '#388bfd',
		isWholeLine: true,
		after: {
			color: 'rgba(139, 148, 158, 0.9)',
			margin: '0 0 0 18px',
			fontStyle: 'italic',
		},
	});

	private recentEditSummary = '';
	private debounceTimer: ReturnType<typeof setTimeout> | undefined;
	private activeAbort: AbortController | undefined;
	private pending: PendingNesPrediction | undefined;
	private isApplying = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly llm: AetherLLMClient) {
		this.disposables.push(
			this.previewDecoration,
			vscode.workspace.onDidChangeTextDocument(e => this.onDocumentChanged(e)),
			vscode.window.onDidChangeActiveTextEditor(() => void this.dismiss())
		);
	}

	private onDocumentChanged(event: vscode.TextDocumentChangeEvent): void {
		if (this.isApplying || event.contentChanges.length === 0) {
			return;
		}
		const editor = vscode.window.activeTextEditor;
		if (!editor || editor.document.uri.toString() !== event.document.uri.toString()) {
			return;
		}
		if (event.document.uri.scheme !== 'file' && event.document.uri.scheme !== 'untitled') {
			return;
		}

		// Clear stale prediction on further typing
		if (this.pending) {
			void this.dismiss();
		}

		const change = event.contentChanges[0];
		const line = change.range.start.line + 1;
		this.recentEditSummary = `Line ${line}: replaced ${change.rangeLength} chars with ${JSON.stringify(change.text.slice(0, 120))}`;

		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			void this.predictNextEdit(editor);
		}, 950);
	}

	private async predictNextEdit(editor: vscode.TextEditor): Promise<void> {
		const settings = await this.llm.getSettings();
		if (!settings.tabEnabled || !settings.nesEnabled) {
			return;
		}

		const doc = editor.document;
		const cursorLine = editor.selection.active.line;
		const windowStart = Math.max(0, cursorLine - 25);
		const windowEnd = Math.min(doc.lineCount - 1, cursorLine + 35);
		const numberedSnippet = [];
		for (let l = windowStart; l <= windowEnd; l++) {
			numberedSnippet.push(`${l + 1}: ${doc.lineAt(l).text}`);
		}

		this.activeAbort?.abort();
		const abort = new AbortController();
		this.activeAbort = abort;

		try {
			const provider = settings.tabProvider === 'same' ? settings.provider : settings.tabProvider;
			const res = await this.llm.streamChat({
				providerOverride: provider,
				modelOverride: settings.tabModel.trim() || undefined,
				temperature: 0.1,
				maxTokens: 280,
				signal: abort.signal,
				messages: [
					{
						role: 'system',
						content:
							'You are a Next Edit Prediction (Cursor Tab) engine. Given a recent edit and surrounding numbered code lines, ' +
							'predict if there is an obvious next edit needed nearby (e.g. updating a matching call site, rename, type, import, or closing pattern). ' +
							'If NO obvious next edit is needed, respond with {"none": true}. ' +
							'Otherwise respond ONLY with strict JSON: {"startLine": <1-based>, "endLine": <1-based inclusive>, "replacement": "<exact replacement lines>", "summary": "<short 5-word label>"}.',
					},
					{
						role: 'user',
						content: `File: ${path.basename(doc.fileName)} (${doc.languageId})\nRecent edit: ${this.recentEditSummary}\n\n${numberedSnippet.join('\n')}`,
					},
				],
			});

			if (abort.signal.aborted) {
				return;
			}

			const jsonMatch = /\{[\s\S]*\}/.exec(res.text);
			if (!jsonMatch) {
				return;
			}
			const parsed = JSON.parse(jsonMatch[0]) as {
				none?: boolean;
				startLine?: number;
				endLine?: number;
				replacement?: string;
				summary?: string;
			};
			if (parsed.none || typeof parsed.startLine !== 'number' || typeof parsed.endLine !== 'number' || typeof parsed.replacement !== 'string') {
				return;
			}

			const s = Math.max(0, Math.min(parsed.startLine - 1, doc.lineCount - 1));
			const e = Math.max(s, Math.min(parsed.endLine - 1, doc.lineCount - 1));
			const targetRange = new vscode.Range(s, 0, e, doc.lineAt(e).text.length);
			const originalText = doc.getText(targetRange);
			if (originalText === parsed.replacement) {
				return;
			}

			this.pending = {
				uri: doc.uri,
				startLine: s,
				endLine: e,
				originalText,
				replacementText: parsed.replacement,
				summary: parsed.summary || 'Apply predicted edit',
			};

			await vscode.commands.executeCommand('setContext', 'aether.nesPending', true);
			const previewFirstLine = parsed.replacement.split(/\r?\n/)[0].trim().slice(0, 50);
			editor.setDecorations(this.previewDecoration, [{
				range: targetRange,
				renderOptions: {
					after: {
						contentText: `⇥ Tab: ${this.pending.summary} → ${previewFirstLine}`,
					},
				},
			}]);
		} catch {
			// Silent fail for speculative background prediction
		}
	}

	public async accept(): Promise<void> {
		const pred = this.pending;
		if (!pred) {
			return;
		}
		const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === pred.uri.toString());
		await this.dismiss();
		if (!editor) {
			return;
		}
		const doc = editor.document;
		const s = Math.max(0, Math.min(pred.startLine, doc.lineCount - 1));
		const e = Math.max(s, Math.min(pred.endLine, doc.lineCount - 1));
		const range = new vscode.Range(s, 0, e, doc.lineAt(e).text.length);

		this.isApplying = true;
		try {
			await editor.edit(b => b.replace(range, pred.replacementText));
			const endPos = new vscode.Position(s, 0);
			editor.selection = new vscode.Selection(endPos, endPos);
			editor.revealRange(new vscode.Range(s, 0, s, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		} finally {
			this.isApplying = false;
		}
	}

	public async dismiss(): Promise<void> {
		this.pending = undefined;
		await vscode.commands.executeCommand('setContext', 'aether.nesPending', false);
		for (const ed of vscode.window.visibleTextEditors) {
			ed.setDecorations(this.previewDecoration, []);
		}
	}

	public dispose(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.activeAbort?.abort();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
