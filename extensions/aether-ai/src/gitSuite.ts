/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { AetherLLMClient } from './llmClient';
import { WorkspaceIndex } from './workspaceIndex';

interface ConflictBlock {
	startLine: number;
	sepLine: number;
	endLine: number;
}

export class AetherGitSuite implements vscode.CodeLensProvider, vscode.Disposable {
	private readonly _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly llm: AetherLLMClient,
		private readonly workspaceIndex: WorkspaceIndex
	) {
		this.disposables.push(
			this._onDidChangeCodeLenses,
			vscode.languages.registerCodeLensProvider({ pattern: '**/*' }, this),
			vscode.workspace.onDidChangeTextDocument(() => this._onDidChangeCodeLenses.fire())
		);
	}

	public async runGit(args: string[], cwd?: string): Promise<string> {
		const root = cwd ?? this.workspaceIndex.getWorkspaceRoot();
		if (!root) {
			throw new Error('No workspace folder is open.');
		}
		return await new Promise<string>((resolve, reject) => {
			execFile('git', args, { cwd: root, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
				if (err) {
					reject(new Error(stderr.trim() || err.message));
				} else {
					resolve(stdout);
				}
			});
		});
	}

	public async collectGitContext(): Promise<string> {
		try {
			const [branch, status, log, diff] = await Promise.all([
				this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'unknown'),
				this.runGit(['status', '--short']).catch(() => ''),
				this.runGit(['log', '-n', '6', '--oneline']).catch(() => ''),
				this.runGit(['diff', '--stat']).catch(() => ''),
			]);
			const fullDiff = (await this.runGit(['diff']).catch(() => '')).slice(0, 8000);
			return [
				`Branch: ${branch.trim()}`,
				`Status:\n${status.trim() || '(clean)'}`,
				`Recent Commits:\n${log.trim()}`,
				`Diff Summary:\n${diff.trim() || '(no unstaged changes)'}`,
				fullDiff ? `Diff Excerpt:\n\`\`\`diff\n${fullDiff}\n\`\`\`` : '',
			].filter(Boolean).join('\n\n');
		} catch (err) {
			return `Git context unavailable: ${err instanceof Error ? err.message : String(err)}`;
		}
	}

	public async generateCommitMessage(): Promise<void> {
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!root) {
			vscode.window.showWarningMessage('Open a Git repository to generate a commit message.');
			return;
		}

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Caudate AI: Generating commit message...' },
			async () => {
				try {
					let diff = await this.runGit(['diff', '--cached']);
					if (!diff.trim()) {
						diff = await this.runGit(['diff']);
					}
					if (!diff.trim()) {
						vscode.window.showInformationMessage('No staged or unstaged git changes found.');
						return;
					}

					const res = await this.llm.streamChat({
						temperature: 0.2,
						maxTokens: 220,
						messages: [
							{
								role: 'system',
								content:
									'Generate a concise, accurate Conventional Commit message (type(scope): subject, optional short body bullets). ' +
									'Output ONLY the commit message text with no markdown fences or quotes.',
							},
							{
								role: 'user',
								content: `Git diff:\n${diff.slice(0, 12_000)}`,
							},
						],
					});

					const message = res.text.trim().replace(/^```[\s\S]*?\n|```$/g, '').trim();
					if (!message) {
						return;
					}

					// Populate VS Code built-in Git extension SCM inputBox directly!
					const gitExt = vscode.extensions.getExtension<{ getAPI(v: number): { repositories: Array<{ inputBox: { value: string } }> } }>('vscode.git');
					const gitApi = gitExt?.isActive ? gitExt.exports.getAPI(1) : gitExt ? (await gitExt.activate()).getAPI(1) : undefined;
					if (gitApi && gitApi.repositories.length > 0) {
						gitApi.repositories[0].inputBox.value = message;
						vscode.window.showInformationMessage('Caudate AI populated the Git commit message.');
					} else {
						await vscode.env.clipboard.writeText(message);
						vscode.window.showInformationMessage(`Commit message copied to clipboard: ${message.split('\n')[0]}`);
					}
				} catch (err) {
					vscode.window.showErrorMessage(`Commit message generation failed: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		);
	}

	public provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const conflicts = findConflicts(document);
		return conflicts.map(c =>
			new vscode.CodeLens(new vscode.Range(c.startLine, 0, c.startLine, 0), {
				title: '$(sparkle) Resolve Conflict with Caudate AI',
				command: 'aether.resolveMergeConflict',
				arguments: [document.uri, c.startLine, c.endLine],
			})
		);
	}

	public async resolveMergeConflict(uri?: vscode.Uri, startLine?: number, endLine?: number): Promise<void> {
		const editor = uri
			? vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri.toString()) ?? vscode.window.activeTextEditor
			: vscode.window.activeTextEditor;
		if (!editor) {
			return;
		}
		const doc = editor.document;
		let targetRange: vscode.Range;
		if (typeof startLine === 'number' && typeof endLine === 'number') {
			targetRange = new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length);
		} else {
			const conflicts = findConflicts(doc);
			if (conflicts.length === 0) {
				vscode.window.showInformationMessage('No merge conflict markers found in active file.');
				return;
			}
			const first = conflicts[0];
			targetRange = new vscode.Range(first.startLine, 0, first.endLine, doc.lineAt(first.endLine).text.length);
		}

		const conflictText = doc.getText(targetRange);
		const beforeCtx = doc.getText(new vscode.Range(Math.max(0, targetRange.start.line - 25), 0, targetRange.start.line, 0));
		const afterCtx = doc.getText(new vscode.Range(targetRange.end.line, doc.lineAt(targetRange.end.line).text.length, Math.min(doc.lineCount - 1, targetRange.end.line + 25), 0));

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Caudate AI: Resolving merge conflict...' },
			async () => {
				const res = await this.llm.streamChat({
					temperature: 0.1,
					messages: [
						{
							role: 'system',
							content:
								'You are an expert Git merge conflict resolver. Combine both sides intelligently without losing intent, and remove all conflict markers (<<<<<<<, =======, >>>>>>>). ' +
								'Output ONLY the resolved code block with no markdown fences or explanations.',
						},
						{
							role: 'user',
							content: `File: ${path.basename(doc.fileName)}\n--- BEFORE ---\n${beforeCtx}\n--- CONFLICT ---\n${conflictText}\n--- AFTER ---\n${afterCtx}`,
						},
					],
				});
				const resolved = res.text.trim().replace(/^```[a-zA-Z0-9_-]*\r?\n/, '').replace(/\r?\n```$/, '');
				if (resolved) {
					await editor.edit(b => b.replace(targetRange, resolved));
					vscode.window.showInformationMessage('Resolved merge conflict with Aether AI.');
				}
			}
		);
	}

	public dispose(): void {
		for (const d of this.disposables) {
			d.dispose();
		}
	}
}

function findConflicts(document: vscode.TextDocument): ConflictBlock[] {
	const blocks: ConflictBlock[] = [];
	let start = -1;
	let sep = -1;
	for (let i = 0; i < document.lineCount; i++) {
		const text = document.lineAt(i).text;
		if (text.startsWith('<<<<<<<')) {
			start = i;
			sep = -1;
		} else if (start !== -1 && text.startsWith('=======')) {
			sep = i;
		} else if (start !== -1 && sep !== -1 && text.startsWith('>>>>>>>')) {
			blocks.push({ startLine: start, sepLine: sep, endLine: i });
			start = -1;
			sep = -1;
		}
	}
	return blocks;
}
