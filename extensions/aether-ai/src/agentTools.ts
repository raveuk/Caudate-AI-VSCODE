/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { BROWSER_TOOL_SCHEMAS, BuiltinBrowserAgent } from './browserAgent';
import { IgnoreAndSecurityService } from './ignoreService';
import { McpClientManager } from './mcpClient';
import { FileEditRecord, OpenAIToolSchema } from './types';
import { WorkspaceIndex } from './workspaceIndex';

export const AGENT_TOOL_SCHEMAS: OpenAIToolSchema[] = [
	{
		type: 'function',
		function: {
			name: 'read_file',
			description: 'Read a file from the workspace with optional line range (1-based inclusive).',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative or absolute path to the file.' },
					start_line: { type: 'number', description: 'Optional 1-based start line.' },
					end_line: { type: 'number', description: 'Optional 1-based end line.' },
				},
				required: ['path'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'write_file',
			description: 'Create a new file or completely overwrite an existing file with new content.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative or absolute path to the file.' },
					content: { type: 'string', description: 'Full text content of the file.' },
				},
				required: ['path', 'content'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'edit_file',
			description: 'Apply a surgical search-and-replace edit to an existing file. target must match existing text verbatim.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Relative or absolute path to the file.' },
					target: { type: 'string', description: 'Exact existing text to replace.' },
					replacement: { type: 'string', description: 'Replacement text.' },
				},
				required: ['path', 'target', 'replacement'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'list_dir',
			description: 'List files and subdirectories inside a workspace directory.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Directory path relative to workspace root (defaults to ".").' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'search_files',
			description: 'Search for text or regex pattern across workspace files.',
			parameters: {
				type: 'object',
				properties: {
					query: { type: 'string', description: 'Search text or regular expression.' },
					path: { type: 'string', description: 'Optional subdirectory to restrict search.' },
					is_regex: { type: 'boolean', description: 'Treat query as regular expression.' },
				},
				required: ['query'],
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'get_diagnostics',
			description: 'Get compiler, linter, and language server errors/warnings from VS Code.',
			parameters: {
				type: 'object',
				properties: {
					path: { type: 'string', description: 'Optional relative file path filter.' },
				},
			},
		},
	},
	{
		type: 'function',
		function: {
			name: 'run_terminal_command',
			description: 'Execute a shell command in the workspace root (or specified cwd) and return stdout, stderr, and exit code.',
			parameters: {
				type: 'object',
				properties: {
					command: { type: 'string', description: 'Shell command to run.' },
					cwd: { type: 'string', description: 'Optional working directory relative to workspace root.' },
				},
				required: ['command'],
			},
		},
	},
];

export interface ToolRunResult {
	output: string;
	isError?: boolean;
	editRecord?: FileEditRecord;
	screenshotDataUrl?: string;
}

export class AetherDiffContentProvider implements vscode.TextDocumentContentProvider {
	private readonly contents = new Map<string, string>();
	private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
	public readonly onDidChange = this._onDidChange.event;

	public set(key: string, content: string): vscode.Uri {
		const uri = vscode.Uri.parse(`aether-diff:${encodeURIComponent(key)}`);
		this.contents.set(uri.toString(), content);
		this._onDidChange.fire(uri);
		return uri;
	}

	public provideTextDocumentContent(uri: vscode.Uri): string {
		return this.contents.get(uri.toString()) ?? '';
	}
}

export class AgentToolExecutor {
	private readonly editRecords = new Map<string, FileEditRecord>();
	private readonly checkpoints = new Map<string, FileEditRecord[]>();

	constructor(
		private readonly workspaceIndex: WorkspaceIndex,
		private readonly diffProvider: AetherDiffContentProvider,
		private readonly ignoreService: IgnoreAndSecurityService,
		private readonly mcpClient: McpClientManager,
		private readonly browserAgent: BuiltinBrowserAgent
	) {}

	public getAllToolSchemas(): OpenAIToolSchema[] {
		return [
			...AGENT_TOOL_SCHEMAS,
			...BROWSER_TOOL_SCHEMAS,
			...this.mcpClient.getToolSchemas(),
		];
	}

