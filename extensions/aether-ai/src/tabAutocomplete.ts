/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { AetherLLMClient } from './llmClient';

export class TabAutocompleteProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
	private readonly cache = new Map<string, string>();
	private readonly MAX_CACHE = 40;
	private currentAbort: AbortController | undefined;
	private statusBarItem: vscode.StatusBarItem;
	private enabled = true;
	private isLoading = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly llm: AetherLLMClient) {
		this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
		this.statusBarItem.command = 'aether.openTabSettings';
		this.statusBarItem.show();

		this.disposables.push(
			this.statusBarItem,
			vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, this),
			this.llm.onDidChangeSettings(s => {
				this.enabled = s.tabEnabled;
				this.updateStatusBar();
			})
		);

		void this.llm.getSettings().then(s => {
			this.enabled = s.tabEnabled;
			this.updateStatusBar();
		});
	}

	private updateStatusBar(): void {
		if (!this.enabled) {
			this.statusBarItem.text = '$(circle-slash) Tab Settings';
			this.statusBarItem.tooltip = 'Caudate Tab Autocomplete is Off — Click to configure';
			return;
		}
		if (this.isLoading) {
			this.statusBarItem.text = '$(loading~spin) Tab Settings';
			this.statusBarItem.tooltip = 'Caudate Tab Autocomplete: Generating suggestion...';
			return;
		}
		this.statusBarItem.text = '$(sparkle) Tab Settings';
		this.statusBarItem.tooltip = 'Caudate Tab Autocomplete is Active — Click to configure';
	}

	public async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | undefined> {
		const settings = await this.llm.getSettings();
		this.enabled = settings.tabEnabled;
		if (!this.enabled || document.uri.scheme === 'output' || document.uri.scheme === 'aether-diff') {
			this.updateStatusBar();
			return undefined;
		}

		// Skip completion on completely empty documents
		if (document.getText().trim().length === 0) {
			return undefined;
		}

		// Extract prefix (last 65 lines) & suffix (next 25 lines)
		const prefixStartLine = Math.max(0, position.line - 65);
		const suffixEndLine = Math.min(document.lineCount - 1, position.line + 25);
		const prefix = document.getText(new vscode.Range(prefixStartLine, 0, position.line, position.character));
		const suffix = document.getText(new vscode.Range(position.line, position.character, suffixEndLine, document.lineAt(suffixEndLine).text.length));

		const cacheKey = `${document.uri.toString()}::${prefix.slice(-240)}::${suffix.slice(0, 120)}`;
		const cached = this.cache.get(cacheKey);
		if (cached) {
			return [new vscode.InlineCompletionItem(cached, new vscode.Range(position, position))];
		}

		// Debounce
		await new Promise<void>(resolve => {
			const timer = setTimeout(resolve, settings.tabDebounceMs);
			token.onCancellationRequested(() => {
				clearTimeout(timer);
				resolve();
			});
		});
		if (token.isCancellationRequested) {
			return undefined;
		}

		this.currentAbort?.abort();
		const abort = new AbortController();
		this.currentAbort = abort;
		token.onCancellationRequested(() => abort.abort());

		this.isLoading = true;
		this.updateStatusBar();

		try {
			const suggestion = await this.llm.completeInline({
				prefix,
				suffix,
				languageId: document.languageId,
				fileName: path.basename(document.fileName),
				signal: abort.signal,
			});

			if (token.isCancellationRequested || !suggestion) {
				return undefined;
			}

			this.cache.set(cacheKey, suggestion);
			if (this.cache.size > this.MAX_CACHE) {
				const firstKey = this.cache.keys().next().value;
				if (firstKey) {
					this.cache.delete(firstKey);
				}
			}

			return [new vscode.InlineCompletionItem(suggestion, new vscode.Range(position, position))];
		} catch {
			return undefined;
		} finally {
			if (this.currentAbort === abort) {
				this.isLoading = false;
				this.updateStatusBar();
			}
		}
	}

	public dispose(): void {
		this.currentAbort?.abort();
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
