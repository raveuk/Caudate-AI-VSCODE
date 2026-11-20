/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

export type ProviderId = 'openai-compatible' | 'ollama' | 'lmstudio';
export type TabProviderId = 'same' | ProviderId;
export type ChatMode = 'agent' | 'ask' | 'plan';

export interface ProviderPreset {
	readonly id: string;
	readonly name: string;
	readonly provider: ProviderId;
	readonly baseUrl: string;
	readonly defaultModel: string;
	readonly requiresApiKey: boolean;
}

export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
	{
		id: 'ollama',
		name: 'Ollama (Local)',
		provider: 'ollama',
		baseUrl: 'http://localhost:11434',
		defaultModel: 'qwen2.5-coder:7b',
		requiresApiKey: false,
	},
	{
		id: 'lmstudio',
		name: 'LM Studio (Local)',
		provider: 'lmstudio',
		baseUrl: 'http://localhost:1234/v1',
		defaultModel: '',
		requiresApiKey: false,
	},
	{
		id: 'openai',
		name: 'OpenAI',
		provider: 'openai-compatible',
		baseUrl: 'https://api.openai.com/v1',
		defaultModel: 'gpt-4o',
		requiresApiKey: true,
	},
	{
		id: 'openrouter',
		name: 'OpenRouter',
		provider: 'openai-compatible',
		baseUrl: 'https://openrouter.ai/api/v1',
		defaultModel: 'anthropic/claude-sonnet-4',
		requiresApiKey: true,
	},
	{
		id: 'deepseek',
		name: 'DeepSeek',
		provider: 'openai-compatible',
		baseUrl: 'https://api.deepseek.com/v1',
		defaultModel: 'deepseek-chat',
		requiresApiKey: true,
	},
	{
		id: 'groq',
		name: 'Groq',
		provider: 'openai-compatible',
		baseUrl: 'https://api.groq.com/openai/v1',
		defaultModel: 'llama-3.3-70b-versatile',
		requiresApiKey: true,
	},
];

export interface AetherSettings {
	provider: ProviderId;
	openaiBaseUrl: string;
	openaiModel: string;
	hasApiKey: boolean;
	ollamaBaseUrl: string;
	ollamaModel: string;
	lmstudioBaseUrl: string;
	lmstudioModel: string;
	tabEnabled: boolean;
	tabProvider: TabProviderId;
	tabModel: string;
	tabDebounceMs: number;
	nesEnabled: boolean;
	embeddingModel: string;
	agentMaxSteps: number;
	autoApproveWrites: boolean;
	autoApproveTerminal: boolean;
	commandAllowlist: string[];
	commandDenylist: string[];
	respectIgnoreFiles: boolean;
	maxContextTokens: number;
	systemPrompt: string;
}

export interface DiscoveredModel {
	id: string;
	name: string;
	provider: ProviderId;
	size?: string;
}

export interface ChatToolCall {
	id: string;
	name: string;
	arguments: string;
}

export type MessageContentPart =
	| { type: 'text'; text: string }
	| { type: 'image_url'; image_url: { url: string } };

export interface ChatMessageParam {
	role: 'system' | 'user' | 'assistant' | 'tool';
	content: string | MessageContentPart[] | null;
	tool_calls?: Array<{
		id: string;
		type: 'function';
		function: {
			name: string;
			arguments: string;
		};
	}>;
	tool_call_id?: string;
	name?: string;
}

export interface OpenAIToolSchema {
	type: 'function';
	function: {
		name: string;
		description: string;
		parameters: {
			type: 'object';
			properties: Record<string, unknown>;
			required?: string[];
		};
	};
}

export interface ImageAttachment {
	id: string;
	name: string;
	dataUrl: string;
}

export interface ContextChip {
	id: string;
	kind: 'file' | 'folder' | 'selection' | 'problems' | 'codebase' | 'git' | 'terminal' | 'symbols' | 'web' | 'docs' | 'notepad';
	label: string;
	detail?: string;
	filePath?: string;
	startLine?: number;
	endLine?: number;
	content?: string;
	url?: string;
	notepadId?: string;
}

export interface FileEditRecord {
	id: string;
	relativePath: string;
	absolutePath: string;
	existedBefore: boolean;
	beforeContent: string;
	afterContent: string;
	addedLines: number;
	removedLines: number;
	reverted: boolean;
	accepted?: boolean;
}

export interface ToolExecutionCard {
	id: string;
	toolName: string;
	summary: string;
	argsPreview: string;
	status: 'pending' | 'running' | 'done' | 'error' | 'denied';
	output?: string;
	command?: string;
	editRecord?: FileEditRecord;
	screenshotDataUrl?: string;
}

export interface ArtifactCard {
	id: string;
	kind: 'plan' | 'walkthrough' | 'review';
	title: string;
	markdown: string;
	approved?: boolean;
}

export interface UITurn {
	id: string;
	role: 'user' | 'assistant';
	content: string;
	thinking?: string;
	timestamp: number;
	mode?: ChatMode;
	model?: string;
	contextChips?: ContextChip[];
	images?: ImageAttachment[];
	toolCards?: ToolExecutionCard[];
	artifact?: ArtifactCard;
	checkpointId?: string;
	error?: string;
}

export interface ChatSession {
	id: string;
	title: string;
	createdAt: number;
	updatedAt: number;
	mode: ChatMode;
	turns: UITurn[];
	compactedSummary?: string;
}

export interface NotepadItem {
	id: string;
	title: string;
	content: string;
	updatedAt: number;
}

export interface McpServerStatus {
	name: string;
	transport: 'stdio' | 'http';
	status: 'connected' | 'disconnected' | 'error';
	toolCount: number;
	tools: string[];
	error?: string;
}

export interface ParallelAgentTask {
	id: string;
	prompt: string;
	branch: string;
	worktreePath: string;
	status: 'running' | 'completed' | 'failed' | 'merged' | 'discarded';
	startedAt: number;
	finishedAt?: number;
	summary: string;
	changedFiles: string[];
	log: string[];
}

export interface VectorIndexStatus {
	indexedFiles: number;
	indexedChunks: number;
	usingEmbeddings: boolean;
	embeddingModel: string;
	isIndexing: boolean;
}
