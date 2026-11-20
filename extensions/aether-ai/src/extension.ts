/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { AetherDiffContentProvider, AgentToolExecutor } from './agentTools';
import { BuiltinBrowserAgent } from './browserAgent';
import { AetherChatViewProvider } from './chatViewProvider';
import { AetherGitSuite } from './gitSuite';
import { IgnoreAndSecurityService } from './ignoreService';
import { InlineEditController } from './inlineEdit';
import { AetherLLMClient } from './llmClient';
import { McpClientManager } from './mcpClient';
import { NextEditPredictionController } from './nextEditPrediction';
import { AetherQuickFixProvider } from './quickFixProvider';
import { RulesAndSkillsService } from './rulesAndSkills';
import { TabAutocompleteProvider } from './tabAutocomplete';
import { TerminalInlineController } from './terminalInline';
import { ProviderId } from './types';
import { SemanticVectorIndex } from './vectorIndex';
import { WorkspaceIndex } from './workspaceIndex';
import { ParallelWorktreeManager } from './worktreeManager';

export function activate(context: vscode.ExtensionContext): void {
	const llm = new AetherLLMClient(context);
	const ignoreService = new IgnoreAndSecurityService();
	const workspaceIndex = new WorkspaceIndex(ignoreService);
	const rulesService = new RulesAndSkillsService(context);
	const vectorIndex = new SemanticVectorIndex(llm, workspaceIndex);
	const mcpClient = new McpClientManager();
	const browserAgent = new BuiltinBrowserAgent();
	const diffProvider = new AetherDiffContentProvider();
	const toolExecutor = new AgentToolExecutor(workspaceIndex, diffProvider, ignoreService, mcpClient, browserAgent);
	const gitSuite = new AetherGitSuite(llm, workspaceIndex);
	const worktreeManager = new ParallelWorktreeManager(llm, workspaceIndex);
	const chatProvider = new AetherChatViewProvider(
		context,
		llm,
		workspaceIndex,
		toolExecutor,
		ignoreService,
		rulesService,
		vectorIndex,
		mcpClient,
		gitSuite,
		worktreeManager
	);
	const inlineEdit = new InlineEditController(llm);
	const tabAutocomplete = new TabAutocompleteProvider(llm);
	const nextEditPrediction = new NextEditPredictionController(llm);
	const quickFixProvider = new AetherQuickFixProvider(inlineEdit);
	const terminalInline = new TerminalInlineController(llm, workspaceIndex);

	// Load cached vector index and connect configured MCP servers silently in background
	void vectorIndex.loadCache();
	void mcpClient.reload(workspaceIndex.getWorkspaceRoot());

	// Bottom-right "Aether" status bar indicator
	const aetherStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
	aetherStatus.command = 'aether.focusChat';
	const refreshStatus = async () => {
		const s = await llm.getSettings();
		const model = llm.getActiveModelName(s);
		const providerLabel = s.provider === 'ollama'
			? 'Ollama'
			: s.provider === 'lmstudio'
				? 'LM Studio'
				: 'OpenAI API';
		const mcpCount = mcpClient.getStatuses().filter(m => m.status === 'connected').length;
		const mcpSuffix = mcpCount > 0 ? ` · ${mcpCount} MCP` : '';
		aetherStatus.text = `$(sparkle) Caudate (${model}${mcpSuffix})`;
		aetherStatus.tooltip = `Caudate AI · ${providerLabel} · Ctrl+L Agent · Ctrl+K Inline/Terminal Edit`;
	};
	void refreshStatus();
	aetherStatus.show();

	context.subscriptions.push(
		aetherStatus,
		inlineEdit,
		tabAutocomplete,
		nextEditPrediction,
		quickFixProvider,
		gitSuite,
		vectorIndex,
		mcpClient,
		browserAgent,
		llm.onDidChangeSettings(() => void refreshStatus()),
		vscode.workspace.registerTextDocumentContentProvider('aether-diff', diffProvider),
		vscode.window.registerWebviewViewProvider(AetherChatViewProvider.viewType, chatProvider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),

		vscode.commands.registerCommand('aether.focusChat', () => chatProvider.focus()),
		vscode.commands.registerCommand('aether.openComposer', () => chatProvider.focus('agent')),
		vscode.commands.registerCommand('aether.newChat', () => chatProvider.startNewChat()),
		vscode.commands.registerCommand('aether.openHistory', () => chatProvider.openPanelDrawer('history')),
		vscode.commands.registerCommand('aether.openAgents', () => chatProvider.openPanelDrawer('agents')),
		vscode.commands.registerCommand('aether.openNotepads', () => chatProvider.openPanelDrawer('notepads')),
		vscode.commands.registerCommand('aether.openSettings', () => chatProvider.openPanelDrawer('settings')),
		vscode.commands.registerCommand('aether.addSelectionToChat', () => chatProvider.addActiveSelectionToChat()),
		vscode.commands.registerCommand('aether.explainSelection', () =>
			chatProvider.addActiveSelectionToChat('Explain how this selected code works, including edge cases and potential bugs.')
		),
		vscode.commands.registerCommand('aether.fixProblems', () => chatProvider.fixActiveFileProblems()),
		vscode.commands.registerCommand('aether.quickFixDiagnostic', (uri: vscode.Uri, range: vscode.Range, msg: string) =>
			quickFixProvider.executeQuickFix(uri, range, msg)
		),

		vscode.commands.registerCommand('aether.inlineEdit', () => inlineEdit.trigger()),
		vscode.commands.registerCommand('aether.terminalInlineEdit', () => terminalInline.trigger()),
		vscode.commands.registerCommand('aether.acceptInlineEdit', () => inlineEdit.accept()),
		vscode.commands.registerCommand('aether.rejectInlineEdit', () => inlineEdit.reject()),
		vscode.commands.registerCommand('aether.retryInlineEdit', () => inlineEdit.retry()),
		vscode.commands.registerCommand('aether.acceptInlineHunk', (hunkId: string) => inlineEdit.acceptHunk(hunkId)),
		vscode.commands.registerCommand('aether.rejectInlineHunk', (hunkId: string) => inlineEdit.rejectHunk(hunkId)),

		vscode.commands.registerCommand('aether.acceptNes', () => nextEditPrediction.accept()),
		vscode.commands.registerCommand('aether.dismissNes', () => nextEditPrediction.dismiss()),

		vscode.commands.registerCommand('aether.generateCommitMessage', () => gitSuite.generateCommitMessage()),
		vscode.commands.registerCommand('aether.reviewGitDiff', () => chatProvider.reviewGitDiff()),
		vscode.commands.registerCommand('aether.resolveMergeConflict', (uri?: vscode.Uri, startLine?: number, endLine?: number) =>
			gitSuite.resolveMergeConflict(uri, startLine, endLine)
		),

		vscode.commands.registerCommand('aether.rebuildVectorIndex', async () => {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Caudate AI: Indexing codebase...' },
				async progress => {
					const st = await vectorIndex.rebuildIndex(m => progress.report({ message: m }));
					vscode.window.showInformationMessage(
						`Caudate Index complete: ${st.indexedFiles} files, ${st.indexedChunks} chunks (${st.usingEmbeddings ? `embeddings: ${st.embeddingModel}` : 'hybrid lexical'}).`
					);
				}
			);
		}),

		vscode.commands.registerCommand('aether.editMcpConfig', () => mcpClient.openOrCreateConfig(workspaceIndex.getWorkspaceRoot())),

		vscode.commands.registerCommand('aether.spawnWorktreeAgent', async () => {
			const taskPrompt = await vscode.window.showInputBox({
				title: 'Caudate AI · Spawn Parallel Git Worktree Agent',
				prompt: 'Describe the task to execute autonomously in an isolated git branch & worktree',
				placeHolder: 'e.g. Add unit tests for auth module and fix any edge cases',
			});
			if (taskPrompt && taskPrompt.trim()) {
				try {
					await worktreeManager.spawnTask(taskPrompt.trim());
					await chatProvider.openPanelDrawer('agents');
				} catch (err) {
					vscode.window.showErrorMessage(`Failed to spawn worktree agent: ${err instanceof Error ? err.message : String(err)}`);
				}
			}
		}),

		vscode.commands.registerCommand('aether.toggleAutocomplete', async () => {
			const s = await llm.getSettings();
			await llm.updateSettings({ tabEnabled: !s.tabEnabled });
			vscode.window.showInformationMessage(`Caudate Tab Autocomplete ${!s.tabEnabled ? 'enabled' : 'disabled'}.`);
		}),

		vscode.commands.registerCommand('aether.openTabSettings', async () => {
			const s = await llm.getSettings();
			const pick = await vscode.window.showQuickPick(
				[
					{ label: s.tabEnabled ? '$(circle-slash) Disable Tab Autocomplete' : '$(sparkle) Enable Tab Autocomplete', action: 'toggle' },
					{ label: s.nesEnabled ? '$(circle-slash) Disable Next Edit Prediction (NES)' : '$(arrow-right) Enable Next Edit Prediction (NES)', action: 'toggleNes' },
					{ label: '$(settings-gear) Configure Tab Provider & Model...', description: `${s.tabProvider === 'same' ? `Same (${s.provider})` : s.tabProvider}${s.tabModel ? ` · ${s.tabModel}` : ''}`, action: 'settings' },
					{ label: '$(symbol-event) Switch Active Chat / Agent Model...', description: llm.getActiveModelName(s), action: 'switchModel' },
				],
				{ title: 'Caudate Tab & NES Settings' }
			);
			if (!pick) {
				return;
			}
			if (pick.action === 'toggle') {
				await llm.updateSettings({ tabEnabled: !s.tabEnabled });
			} else if (pick.action === 'toggleNes') {
				await llm.updateSettings({ nesEnabled: !s.nesEnabled });
			} else if (pick.action === 'settings') {
				await chatProvider.openPanelDrawer('settings');
			} else if (pick.action === 'switchModel') {
				await vscode.commands.executeCommand('aether.switchModel');
			}
		}),

		vscode.commands.registerCommand('aether.switchModel', async () => {
			const s = await llm.getSettings();
			const providerPick = await vscode.window.showQuickPick<vscode.QuickPickItem & { provider: ProviderId }>(
				[
					{ label: '$(server) Ollama (Local)', description: s.ollamaBaseUrl, provider: 'ollama' },
					{ label: '$(vm) LM Studio (Local)', description: s.lmstudioBaseUrl, provider: 'lmstudio' },
					{ label: '$(cloud) OpenAI / Compatible API', description: s.openaiBaseUrl, provider: 'openai-compatible' },
				],
				{ title: 'Select AI Provider' }
			);
			if (!providerPick) {
				return;
			}
			await llm.updateSettings({ provider: providerPick.provider });

			const discovered = await llm.listModels(providerPick.provider).catch(() => []);
			if (discovered.length > 0) {
				const modelPick = await vscode.window.showQuickPick(
					discovered.map(m => ({ label: m.id, description: m.size })),
					{ title: `Select ${providerPick.label} Model` }
				);
				if (modelPick) {
					if (providerPick.provider === 'ollama') {
						await llm.updateSettings({ ollamaModel: modelPick.label });
					} else if (providerPick.provider === 'lmstudio') {
						await llm.updateSettings({ lmstudioModel: modelPick.label });
					} else {
						await llm.updateSettings({ openaiModel: modelPick.label });
					}
				}
			} else {
				const manual = await vscode.window.showInputBox({
					title: `Enter ${providerPick.provider} Model Name`,
					value: llm.getActiveModelName(s, providerPick.provider),
				});
				if (manual && manual.trim()) {
					if (providerPick.provider === 'ollama') {
						await llm.updateSettings({ ollamaModel: manual.trim() });
					} else if (providerPick.provider === 'lmstudio') {
						await llm.updateSettings({ lmstudioModel: manual.trim() });
					} else {
						await llm.updateSettings({ openaiModel: manual.trim() });
					}
				}
			}
		})
	);

	// Auto-focus Aether AI Agent panel in the right sidebar on startup
	setTimeout(() => {
		void vscode.commands.executeCommand('aether.chatView.focus');
	}, 500);
}

export function deactivate(): void {
	// Cleaned up via context.subscriptions
}