	public registerCheckpoint(checkpointId: string): void {
		if (!this.checkpoints.has(checkpointId)) {
			this.checkpoints.set(checkpointId, []);
		}
	}

	public getCheckpointEdits(checkpointId: string): FileEditRecord[] {
		return [...(this.checkpoints.get(checkpointId) ?? [])];
	}

	public getEditRecord(editId: string): FileEditRecord | undefined {
		return this.editRecords.get(editId);
	}

	public acceptAllInCheckpoint(checkpointId: string): void {
		for (const rec of this.checkpoints.get(checkpointId) ?? []) {
			if (!rec.reverted) {
				rec.accepted = true;
			}
		}
	}

	public async openEditDiff(editId: string): Promise<void> {
		const record = this.editRecords.get(editId);
		if (!record) {
			vscode.window.showWarningMessage('Diff record is no longer available in this session.');
			return;
		}
		const beforeUri = this.diffProvider.set(`${record.id}-before/${record.relativePath}`, record.beforeContent);
		const afterUri = fs.existsSync(record.absolutePath)
			? vscode.Uri.file(record.absolutePath)
			: this.diffProvider.set(`${record.id}-after/${record.relativePath}`, record.afterContent);
		await vscode.commands.executeCommand(
			'vscode.diff',
			beforeUri,
			afterUri,
			`${record.relativePath} (Before ↔ Aether Edit)`
		);
	}

	public async revertEdit(editId: string): Promise<boolean> {
		const record = this.editRecords.get(editId);
		if (!record || record.reverted) {
			return false;
		}
		if (record.existedBefore) {
			await fs.promises.mkdir(path.dirname(record.absolutePath), { recursive: true });
			await fs.promises.writeFile(record.absolutePath, record.beforeContent, 'utf8');
		} else {
			await fs.promises.rm(record.absolutePath, { force: true });
		}
		record.reverted = true;
		return true;
	}

	public async restoreCheckpoint(checkpointId: string): Promise<number> {
		const records = this.checkpoints.get(checkpointId);
		if (!records || records.length === 0) {
			return 0;
		}
		let count = 0;
		for (let i = records.length - 1; i >= 0; i--) {
			const ok = await this.revertEdit(records[i].id);
			if (ok) {
				count++;
			}
		}
		return count;
	}

	public moveCommandToTerminal(command: string): void {
		const root = this.workspaceIndex.getWorkspaceRoot();
		const term = vscode.window.activeTerminal ?? vscode.window.createTerminal({ name: 'Aether Agent', cwd: root });
		term.show(true);
		term.sendText(command, true);
	}

	public describeToolCall(name: string, args: Record<string, unknown>): { summary: string; argsPreview: string; command?: string } {
		switch (name) {
			case 'read_file':
				return { summary: `Read ${String(args.path ?? '')}`, argsPreview: JSON.stringify(args) };
			case 'write_file':
				return { summary: `Write ${String(args.path ?? '')}`, argsPreview: String(args.path ?? '') };
			case 'edit_file':
				return { summary: `Edit ${String(args.path ?? '')}`, argsPreview: String(args.path ?? '') };
			case 'list_dir':
				return { summary: `List ${String(args.path ?? '.')}`, argsPreview: String(args.path ?? '.') };
			case 'search_files':
				return { summary: `Search "${String(args.query ?? '')}"`, argsPreview: JSON.stringify(args) };
			case 'get_diagnostics':
				return { summary: args.path ? `Diagnostics: ${String(args.path)}` : 'Workspace Diagnostics', argsPreview: String(args.path ?? 'all') };
			case 'run_terminal_command':
				return { summary: `Run: ${String(args.command ?? '')}`, argsPreview: String(args.command ?? ''), command: String(args.command ?? '') };
			case 'browser_navigate':
				return { summary: `Browser → ${String(args.url ?? '')}`, argsPreview: String(args.url ?? '') };
			case 'browser_click':
				return { summary: `Browser Click ${String(args.selector ?? '')}`, argsPreview: String(args.selector ?? '') };
			case 'browser_type':
				return { summary: `Browser Type ${String(args.selector ?? '')}`, argsPreview: JSON.stringify(args) };
			case 'browser_screenshot':
				return { summary: args.url ? `Screenshot ${String(args.url)}` : 'Browser Screenshot', argsPreview: String(args.url ?? 'active page') };
			case 'browser_evaluate':
				return { summary: 'Browser Evaluate JS', argsPreview: String(args.expression ?? '').slice(0, 120) };
			default:
				if (name.startsWith('mcp__')) {
					const parts = name.split('__');
					return { summary: `MCP [${parts[1] ?? 'server'}] ${parts.slice(2).join('_')}`, argsPreview: JSON.stringify(args) };
				}
				return { summary: name, argsPreview: JSON.stringify(args) };
		}
	}

