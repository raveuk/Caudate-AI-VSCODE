/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AetherLLMClient } from './llmClient';
import { WorkspaceIndex } from './workspaceIndex';

/**
 * Terminal Inline Ctrl+K:
 * Generates exact PowerShell/bash commands from natural language and injects or executes
 * them directly in the active integrated terminal.
 */
export class TerminalInlineController {
	constructor(
		private readonly llm: AetherLLMClient,
		private readonly workspaceIndex: WorkspaceIndex
	) {}

	public async trigger(): Promise<void> {
		const prompt = await vscode.window.showInputBox({
			title: 'Caudate AI · Terminal Inline (Ctrl+K)',
			prompt: `Describe the ${process.platform === 'win32' ? 'PowerShell' : 'shell'} command you want to run`,
			placeHolder: 'e.g. find all .ts files modified today, kill process on port 3000, git squash last 3 commits...',
			ignoreFocusOut: true,
		});
		if (!prompt || !prompt.trim()) {
			return;
		}

		const root = this.workspaceIndex.getWorkspaceRoot() ?? process.cwd();
		const shellKind = process.platform === 'win32' ? 'Windows PowerShell 5.1+' : 'bash/zsh';

		let generatedCmd = '';
		let explanation = '';

		await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: 'Caudate Terminal: Generating command...' },
			async () => {
				const res = await this.llm.streamChat({
					temperature: 0.1,
					maxTokens: 200,
					messages: [
						{
							role: 'system',
							content:
								`You generate concise, safe ${shellKind} one-liner commands for a developer's IDE terminal. ` +
								'Respond ONLY in strict JSON: {"command": "<exact shell command>", "explanation": "<1-sentence explanation>"}.',
						},
						{
							role: 'user',
							content: `Working directory: ${root}\nRequest: ${prompt}`,
						},
					],
				});

				const match = /\{[\s\S]*\}/.exec(res.text);
				if (match) {
					try {
						const parsed = JSON.parse(match[0]) as { command?: string; explanation?: string };
						generatedCmd = (parsed.command ?? '').trim();
						explanation = (parsed.explanation ?? '').trim();
					} catch {
						generatedCmd = res.text.trim();
					}
				} else {
					generatedCmd = res.text.trim().replace(/^```[a-z]*\r?\n|\r?\n```$/g, '').trim();
				}
			}
		);

		if (!generatedCmd) {
			vscode.window.showWarningMessage('Aether Terminal did not generate a command.');
			return;
		}

		const pick = await vscode.window.showQuickPick(
			[
				{
					label: '$(play) Run in Terminal',
					description: generatedCmd,
					detail: explanation || undefined,
					action: 'run',
				},
				{
					label: '$(edit) Insert into Terminal (without pressing Enter)',
					description: generatedCmd,
					action: 'insert',
				},
				{
					label: '$(copy) Copy Command',
					description: generatedCmd,
					action: 'copy',
				},
			],
			{ title: 'Caudate Terminal Command Ready' }
		);

		if (!pick) {
			return;
		}

		if (pick.action === 'copy') {
			await vscode.env.clipboard.writeText(generatedCmd);
			return;
		}

		const terminal = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'Aether', cwd: root });
		terminal.show(true);
		terminal.sendText(generatedCmd, pick.action === 'run');
	}
}
