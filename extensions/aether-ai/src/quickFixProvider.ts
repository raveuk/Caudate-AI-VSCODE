/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { InlineEditController } from './inlineEdit';

export class AetherQuickFixProvider implements vscode.CodeActionProvider, vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly inlineEdit: InlineEditController) {
		this.disposables.push(
			vscode.languages.registerCodeActionsProvider(
				{ pattern: '**/*' },
				this,
				{ providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }
			)
		);
	}

	public provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range,
		context: vscode.CodeActionContext
	): vscode.CodeAction[] {
		const relevant = context.diagnostics.filter(
			d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning
		);
		if (relevant.length === 0) {
			return [];
		}

		const summary = relevant.map(d => d.message).slice(0, 3).join('; ');
		const fixAction = new vscode.CodeAction(`Caudate AI: Fix "${summary.slice(0, 60)}"`, vscode.CodeActionKind.QuickFix);
		fixAction.diagnostics = relevant;
		fixAction.isPreferred = false;
		fixAction.command = {
			title: 'Fix with Caudate AI',
			command: 'aether.quickFixDiagnostic',
			arguments: [document.uri, range, summary],
		};

		const chatAction = new vscode.CodeAction('Caudate AI: Explain & Fix in Agent Chat', vscode.CodeActionKind.QuickFix);
		chatAction.diagnostics = relevant;
		chatAction.command = {
			title: 'Fix Problems in Active File',
			command: 'aether.fixProblems',
		};

		return [fixAction, chatAction];
	}

	public async executeQuickFix(uri: vscode.Uri, range: vscode.Range, message: string): Promise<void> {
		const doc = await vscode.workspace.openTextDocument(uri);
		const editor = await vscode.window.showTextDocument(doc);
		const expanded = new vscode.Range(
			Math.max(0, range.start.line - 3),
			0,
			Math.min(doc.lineCount - 1, range.end.line + 3),
			doc.lineAt(Math.min(doc.lineCount - 1, range.end.line + 3)).text.length
		);
		editor.selection = new vscode.Selection(expanded.start, expanded.end);
		await this.inlineEdit.trigger(`Fix this diagnostic error/warning cleanly without changing unrelated code: ${message}`, expanded);
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}