	public async execute(
		name: string,
		args: Record<string, unknown>,
		checkpointId: string,
		signal?: AbortSignal,
		onLiveOutput?: (chunk: string) => void
	): Promise<ToolRunResult> {
		try {
			if (this.browserAgent.isBrowserTool(name)) {
				const res = await this.browserAgent.execute(name, args, this.workspaceIndex.getWorkspaceRoot());
				return { output: res.output, isError: res.isError, screenshotDataUrl: res.screenshotDataUrl };
			}
			if (this.mcpClient.hasTool(name)) {
				const out = await this.mcpClient.callTool(name, args);
				return { output: out };
			}

			switch (name) {
				case 'read_file':
					return await this.runReadFile(args);
				case 'write_file':
					return await this.runWriteFile(args, checkpointId);
				case 'edit_file':
					return await this.runEditFile(args, checkpointId);
				case 'list_dir':
					return await this.runListDir(args);
				case 'search_files':
					return await this.runSearchFiles(args);
				case 'get_diagnostics':
					return { output: this.workspaceIndex.collectDiagnostics(typeof args.path === 'string' ? args.path : undefined) };
				case 'run_terminal_command':
					return await this.runTerminalCommand(args, signal, onLiveOutput);
				default:
					return { output: `Unknown tool: ${name}`, isError: true };
			}
		} catch (err) {
			return {
				output: `Tool ${name} error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	}

	private assertSafe(relativePath: string): void {
		const respect = vscode.workspace.getConfiguration('aether').get<boolean>('privacy.respectIgnoreFiles', true);
		this.ignoreService.assertAllowedPath(relativePath, this.workspaceIndex.getWorkspaceRoot(), respect);
	}

	private async runReadFile(args: Record<string, unknown>): Promise<ToolRunResult> {
		const filePath = String(args.path ?? '');
		const { absolutePath, relativePath } = this.workspaceIndex.resolvePath(filePath);
		this.assertSafe(relativePath);
		const content = await fs.promises.readFile(absolutePath, 'utf8');
		const lines = content.split(/\r?\n/);
		const start = Math.max(1, Number(args.start_line) || 1);
		const end = Math.min(lines.length, Number(args.end_line) || Math.min(lines.length, start + 299));
		const numbered = lines
			.slice(start - 1, end)
			.map((line, i) => `${start + i}: ${line}`)
			.join('\n');
		return {
			output: `File: ${relativePath} (lines ${start}-${end} of ${lines.length})\n${numbered}`,
		};
	}

	private async runWriteFile(args: Record<string, unknown>, checkpointId: string): Promise<ToolRunResult> {
		const filePath = String(args.path ?? '');
		const newContent = String(args.content ?? '');
		const { absolutePath, relativePath } = this.workspaceIndex.resolvePath(filePath);
		this.assertSafe(relativePath);

		let existedBefore = false;
		let beforeContent = '';
		try {
			beforeContent = await fs.promises.readFile(absolutePath, 'utf8');
			existedBefore = true;
		} catch {
			existedBefore = false;
		}

		await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
		await fs.promises.writeFile(absolutePath, newContent, 'utf8');

		const record = this.recordEdit(checkpointId, relativePath, absolutePath, existedBefore, beforeContent, newContent);
		return {
			output: `${existedBefore ? 'Updated' : 'Created'} ${relativePath} (+${record.addedLines} -${record.removedLines})`,
			editRecord: record,
		};
	}

	private async runEditFile(args: Record<string, unknown>, checkpointId: string): Promise<ToolRunResult> {
		const filePath = String(args.path ?? '');
		const target = String(args.target ?? '');
		const replacement = String(args.replacement ?? '');
		if (!target) {
			return { output: 'edit_file requires a non-empty target string.', isError: true };
		}

		const { absolutePath, relativePath } = this.workspaceIndex.resolvePath(filePath);
		this.assertSafe(relativePath);
		const beforeContent = await fs.promises.readFile(absolutePath, 'utf8');

		let afterContent: string;
		if (beforeContent.includes(target)) {
			afterContent = beforeContent.replace(target, replacement);
		} else {
			const normBefore = beforeContent.replace(/\r\n/g, '\n');
			const normTarget = target.replace(/\r\n/g, '\n');
			if (!normBefore.includes(normTarget)) {
				return {
					output: `Target snippet not found in ${relativePath}. Please call read_file first to verify exact text.`,
					isError: true,
				};
			}
			const usesCrlf = beforeContent.includes('\r\n');
			const normRepl = replacement.replace(/\r\n/g, '\n');
			afterContent = normBefore.replace(normTarget, normRepl);
			if (usesCrlf) {
				afterContent = afterContent.replace(/\n/g, '\r\n');
			}
		}

		await fs.promises.writeFile(absolutePath, afterContent, 'utf8');
		const record = this.recordEdit(checkpointId, relativePath, absolutePath, true, beforeContent, afterContent);
		return {
			output: `Edited ${relativePath} (+${record.addedLines} -${record.removedLines})`,
			editRecord: record,
		};
	}

	private async runListDir(args: Record<string, unknown>): Promise<ToolRunResult> {
		const target = typeof args.path === 'string' && args.path.trim() ? args.path : '.';
		const summary = await this.workspaceIndex.buildFolderSummary(target);
		return { output: summary };
	}

	private async runSearchFiles(args: Record<string, unknown>): Promise<ToolRunResult> {
		const query = String(args.query ?? '');
		if (!query) {
			return { output: 'Empty search query.', isError: true };
		}
		const subPath = typeof args.path === 'string' && args.path.trim() ? args.path.trim().replace(/\\/g, '/') : '';
		const isRegex = Boolean(args.is_regex);
		const regex = isRegex ? new RegExp(query, 'i') : undefined;
		const lowerQuery = query.toLowerCase();

		const root = this.workspaceIndex.getWorkspaceRoot();
		if (!root) {
			return { output: 'No workspace folder open.', isError: true };
		}

		const files = await this.workspaceIndex.listWorkspaceFiles(400);
		const matches: string[] = [];

		for (const rel of files) {
			if (subPath && !rel.startsWith(subPath)) {
				continue;
			}
			const full = path.join(root, rel);
			let content: string;
			try {
				const stat = await fs.promises.stat(full);
				if (stat.size > 200_000) {
					continue;
				}
				content = await fs.promises.readFile(full, 'utf8');
			} catch {
				continue;
			}

			const lines = content.split(/\r?\n/);
			for (let i = 0; i < lines.length; i++) {
				const line = lines[i];
				const matched = regex ? regex.test(line) : line.toLowerCase().includes(lowerQuery);
				if (matched) {
					matches.push(`${rel}:${i + 1}: ${line.trim().slice(0, 180)}`);
					if (matches.length >= 60) {
						return { output: matches.join('\n') + '\n... (truncated at 60 matches)' };
					}
				}
			}
		}

		return {
			output: matches.length > 0 ? matches.join('\n') : `No matches found for "${query}".`,
		};
	}

	private async runTerminalCommand(
		args: Record<string, unknown>,
		signal?: AbortSignal,
		onLiveOutput?: (chunk: string) => void
	): Promise<ToolRunResult> {
		const command = String(args.command ?? '').trim();
		if (!command) {
			return { output: 'Empty command.', isError: true };
		}
		const root = this.workspaceIndex.getWorkspaceRoot();
		const cwd = typeof args.cwd === 'string' && args.cwd.trim()
			? this.workspaceIndex.resolvePath(args.cwd).absolutePath
			: root ?? process.cwd();

		return await new Promise<ToolRunResult>(resolve => {
			const isWin = process.platform === 'win32';
			const shell = isWin ? 'powershell.exe' : '/bin/sh';
			const shellArgs = isWin ? ['-NoProfile', '-Command', command] : ['-c', command];
			const child = spawn(shell, shellArgs, { cwd, env: process.env });

			let stdout = '';
			let stderr = '';
			let combinedLive = '';
			let finished = false;
			const MAX_OUT = 16_000;

			const finish = (code: number | null, suffix = '') => {
				if (finished) {
					return;
				}
				finished = true;
				clearTimeout(timeout);
				const parts: string[] = [`Exit code: ${code ?? -1}`];
				if (stdout.trim()) {
					parts.push(`STDOUT:\n${stdout.slice(0, MAX_OUT)}`);
				}
				if (stderr.trim()) {
					parts.push(`STDERR:\n${stderr.slice(0, MAX_OUT)}`);
				}
				if (suffix) {
					parts.push(suffix);
				}
				const output = parts.join('\n\n');
				this.workspaceIndex.recordTerminalOutput(command, output);
				resolve({
					output,
					isError: code !== 0,
				});
			};

			const timeout = setTimeout(() => {
				child.kill();
				finish(-1, '(Timed out after 60s)');
			}, 60_000);

			signal?.addEventListener('abort', () => {
				child.kill();
				finish(-1, '(Cancelled by user)');
			}, { once: true });

			child.stdout.on('data', chunk => {
				const s = chunk.toString('utf8');
				if (stdout.length < MAX_OUT) {
					stdout += s;
				}
				if (combinedLive.length < 4000) {
					combinedLive += s;
					onLiveOutput?.(combinedLive);
				}
			});
			child.stderr.on('data', chunk => {
				const s = chunk.toString('utf8');
				if (stderr.length < MAX_OUT) {
					stderr += s;
				}
				if (combinedLive.length < 4000) {
					combinedLive += s;
					onLiveOutput?.(combinedLive);
				}
			});
			child.on('error', err => finish(-1, err.message));
			child.on('close', code => finish(code));
		});
	}

	private recordEdit(
		checkpointId: string,
		relativePath: string,
		absolutePath: string,
		existedBefore: boolean,
		beforeContent: string,
		afterContent: string
	): FileEditRecord {
		const { added, removed } = computeLineStats(beforeContent, afterContent);
		const record: FileEditRecord = {
			id: `edit_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
			relativePath,
			absolutePath,
			existedBefore,
			beforeContent,
			afterContent,
			addedLines: added,
			removedLines: removed,
			reverted: false,
		};
		this.editRecords.set(record.id, record);
		const list = this.checkpoints.get(checkpointId) ?? [];
		list.push(record);
		this.checkpoints.set(checkpointId, list);
		return record;
	}
}

function computeLineStats(before: string, after: string): { added: number; removed: number } {
	const beforeLines = before ? before.split(/\r?\n/) : [];
	const afterLines = after ? after.split(/\r?\n/) : [];
	const beforeMap = new Map<string, number>();
	for (const line of beforeLines) {
		beforeMap.set(line, (beforeMap.get(line) ?? 0) + 1);
	}
	let common = 0;
	for (const line of afterLines) {
		const c = beforeMap.get(line) ?? 0;
		if (c > 0) {
			common++;
			beforeMap.set(line, c - 1);
		}
	}
	return {
		added: Math.max(0, afterLines.length - common),
		removed: Math.max(0, beforeLines.length - common),
	};
}
