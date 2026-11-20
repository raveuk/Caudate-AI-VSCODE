/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { AgentToolExecutor } from './agentTools';
import { AetherGitSuite } from './gitSuite';
import { IgnoreAndSecurityService } from './ignoreService';
import { AetherLLMClient } from './llmClient';
import { McpClientManager } from './mcpClient';
import { RulesAndSkillsService } from './rulesAndSkills';
import {
	AetherSettings,
	ArtifactCard,
	ChatMessageParam,
	ChatMode,
	ChatSession,
	ContextChip,
	DiscoveredModel,
	FileEditRecord,
	ImageAttachment,
	MessageContentPart,
	PROVIDER_PRESETS,
	ProviderId,
	ToolExecutionCard,
	UITurn,
} from './types';
import { SemanticVectorIndex } from './vectorIndex';
import { WorkspaceIndex } from './workspaceIndex';
import { ParallelWorktreeManager } from './worktreeManager';

const SESSIONS_KEY = 'aether.chatSessions.v1';
const MAX_SESSIONS = 30;

interface ApprovalWaiter {
	resolve: (approved: boolean) => void;
}

type DrawerName = 'settings' | 'history' | 'agents' | 'notepads';

export class AetherChatViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'aether.chatView';

	private view: vscode.WebviewView | undefined;
	private sessions: ChatSession[] = [];
	private activeSessionId: string;
	private activeAbort: AbortController | undefined;
	private pendingApprovals = new Map<string, ApprovalWaiter>();
	private discoveredModels: Partial<Record<ProviderId, DiscoveredModel[]>> = {};
	private pendingViewAction: DrawerName | undefined;
	private reviewIndex = 0;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly llm: AetherLLMClient,
		private readonly workspaceIndex: WorkspaceIndex,
		private readonly toolExecutor: AgentToolExecutor,
		private readonly ignoreService: IgnoreAndSecurityService,
		private readonly rulesService: RulesAndSkillsService,
		private readonly vectorIndex: SemanticVectorIndex,
		private readonly mcpClient: McpClientManager,
		private readonly gitSuite: AetherGitSuite,
		private readonly worktreeManager: ParallelWorktreeManager
	) {
		this.sessions = this.context.workspaceState.get<ChatSession[]>(SESSIONS_KEY, []);
		if (this.sessions.length === 0) {
			const fresh = createEmptySession('agent');
			this.sessions.push(fresh);
			this.activeSessionId = fresh.id;
		} else {
			this.activeSessionId = this.sessions[0].id;
		}

		this.llm.onDidChangeSettings(() => void this.pushState());
		this.vectorIndex.onDidUpdateStatus(() => void this.pushState());
		this.worktreeManager.onDidChange(() => void this.pushState());
	}

	public resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
		};
		webviewView.webview.html = this.buildHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage(msg => {
			void this.handleMessage(msg);
		});

		webviewView.onDidDispose(() => {
			if (this.view === webviewView) {
				this.view = undefined;
			}
		});
	}

	public async focus(mode?: ChatMode): Promise<void> {
		await vscode.commands.executeCommand('aether.chatView.focus');
		if (mode) {
			const session = this.getActiveSession();
			session.mode = mode;
			await this.saveSessions();
			await this.pushState();
		}
		this.post({ type: 'focusInput' });
	}

	public async openPanelDrawer(drawer: DrawerName): Promise<void> {
		this.pendingViewAction = drawer;
		await vscode.commands.executeCommand('aether.chatView.focus');
		this.post({ type: 'openDrawer', drawer });
	}

	public async startNewChat(mode?: ChatMode): Promise<void> {
		this.stopGeneration();
		const targetMode = mode ?? this.getActiveSession().mode;
		const fresh = createEmptySession(targetMode);
		this.sessions.unshift(fresh);
		if (this.sessions.length > MAX_SESSIONS) {
			this.sessions.length = MAX_SESSIONS;
		}
		this.activeSessionId = fresh.id;
		await this.saveSessions();
		await this.pushState();
		this.post({ type: 'focusInput' });
	}

	public async addActiveSelectionToChat(autoPrompt?: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		let chip: ContextChip | undefined;

		if (editor) {
			const root = this.workspaceIndex.getWorkspaceRoot();
			const rel = root
				? path.relative(root, editor.document.fileName).replace(/\\/g, '/')
				: path.basename(editor.document.fileName);
			const sel = editor.selection;
			if (!sel.isEmpty) {
				const startLine = sel.start.line + 1;
				const endLine = sel.end.line + 1;
				chip = {
					id: `sel_${Date.now()}`,
					kind: 'selection',
					label: `${path.basename(rel)}:${startLine}-${endLine}`,
					detail: rel,
					filePath: rel,
					startLine,
					endLine,
					content: editor.document.getText(sel),
				};
			} else {
				chip = {
					id: `file_${Date.now()}`,
					kind: 'file',
					label: path.basename(rel),
					detail: rel,
					filePath: rel,
				};
			}
		}

		await this.focus();
		if (chip) {
			this.post({ type: 'attachChip', chip });
		}
		if (autoPrompt) {
			this.post({ type: 'prefillPrompt', text: autoPrompt, autoSend: true });
		}
	}

	public async fixActiveFileProblems(): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		const root = this.workspaceIndex.getWorkspaceRoot();
		const rel = editor && root
			? path.relative(root, editor.document.fileName).replace(/\\/g, '/')
			: editor ? path.basename(editor.document.fileName) : undefined;

		const diags = this.workspaceIndex.collectDiagnostics(rel);
		await this.focus('agent');
		const chip: ContextChip = {
			id: `prob_${Date.now()}`,
			kind: 'problems',
			label: rel ? `Problems (${path.basename(rel)})` : 'Workspace Problems',
			detail: rel,
			content: diags,
		};
		this.post({ type: 'attachChip', chip });
		this.post({
			type: 'prefillPrompt',
			text: rel
				? `Fix all diagnostics/problems in ${rel} without breaking existing behavior.`
				: 'Fix the reported diagnostics/problems in the workspace.',
			autoSend: true,
		});
	}

	public async reviewGitDiff(): Promise<void> {
		const gitCtx = await this.gitSuite.collectGitContext();
		await this.focus('ask');
		const chip: ContextChip = {
			id: `git_${Date.now()}`,
			kind: 'git',
			label: 'git diff',
			detail: 'Current branch status & diff',
			content: gitCtx,
		};
		this.post({ type: 'attachChip', chip });
		this.post({
			type: 'prefillPrompt',
			text: 'Perform a thorough AI code review of these Git changes. Identify bugs, security vulnerabilities, race conditions, missing edge cases, and concrete fixes.',
			autoSend: true,
		});
	}

	private getActiveSession(): ChatSession {
		let found = this.sessions.find(s => s.id === this.activeSessionId);
		if (!found) {
			found = createEmptySession('agent');
			this.sessions.unshift(found);
			this.activeSessionId = found.id;
		}
		return found;
	}

	private async saveSessions(): Promise<void> {
		await this.context.workspaceState.update(SESSIONS_KEY, this.sessions.slice(0, MAX_SESSIONS));
	}

	private post(message: unknown): void {
		void this.view?.webview.postMessage(message);
	}

	private estimateSessionTokens(session: ChatSession): number {
		let chars = (session.compactedSummary ?? '').length;
		for (const t of session.turns) {
			chars += (t.content ?? '').length + (t.thinking ?? '').length;
			for (const c of t.toolCards ?? []) {
				chars += (c.output ?? '').length;
			}
		}
		return Math.round(chars / 3.8);
	}

	private collectPendingEdits(session: ChatSession): FileEditRecord[] {
		const latestByPath = new Map<string, FileEditRecord>();
		for (const t of session.turns) {
			for (const c of t.toolCards ?? []) {
				if (c.editRecord && !c.editRecord.reverted && !c.editRecord.accepted) {
					latestByPath.set(c.editRecord.relativePath, c.editRecord);
				}
			}
		}
		return [...latestByPath.values()];
	}

	private async pushState(): Promise<void> {
		const settings = await this.llm.getSettings();
		const activeSession = this.getActiveSession();
		const activeEditor = vscode.window.activeTextEditor;
		const root = this.workspaceIndex.getWorkspaceRoot();
		const activeFile = activeEditor
			? (root ? path.relative(root, activeEditor.document.fileName).replace(/\\/g, '/') : path.basename(activeEditor.document.fileName))
			: undefined;

		this.post({
			type: 'state',
			settings,
			presets: PROVIDER_PRESETS,
			discoveredModels: this.discoveredModels,
			session: activeSession,
			sessions: this.sessions.map(s => ({
				id: s.id,
				title: s.title,
				updatedAt: s.updatedAt,
				turnCount: s.turns.length,
				mode: s.mode,
			})),
			activeFile,
			isStreaming: Boolean(this.activeAbort),
			tokenEstimate: this.estimateSessionTokens(activeSession),
			pendingEdits: this.collectPendingEdits(activeSession),
			notepads: this.rulesService.getNotepads(),
			mcpServers: this.mcpClient.getStatuses(),
			vectorStatus: this.vectorIndex.getStatus(),
			worktreeTasks: this.worktreeManager.getTasks(),
		});
	}

	private stopGeneration(): void {
		if (this.activeAbort) {
			this.activeAbort.abort();
			this.activeAbort = undefined;
		}
		for (const [, waiter] of this.pendingApprovals) {
			waiter.resolve(false);
		}
		this.pendingApprovals.clear();
		this.post({ type: 'streaming', value: false });
	}

	private async handleMessage(msg: Record<string, unknown>): Promise<void> {
		const type = String(msg.type ?? '');
		switch (type) {
			case 'ready': {
				await this.pushState();
				const settings = await this.llm.getSettings();
				if (settings.provider === 'ollama' || settings.provider === 'lmstudio') {
					void this.refreshModels(settings.provider, true);
				}
				if (this.pendingViewAction) {
					const drawer = this.pendingViewAction;
					this.pendingViewAction = undefined;
					this.post({ type: 'openDrawer', drawer });
				}
				break;
			}
			case 'sendPrompt': {
				const text = String(msg.text ?? '').trim();
				const mode = (msg.mode as ChatMode) || this.getActiveSession().mode;
				const chips = Array.isArray(msg.chips) ? (msg.chips as ContextChip[]) : [];
				const images = Array.isArray(msg.images) ? (msg.images as ImageAttachment[]) : [];
				if (text || images.length > 0) {
					await this.handleUserSubmission(text, mode, chips, images);
				}
				break;
			}
			case 'stop': {
				this.stopGeneration();
				break;
			}
			case 'setMode': {
				const session = this.getActiveSession();
				session.mode = (msg.mode as ChatMode) || 'agent';
				await this.saveSessions();
				await this.pushState();
				break;
			}
			case 'newChat': {
				await this.startNewChat();
				break;
			}
			case 'selectSession': {
				const id = String(msg.sessionId ?? '');
				if (this.sessions.some(s => s.id === id)) {
					this.stopGeneration();
					this.activeSessionId = id;
					await this.pushState();
				}
				break;
			}
			case 'deleteSession': {
				const id = String(msg.sessionId ?? '');
				this.sessions = this.sessions.filter(s => s.id !== id);
				if (this.sessions.length === 0) {
					this.sessions.push(createEmptySession('agent'));
				}
				if (this.activeSessionId === id) {
					this.activeSessionId = this.sessions[0].id;
				}
				await this.saveSessions();
				await this.pushState();
				break;
			}
			case 'updateSettings': {
				const payload = (msg.settings ?? {}) as Partial<AetherSettings> & { apiKey?: string };
				await this.llm.updateSettings(payload);
				await this.pushState();
				break;
			}
			case 'testProvider': {
				const provider = (msg.provider as ProviderId) || (await this.llm.getSettings()).provider;
				await this.refreshModels(provider, false);
				break;
			}
			case 'queryMentions': {
				const query = String(msg.query ?? '').toLowerCase();
				const [files, folders] = await Promise.all([
					this.workspaceIndex.listWorkspaceFiles(250),
					this.workspaceIndex.listWorkspaceFolders(60),
				]);
				const filteredFiles = files
					.filter(f => !query || f.toLowerCase().includes(query))
					.slice(0, 10)
					.map(f => ({ kind: 'file', label: path.basename(f), detail: f, filePath: f }));
				const filteredFolders = folders
					.filter(f => !query || f.toLowerCase().includes(query))
					.slice(0, 5)
					.map(f => ({ kind: 'folder', label: path.basename(f), detail: f, filePath: f }));
				const notepadItems = this.rulesService.getNotepads()
					.filter(n => !query || n.title.toLowerCase().includes(query))
					.slice(0, 5)
					.map(n => ({ kind: 'notepad', label: `notepad:${n.title}`, detail: n.content.slice(0, 60), notepadId: n.id }));

				const specials = [
					{ kind: 'codebase', label: 'codebase', detail: 'Semantic vector + lexical workspace search' },
					{ kind: 'problems', label: 'problems', detail: 'Active VS Code diagnostics & compiler errors' },
					{ kind: 'git', label: 'git', detail: 'Current branch, git status, commits & diff' },
					{ kind: 'terminal', label: 'terminal', detail: 'Recent terminal & command outputs' },
					{ kind: 'symbols', label: 'symbols', detail: 'Search LSP workspace classes & functions' },
					{ kind: 'web', label: 'web', detail: 'Live web search for latest docs & answers' },
					{ kind: 'docs', label: 'docs', detail: 'Fetch & attach a documentation URL' },
				].filter(s => !query || s.label.includes(query));

				this.post({
					type: 'mentionResults',
					items: [...specials, ...notepadItems, ...filteredFiles, ...filteredFolders],
				});
				break;
			}
			case 'querySlashCommands': {
				const query = String(msg.query ?? '').toLowerCase();
				const all = await this.rulesService.listSlashCommands(this.workspaceIndex.getWorkspaceRoot());
				const filtered = all.filter(c => !query || c.name.toLowerCase().includes(query));
				this.post({ type: 'slashResults', items: filtered });
				break;
			}
			case 'promptDocUrl': {
				const url = await vscode.window.showInputBox({
					title: 'Attach Documentation URL (@docs)',
					prompt: 'Enter a documentation page URL to fetch and cache',
					placeHolder: 'https://docs.example.com/api',
				});
				if (url && url.trim()) {
					this.post({
						type: 'attachChip',
						chip: {
							id: `docs_${Date.now()}`,
							kind: 'docs',
							label: `docs:${url.replace(/^https?:\/\//, '').slice(0, 28)}`,
							detail: url.trim(),
							url: url.trim(),
						},
					});
				}
				break;
			}
			case 'openDiff': {
				await this.toolExecutor.openEditDiff(String(msg.editId ?? ''));
				break;
			}
			case 'revertEdit': {
				const editId = String(msg.editId ?? '');
				const ok = await this.toolExecutor.revertEdit(editId);
				if (ok) {
					this.markEditReverted(editId);
					await this.saveSessions();
					await this.pushState();
					vscode.window.showInformationMessage('Reverted file edit.');
				}
				break;
			}
			case 'restoreCheckpoint': {
				const checkpointId = String(msg.checkpointId ?? '');
				const revertedCount = await this.toolExecutor.restoreCheckpoint(checkpointId);
				if (revertedCount > 0) {
					this.markCheckpointReverted(checkpointId);
					await this.saveSessions();
					await this.pushState();
					vscode.window.showInformationMessage(`Restored checkpoint (${revertedCount} file edit${revertedCount === 1 ? '' : 's'} reverted).`);
				}
				break;
			}
			case 'reviewKeepAll': {
				const session = this.getActiveSession();
				for (const t of session.turns) {
					for (const c of t.toolCards ?? []) {
						if (c.editRecord && !c.editRecord.reverted) {
							c.editRecord.accepted = true;
						}
					}
				}
				await this.saveSessions();
				await this.pushState();
				break;
			}
			case 'reviewUndoAll': {
				const session = this.getActiveSession();
				const pending = this.collectPendingEdits(session);
				for (const rec of pending.reverse()) {
					await this.toolExecutor.revertEdit(rec.id);
					this.markEditReverted(rec.id);
				}
				await this.saveSessions();
				await this.pushState();
				vscode.window.showInformationMessage(`Reverted ${pending.length} file edit(s).`);
				break;
			}
			case 'reviewNextFile': {
				const pending = this.collectPendingEdits(this.getActiveSession());
				if (pending.length > 0) {
					const target = pending[this.reviewIndex % pending.length];
					this.reviewIndex++;
					await this.toolExecutor.openEditDiff(target.id);
				}
				break;
			}
			case 'approvalDecision': {
				const toolCallId = String(msg.toolCallId ?? '');
				const approved = Boolean(msg.approved);
				const waiter = this.pendingApprovals.get(toolCallId);
				if (waiter) {
					this.pendingApprovals.delete(toolCallId);
					waiter.resolve(approved);
				}
				break;
			}
			case 'moveToTerminal': {
				const cmd = String(msg.command ?? '');
				if (cmd) {
					this.toolExecutor.moveCommandToTerminal(cmd);
				}
				break;
			}
			case 'applyCodeBlock': {
				await this.applyCodeToActiveEditor(String(msg.code ?? ''));
				break;
			}
			case 'approveArtifactPlan': {
				const artifactId = String(msg.artifactId ?? '');
				const session = this.getActiveSession();
				const turn = session.turns.find(t => t.artifact?.id === artifactId);
				if (turn?.artifact) {
					turn.artifact.approved = true;
					await this.saveSessions();
					await this.runConversationTurn(
						`Execute the approved implementation plan step-by-step now:\n\n${turn.artifact.markdown}`,
						'agent',
						[],
						[]
					);
				}
				break;
			}
			case 'openArtifactMarkdown': {
				const md = String(msg.markdown ?? '');
				const doc = await vscode.workspace.openTextDocument({ content: md, language: 'markdown' });
				await vscode.window.showTextDocument(doc);
				break;
			}
			case 'compactChat': {
				await this.compactActiveSession();
				break;
			}
			case 'rebuildIndex': {
				await this.vectorIndex.rebuildIndex();
				await this.pushState();
				break;
			}
			case 'reloadMcp': {
				await this.mcpClient.reload(this.workspaceIndex.getWorkspaceRoot());
				await this.pushState();
				break;
			}
			case 'editMcpConfig': {
				await this.mcpClient.openOrCreateConfig(this.workspaceIndex.getWorkspaceRoot());
				break;
			}
			case 'saveNotepad': {
				await this.rulesService.saveNotepad({
					id: typeof msg.id === 'string' && msg.id ? msg.id : undefined,
					title: String(msg.title ?? 'Untitled Note'),
					content: String(msg.content ?? ''),
				});
				await this.pushState();
				break;
			}
			case 'deleteNotepad': {
				await this.rulesService.deleteNotepad(String(msg.id ?? ''));
				await this.pushState();
				break;
			}
			case 'spawnWorktree': {
				const taskPrompt = String(msg.prompt ?? '').trim();
				if (taskPrompt) {
					try {
						await this.worktreeManager.spawnTask(taskPrompt);
						await this.pushState();
					} catch (err) {
						vscode.window.showErrorMessage(`Could not start parallel worktree agent: ${err instanceof Error ? err.message : String(err)}`);
					}
				}
				break;
			}
			case 'openWorktree': {
				await this.worktreeManager.openWorktree(String(msg.taskId ?? ''));
				break;
			}
			case 'mergeWorktree': {
				try {
					await this.worktreeManager.mergeTask(String(msg.taskId ?? ''));
					await this.pushState();
				} catch (err) {
					vscode.window.showErrorMessage(`Merge failed: ${err instanceof Error ? err.message : String(err)}`);
				}
				break;
			}
			case 'discardWorktree': {
				await this.worktreeManager.discardTask(String(msg.taskId ?? ''));
				await this.pushState();
				break;
			}
		}
	}

	private async handleUserSubmission(text: string, mode: ChatMode, chips: ContextChip[], images: ImageAttachment[]): Promise<void> {
		// Handle built-in & custom slash commands
		const slashMatch = /^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text);
		if (slashMatch) {
			const cmd = slashMatch[1].toLowerCase();
			const rest = (slashMatch[2] ?? '').trim();
			if (cmd === 'compact') {
				await this.compactActiveSession();
				return;
			}
			if (cmd === 'index') {
				const status = await this.vectorIndex.rebuildIndex();
				vscode.window.showInformationMessage(`Aether Index rebuilt: ${status.indexedFiles} files, ${status.indexedChunks} chunks.`);
				return;
			}
			if (cmd === 'review') {
				await this.reviewGitDiff();
				return;
			}
			if (cmd === 'fix') {
				await this.fixActiveFileProblems();
				return;
			}
			if (cmd === 'plan') {
				await this.runConversationTurn(rest || 'Create an implementation plan for the current task.', 'plan', chips, images);
				return;
			}
			if (cmd === 'test') {
				await this.runConversationTurn(
					rest || 'Generate comprehensive unit tests for the active file and run them to verify everything passes.',
					'agent',
					chips,
					images
				);
				return;
			}
			if (cmd === 'worktree') {
				if (!rest) {
					await this.openPanelDrawer('agents');
					return;
				}
				await this.worktreeManager.spawnTask(rest);
				await this.openPanelDrawer('agents');
				return;
			}

			// Custom .aether/commands/<name>.md
			const allCmds = await this.rulesService.listSlashCommands(this.workspaceIndex.getWorkspaceRoot());
			const custom = allCmds.find(c => !c.builtin && c.name.toLowerCase() === cmd);
			if (custom?.template) {
				const expanded = rest ? `${custom.template}\n\nAdditional Input:\n${rest}` : custom.template;
				await this.runConversationTurn(expanded, mode, chips, images);
				return;
			}
		}

		await this.runConversationTurn(text, mode, chips, images);
	}

	private async compactActiveSession(): Promise<void> {
		const session = this.getActiveSession();
		if (session.turns.length < 2) {
			vscode.window.showInformationMessage('Conversation is already compact.');
			return;
		}
		const transcript = session.turns
			.map(t => `${t.role.toUpperCase()}: ${t.content.slice(0, 1200)}`)
			.join('\n\n')
			.slice(0, 18_000);

		try {
			const res = await this.llm.streamChat({
				temperature: 0.1,
				maxTokens: 700,
				messages: [
					{
						role: 'system',
						content: 'Summarize this coding conversation into a dense technical handoff (goals, files edited, decisions, open items). Keep it concise.',
					},
					{ role: 'user', content: transcript },
				],
			});
			session.compactedSummary = res.text.trim();
			session.turns = session.turns.slice(-2);
			await this.saveSessions();
			await this.pushState();
			vscode.window.showInformationMessage('Compacted conversation history to free up context tokens.');
		} catch (err) {
			vscode.window.showErrorMessage(`Compact failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	private async refreshModels(provider: ProviderId, silent: boolean): Promise<void> {
		const result = await this.llm.testConnection(provider);
		if (result.ok) {
			this.discoveredModels[provider] = result.models;
			const settings = await this.llm.getSettings();
			const hasModel = (id: string) => result.models.some(m => m.id === id);
			if (provider === 'lmstudio' && result.models.length > 0 && (!settings.lmstudioModel || !hasModel(settings.lmstudioModel))) {
				await this.llm.updateSettings({ lmstudioModel: result.models[0].id });
			} else if (provider === 'ollama' && result.models.length > 0 && (!settings.ollamaModel || !hasModel(settings.ollamaModel))) {
				const preferred = result.models.find(m => !/:cloud$/i.test(m.id)) ?? result.models[0];
				await this.llm.updateSettings({ ollamaModel: preferred.id });
			}
		}
		this.post({
			type: 'providerTestResult',
			provider,
			ok: result.ok,
			message: result.message,
			models: result.models,
			silent,
		});
		await this.pushState();
	}

	private async runConversationTurn(
		userText: string,
		mode: ChatMode,
		chips: ContextChip[],
		images: ImageAttachment[]
	): Promise<void> {
		if (this.activeAbort) {
			this.stopGeneration();
		}

		const session = this.getActiveSession();
		session.mode = mode;
		session.updatedAt = Date.now();
		if (session.turns.length === 0) {
			session.title = (userText || 'Image prompt').slice(0, 48) + (userText.length > 48 ? '...' : '');
		}

		const checkpointId = `cp_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
		this.toolExecutor.registerCheckpoint(checkpointId);

		const userTurn: UITurn = {
			id: `u_${Date.now()}`,
			role: 'user',
			content: userText,
			timestamp: Date.now(),
			mode,
			contextChips: chips,
			images: images.length > 0 ? images : undefined,
			checkpointId,
		};
		session.turns.push(userTurn);

		const settings = await this.llm.getSettings();
		const activeModel = this.llm.getActiveModelName(settings);

		const assistantTurn: UITurn = {
			id: `a_${Date.now() + 1}`,
			role: 'assistant',
			content: '',
			thinking: '',
			timestamp: Date.now(),
			mode,
			model: activeModel,
			toolCards: [],
		};
		session.turns.push(assistantTurn);
		await this.saveSessions();

		const abort = new AbortController();
		this.activeAbort = abort;
		await this.pushState();

		try {
			const referencedFiles = chips.map(c => c.filePath).filter((f): f is string => Boolean(f));
			const activeEditor = vscode.window.activeTextEditor;
			const root = this.workspaceIndex.getWorkspaceRoot();
			if (activeEditor) {
				referencedFiles.push(
					root ? path.relative(root, activeEditor.document.fileName).replace(/\\/g, '/') : path.basename(activeEditor.document.fileName)
				);
			}

			const systemPrompt = await this.buildSystemPrompt(mode, settings, referencedFiles, session.compactedSummary);
			const contextBlock = await this.buildContextBlock(userText, chips);

			const apiMessages: ChatMessageParam[] = [
				{ role: 'system', content: systemPrompt },
			];

			const priorTurns = session.turns.slice(0, -2).slice(-14);
			for (const t of priorTurns) {
				apiMessages.push({
					role: t.role,
					content: t.content || '(empty)',
				});
			}

			const fullUserText = contextBlock
				? `${contextBlock}\n\n---\nUser Request:\n${userText}`
				: userText;

			if (images.length > 0) {
				const parts: MessageContentPart[] = [
					{ type: 'text', text: fullUserText || 'Inspect the attached image(s).' },
					...images.map(img => ({
						type: 'image_url' as const,
						image_url: { url: img.dataUrl },
					})),
				];
				apiMessages.push({ role: 'user', content: parts });
			} else {
				apiMessages.push({ role: 'user', content: fullUserText });
			}

			const maxSteps = mode === 'agent' ? settings.agentMaxSteps : 1;
			const tools = mode === 'agent' ? this.toolExecutor.getAllToolSchemas() : undefined;

			for (let step = 0; step < maxSteps; step++) {
				if (abort.signal.aborted) {
					break;
				}

				const result = await this.llm.streamChat({
					messages: apiMessages,
					tools,
					signal: abort.signal,
					onDelta: delta => {
						if (delta.text) {
							assistantTurn.content += delta.text;
						}
						if (delta.thinking) {
							assistantTurn.thinking = (assistantTurn.thinking ?? '') + delta.thinking;
						}
						this.post({ type: 'turnUpdate', turn: assistantTurn });
					},
				});

				assistantTurn.model = result.model;

				if (!tools || result.toolCalls.length === 0) {
					break;
				}

				apiMessages.push({
					role: 'assistant',
					content: result.text || null,
					tool_calls: result.toolCalls.map(tc => ({
						id: tc.id,
						type: 'function',
						function: { name: tc.name, arguments: tc.arguments },
					})),
				});

				if (assistantTurn.content && !assistantTurn.content.endsWith('\n')) {
					assistantTurn.content += '\n\n';
				}

				for (const tc of result.toolCalls) {
					if (abort.signal.aborted) {
						break;
					}
					let parsedArgs: Record<string, unknown> = {};
					try {
						parsedArgs = tc.arguments ? JSON.parse(tc.arguments) : {};
					} catch {
						parsedArgs = {};
					}

					const desc = this.toolExecutor.describeToolCall(tc.name, parsedArgs);
					const card: ToolExecutionCard = {
						id: tc.id,
						toolName: tc.name,
						summary: desc.summary,
						argsPreview: desc.argsPreview,
						command: desc.command,
						status: 'pending',
					};
					assistantTurn.toolCards = assistantTurn.toolCards ?? [];
					assistantTurn.toolCards.push(card);
					this.post({ type: 'turnUpdate', turn: assistantTurn });

					// Evaluate command allowlist/denylist or write permissions
					let needsApproval = false;
					if (tc.name === 'run_terminal_command') {
						const evalRes = this.ignoreService.evaluateCommand(String(parsedArgs.command ?? ''), settings);
						if (evalRes.decision === 'deny') {
							card.status = 'denied';
							card.output = `Blocked by command policy: ${evalRes.reason}`;
							this.post({ type: 'turnUpdate', turn: assistantTurn });
							apiMessages.push({
								role: 'tool',
								tool_call_id: tc.id,
								name: tc.name,
								content: card.output,
							});
							continue;
						}
						needsApproval = evalRes.decision === 'ask';
					} else if ((tc.name === 'write_file' || tc.name === 'edit_file') && !settings.autoApproveWrites) {
						needsApproval = true;
					}

					if (needsApproval) {
						const approved = await this.waitForApproval(tc.id, abort.signal);
						if (!approved) {
							card.status = 'denied';
							card.output = 'User denied this action.';
							this.post({ type: 'turnUpdate', turn: assistantTurn });
							apiMessages.push({
								role: 'tool',
								tool_call_id: tc.id,
								name: tc.name,
								content: 'Action was denied by the user. Do not retry the exact same denied action; ask or adapt.',
							});
							continue;
						}
					}

					card.status = 'running';
					this.post({ type: 'turnUpdate', turn: assistantTurn });

					const toolResult = await this.toolExecutor.execute(
						tc.name,
						parsedArgs,
						checkpointId,
						abort.signal,
						liveOut => {
							card.output = liveOut;
							this.post({ type: 'turnUpdate', turn: assistantTurn });
						}
					);

					card.status = toolResult.isError ? 'error' : 'done';
					card.output = toolResult.output.slice(0, 4000);
					card.editRecord = toolResult.editRecord;
					card.screenshotDataUrl = toolResult.screenshotDataUrl;
					this.post({ type: 'turnUpdate', turn: assistantTurn });

					apiMessages.push({
						role: 'tool',
						tool_call_id: tc.id,
						name: tc.name,
						content: toolResult.output.slice(0, 14_000),
					});
				}
			}

			// In Plan mode, attach an Antigravity-style interactive Implementation Plan Artifact Card
			if (mode === 'plan' && assistantTurn.content.trim()) {
				const artifact: ArtifactCard = {
					id: `art_${Date.now()}`,
					kind: 'plan',
					title: 'Implementation Plan',
					markdown: assistantTurn.content.trim(),
					approved: false,
				};
				assistantTurn.artifact = artifact;
			}
		} catch (err) {
			if (!abort.signal.aborted) {
				assistantTurn.error = err instanceof Error ? err.message : String(err);
			}
		} finally {
			if (this.activeAbort === abort) {
				this.activeAbort = undefined;
			}
			session.updatedAt = Date.now();
			await this.saveSessions();
			await this.pushState();
		}
	}

	private waitForApproval(toolCallId: string, signal: AbortSignal): Promise<boolean> {
		return new Promise<boolean>(resolve => {
			if (signal.aborted) {
				resolve(false);
				return;
			}
			const onAbort = () => {
				this.pendingApprovals.delete(toolCallId);
				resolve(false);
			};
			signal.addEventListener('abort', onAbort, { once: true });
			this.pendingApprovals.set(toolCallId, {
				resolve: (approved: boolean) => {
					signal.removeEventListener('abort', onAbort);
					resolve(approved);
				},
			});
		});
	}

	private async buildSystemPrompt(
		mode: ChatMode,
		settings: AetherSettings,
		activeFiles: string[],
		compactedSummary?: string
	): Promise<string> {
		const root = this.workspaceIndex.getWorkspaceRoot();
		const rules = await this.rulesService.loadScopedRules(root, activeFiles);

		const modeGuidance = mode === 'agent'
			? 'You are Caudate AI Agent inside Caudate IDE (a Cursor & Antigravity-style VS Code fork). You can autonomously read/edit/create files, search code, inspect VS Code diagnostics, run terminal commands, verify live web apps with built-in browser tools (browser_navigate/click/type/screenshot), and invoke connected MCP server tools. Always inspect diagnostics or run tests after significant changes.'
			: mode === 'plan'
				? 'You are Caudate AI in Plan Mode. Produce a clear, structured Implementation Plan in Markdown with sections: ## Goal, ## Proposed Changes (grouped by file path), ## Task Checklist (- [ ] items), and ## Verification Plan. Be concrete and actionable.'
				: 'You are Caudate AI in Ask Mode. Answer questions concisely and accurately using the provided codebase context.';

		const parts = [
			modeGuidance,
			`Operating system: ${process.platform}.`,
			root ? `Workspace root: ${root}` : 'No workspace folder is currently open.',
		];
		if (compactedSummary) {
			parts.push(`### Compacted Earlier Conversation Summary\n${compactedSummary}`);
		}
		if (rules) {
			parts.push(rules);
		}
		if (settings.systemPrompt.trim()) {
			parts.push(`### User Custom Instructions\n${settings.systemPrompt.trim()}`);
		}
		return parts.join('\n\n');
	}

	private async buildContextBlock(userText: string, chips: ContextChip[]): Promise<string> {
		const sections: string[] = [];
		const activeEditor = vscode.window.activeTextEditor;
		const root = this.workspaceIndex.getWorkspaceRoot();
		if (activeEditor) {
			const rel = root
				? path.relative(root, activeEditor.document.fileName).replace(/\\/g, '/')
				: path.basename(activeEditor.document.fileName);
			sections.push(`Active editor: ${rel} (cursor line ${activeEditor.selection.active.line + 1}, language: ${activeEditor.document.languageId})`);
		}

		for (const chip of chips) {
			if (chip.kind === 'selection' && chip.content) {
				sections.push(`### Selection (${chip.filePath ?? chip.label}:${chip.startLine ?? 1}-${chip.endLine ?? 1})\n\`\`\`\n${chip.content.slice(0, 12_000)}\n\`\`\``);
			} else if (chip.kind === 'file' && chip.filePath) {
				try {
					const { absolutePath, relativePath } = this.workspaceIndex.resolvePath(chip.filePath);
					const respect = vscode.workspace.getConfiguration('aether').get<boolean>('privacy.respectIgnoreFiles', true);
					this.ignoreService.assertAllowedPath(relativePath, root, respect);
					const text = await fs.promises.readFile(absolutePath, 'utf8');
					sections.push(`### File: ${chip.filePath}\n\`\`\`\n${text.slice(0, 16_000)}\n\`\`\``);
				} catch (err) {
					sections.push(`### File: ${chip.filePath} (skipped: ${err instanceof Error ? err.message : String(err)})`);
				}
			} else if (chip.kind === 'folder' && chip.filePath) {
				try {
					sections.push(`### ${await this.workspaceIndex.buildFolderSummary(chip.filePath)}`);
				} catch {
					// Skip
				}
			} else if (chip.kind === 'problems') {
				sections.push(`### VS Code Diagnostics\n${chip.content ?? this.workspaceIndex.collectDiagnostics()}`);
			} else if (chip.kind === 'codebase') {
				const hits = await this.vectorIndex.search(userText, 8);
				if (hits.length > 0) {
					const modeTag = hits[0].usedEmbeddings ? 'Semantic Vector' : 'Hybrid Lexical';
					const formatted = hits.map(h => `File: ${h.relativePath}:${h.startLine}-${h.endLine}\n${h.snippet}`).join('\n\n');
					sections.push(`### @codebase Matches (${modeTag})\n${formatted}`);
				}
			} else if (chip.kind === 'git') {
				sections.push(`### @git Context\n${chip.content ?? await this.gitSuite.collectGitContext()}`);
			} else if (chip.kind === 'terminal') {
				sections.push(`### @terminal Context\n${this.workspaceIndex.collectTerminalContext()}`);
			} else if (chip.kind === 'symbols') {
				sections.push(`### @symbols Workspace Symbols\n${await this.workspaceIndex.collectWorkspaceSymbols(userText)}`);
			} else if (chip.kind === 'web') {
				sections.push(`### @web Search Results\n${await this.workspaceIndex.searchWeb(userText)}`);
			} else if (chip.kind === 'docs' && chip.url) {
				try {
					sections.push(`### @docs (${chip.url})\n${await this.workspaceIndex.fetchAndCacheDoc(chip.url)}`);
				} catch (err) {
					sections.push(`### @docs error: ${err instanceof Error ? err.message : String(err)}`);
				}
			} else if (chip.kind === 'notepad' && chip.notepadId) {
				const np = this.rulesService.getNotepads().find(n => n.id === chip.notepadId);
				if (np) {
					sections.push(`### Notepad: ${np.title}\n${np.content}`);
				}
			}
		}

		return sections.join('\n\n');
	}

	private async applyCodeToActiveEditor(code: string): Promise<void> {
		const editor = vscode.window.activeTextEditor;
		if (!editor) {
			const doc = await vscode.workspace.openTextDocument({ content: code });
			await vscode.window.showTextDocument(doc);
			return;
		}
		await editor.edit(builder => {
			if (!editor.selection.isEmpty) {
				builder.replace(editor.selection, code);
			} else {
				builder.insert(editor.selection.active, code);
			}
		});
		vscode.window.showInformationMessage('Applied code snippet to active editor.');
	}

	private markEditReverted(editId: string): void {
		for (const session of this.sessions) {
			for (const turn of session.turns) {
				for (const card of turn.toolCards ?? []) {
					if (card.editRecord?.id === editId) {
						card.editRecord.reverted = true;
					}
				}
			}
		}
	}

	private markCheckpointReverted(checkpointId: string): void {
		const session = this.getActiveSession();
		const userIdx = session.turns.findIndex(t => t.checkpointId === checkpointId);
		if (userIdx !== -1 && session.turns[userIdx + 1]) {
			for (const card of session.turns[userIdx + 1].toolCards ?? []) {
				if (card.editRecord) {
					card.editRecord.reverted = true;
				}
			}
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const nonce = crypto.randomBytes(16).toString('base64');
		const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.css'));
		const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', 'chat.js'));

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1.0" />
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:;" />
	<link rel="stylesheet" href="${cssUri}" />
	<title>Caudate AI</title>
</head>
<body>
	<div id="app" class="aether-app">
		<header class="aether-header">
			<div class="mode-tabs" role="tablist">
				<button class="mode-tab active" data-mode="agent" title="Autonomous multi-file agent with tools, browser & MCP">Agent</button>
				<button class="mode-tab" data-mode="ask" title="Read-only codebase Q&A">Ask</button>
				<button class="mode-tab" data-mode="plan" title="Generate interactive Implementation Plan artifacts">Plan</button>
			</div>
			<div class="header-actions">
				<button id="btn-new" class="icon-btn" title="New Chat">+</button>
				<button id="btn-agents" class="icon-btn" title="Parallel Git Worktree Agents">⎇</button>
				<button id="btn-notepads" class="icon-btn" title="Notepads">📝</button>
				<button id="btn-history" class="icon-btn" title="Chat History">◷</button>
				<button id="btn-settings" class="icon-btn" title="Providers, MCP, Index & Security Settings">⚙</button>
			</div>
		</header>

		<!-- Parallel Agents / Git Worktrees Drawer -->
		<div id="drawer-agents" class="drawer hidden">
			<div class="drawer-header">
				<span>Parallel Worktree Agents</span>
				<button class="icon-btn drawer-close" data-close="drawer-agents">✕</button>
			</div>
			<div class="drawer-body settings-body">
				<div class="field-group">
					<label for="wt-prompt">Launch Isolated Background Agent (Git Worktree)</label>
					<textarea id="wt-prompt" rows="2" placeholder="Describe a task to run in a separate branch & git worktree..."></textarea>
					<button id="btn-spawn-wt" class="btn-primary">▶ Spawn Worktree Agent</button>
				</div>
				<hr class="divider" />
				<div id="wt-list" class="wt-list"></div>
			</div>
		</div>

		<!-- Notepads Drawer -->
		<div id="drawer-notepads" class="drawer hidden">
			<div class="drawer-header">
				<span>Notepads (@notepad)</span>
				<button class="icon-btn drawer-close" data-close="drawer-notepads">✕</button>
			</div>
			<div class="drawer-body settings-body">
				<div class="field-group">
					<label for="np-title">New / Edit Notepad</label>
					<input id="np-title" type="text" placeholder="e.g. Architecture Decisions, API Spec..." />
					<textarea id="np-content" rows="4" placeholder="Reusable context notes you can attach with @notepad..."></textarea>
					<button id="btn-save-np" class="btn-primary">Save Notepad</button>
				</div>
				<hr class="divider" />
				<div id="np-list" class="wt-list"></div>
			</div>
		</div>

		<!-- History Drawer -->
		<div id="drawer-history" class="drawer hidden">
			<div class="drawer-header">
				<span>Chat History</span>
				<button class="icon-btn drawer-close" data-close="drawer-history">✕</button>
			</div>
			<div id="history-list" class="drawer-body"></div>
		</div>

		<!-- Settings Drawer -->
		<div id="drawer-settings" class="drawer hidden">
			<div class="drawer-header">
				<span>AI Providers, MCP & Index</span>
				<button class="icon-btn drawer-close" data-close="drawer-settings">✕</button>
			</div>
			<div class="drawer-body settings-body">
				<div class="field-group">
					<label>Quick Preset</label>
					<div id="preset-grid" class="preset-grid"></div>
				</div>

				<div class="field-group">
					<label for="set-provider">Active Provider</label>
					<select id="set-provider">
						<option value="ollama">Ollama (Local)</option>
						<option value="lmstudio">LM Studio (Local)</option>
						<option value="openai-compatible">OpenAI / Compatible API</option>
					</select>
				</div>

				<div id="panel-openai" class="provider-section hidden">
					<div class="field-group">
						<label for="set-openai-url">API Base URL</label>
						<input id="set-openai-url" type="text" placeholder="https://api.openai.com/v1" />
					</div>
					<div class="field-group">
						<label for="set-openai-key">API Key <span id="key-badge" class="badge">Not set</span></label>
						<input id="set-openai-key" type="password" placeholder="sk-... (stored in VS Code SecretStorage)" />
					</div>
					<div class="field-group">
						<label for="set-openai-model">Model</label>
						<input id="set-openai-model" type="text" placeholder="gpt-4o / deepseek-chat / anthropic/claude-sonnet-4" />
					</div>
				</div>

				<div id="panel-ollama" class="provider-section hidden">
					<div class="field-group">
						<label for="set-ollama-url">Ollama Server URL</label>
						<input id="set-ollama-url" type="text" placeholder="http://localhost:11434" />
					</div>
					<div class="field-group">
						<label for="set-ollama-model">Ollama Model</label>
						<input id="set-ollama-model" type="text" list="ollama-models-list" placeholder="qwen2.5-coder:7b" />
						<datalist id="ollama-models-list"></datalist>
					</div>
				</div>

				<div id="panel-lmstudio" class="provider-section hidden">
					<div class="field-group">
						<label for="set-lmstudio-url">LM Studio Server URL</label>
						<input id="set-lmstudio-url" type="text" placeholder="http://localhost:1234/v1" />
					</div>
					<div class="field-group">
						<label for="set-lmstudio-model">LM Studio Model (blank = auto-detect loaded)</label>
						<input id="set-lmstudio-model" type="text" list="lmstudio-models-list" placeholder="Auto-detect loaded model" />
						<datalist id="lmstudio-models-list"></datalist>
					</div>
				</div>

				<div class="settings-row">
					<button id="btn-test-conn" class="btn-secondary">Test & Discover Models</button>
					<span id="conn-status" class="conn-status"></span>
				</div>

				<hr class="divider" />

				<div class="section-title">Tab Autocomplete & Next Edit Prediction (NES)</div>
				<label class="checkbox-row">
					<input id="set-tab-enabled" type="checkbox" />
					<span>Enable AI Tab ghost-text autocomplete</span>
				</label>
				<label class="checkbox-row">
					<input id="set-nes-enabled" type="checkbox" />
					<span>Enable Next Edit Prediction (Cursor Tab multi-line jump)</span>
				</label>
				<div class="field-group">
					<label for="set-tab-provider">Tab Provider</label>
					<select id="set-tab-provider">
						<option value="same">Same as Chat Provider</option>
						<option value="ollama">Ollama (Local FIM)</option>
						<option value="lmstudio">LM Studio (Local)</option>
						<option value="openai-compatible">OpenAI / Compatible</option>
					</select>
				</div>
				<div class="field-group">
					<label for="set-tab-model">Tab Model Override (optional)</label>
					<input id="set-tab-model" type="text" placeholder="e.g. qwen2.5-coder:1.5b" />
				</div>

				<hr class="divider" />

				<div class="section-title">Semantic Codebase Index (@codebase)</div>
				<div class="field-group">
					<label for="set-embed-model">Embedding Model (optional — blank uses hybrid lexical)</label>
					<input id="set-embed-model" type="text" placeholder="e.g. nomic-embed-text (Ollama) or text-embedding-3-small" />
				</div>
				<div class="settings-row">
					<button id="btn-rebuild-index" class="btn-secondary">Rebuild Index</button>
					<span id="index-status" class="conn-status"></span>
				</div>

				<hr class="divider" />

				<div class="section-title">MCP Servers (.caudate/mcp.json)</div>
				<div id="mcp-list" class="mcp-list"></div>
				<div class="settings-row">
					<button id="btn-reload-mcp" class="btn-secondary">Reload MCP</button>
					<button id="btn-edit-mcp" class="btn-secondary">Edit mcp.json</button>
				</div>

				<hr class="divider" />

				<div class="section-title">Agent Security & Privacy</div>
				<label class="checkbox-row">
					<input id="set-auto-writes" type="checkbox" />
					<span>Auto-apply file edits (with Diff & Review Bar)</span>
				</label>
				<label class="checkbox-row">
					<input id="set-auto-terminal" type="checkbox" />
					<span>Auto-run non-destructive terminal commands</span>
				</label>
				<label class="checkbox-row">
					<input id="set-respect-ignore" type="checkbox" />
					<span>Protect secrets (.env, *.key) & .caudateignore</span>
				</label>
				<div class="field-group">
					<label for="set-allowlist">Command Allowlist (comma-separated prefixes)</label>
					<input id="set-allowlist" type="text" placeholder="git status, git diff, npm test, pytest" />
				</div>
				<div class="field-group">
					<label for="set-denylist">Command Denylist (comma-separated patterns)</label>
					<input id="set-denylist" type="text" placeholder="e.g. curl, deploy, dropdb" />
				</div>
				<div class="field-group">
					<label for="set-sys-prompt">Custom System Rules</label>
					<textarea id="set-sys-prompt" rows="2" placeholder=".caudate/rules/*.md, .caudaterules & .cursorrules also loaded automatically"></textarea>
				</div>

				<button id="btn-save-settings" class="btn-primary full-width">Save Settings</button>
			</div>
		</div>

		<main id="messages" class="messages-container"></main>

		<!-- Multi-File Review Bar -->
		<div id="review-bar" class="review-bar hidden">
			<span id="review-summary"></span>
			<div class="review-actions">
				<button id="btn-review-next" class="mini-btn">Review Next</button>
				<button id="btn-review-keep" class="mini-btn approve">Keep All</button>
				<button id="btn-review-undo" class="mini-btn deny">Undo All</button>
			</div>
		</div>

		<footer class="composer">
			<div id="mention-popup" class="mention-popup hidden"></div>
			<div id="images-row" class="images-row"></div>
			<div id="chips-row" class="chips-row"></div>
			<textarea id="prompt-input" rows="2" placeholder="Ask Caudate Agent... Type @ for context, / for commands, Ctrl+V to paste screenshots"></textarea>
			<div class="token-bar">
				<div class="token-meter">
					<div id="token-fill" class="token-fill"></div>
				</div>
				<span id="token-label" class="token-label">0 / 64k</span>
				<button id="btn-compact" class="link-btn" title="Summarize history (/compact)">Compact</button>
			</div>
			<div class="composer-bar">
				<div class="composer-left">
					<button id="btn-add-context" class="pill-btn" title="Attach context (@file, @git, @web, @codebase...)">@</button>
					<button id="btn-slash" class="pill-btn" title="Slash commands (/fix, /test, /review, /plan, /worktree)">/</button>
					<button id="btn-attach-img" class="pill-btn" title="Attach image / screenshot for vision models">🖼</button>
					<input id="img-file-input" type="file" accept="image/*" multiple class="hidden" />
					<select id="model-picker" class="model-picker" title="Switch active model"></select>
				</div>
				<div class="composer-right">
					<button id="btn-stop" class="btn-danger hidden" title="Stop generation">■ Stop</button>
					<button id="btn-send" class="btn-primary" title="Send (Enter)">Send ↵</button>
				</div>
			</div>
		</footer>
	</div>
	<script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
	}
}

function createEmptySession(mode: ChatMode): ChatSession {
	const now = Date.now();
	return {
		id: `sess_${now}_${crypto.randomBytes(3).toString('hex')}`,
		title: 'New Conversation',
		createdAt: now,
		updatedAt: now,
		mode,
		turns: [],
	};
}
