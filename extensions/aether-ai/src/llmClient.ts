/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import {
	AetherSettings,
	ChatMessageParam,
	ChatToolCall,
	DiscoveredModel,
	OpenAIToolSchema,
	ProviderId,
	TabProviderId,
} from './types';

const SECRET_API_KEY = 'aether.openai.apiKey';

export interface StreamChatOptions {
	messages: ChatMessageParam[];
	tools?: OpenAIToolSchema[];
	temperature?: number;
	maxTokens?: number;
	providerOverride?: ProviderId;
	modelOverride?: string;
	signal?: AbortSignal;
	onDelta?: (delta: { text?: string; thinking?: string }) => void;
}

export interface StreamChatResult {
	text: string;
	thinking: string;
	toolCalls: ChatToolCall[];
	model: string;
	provider: ProviderId;
}

export interface CompletionOptions {
	prefix: string;
	suffix: string;
	languageId: string;
	fileName: string;
	signal?: AbortSignal;
}

function normalizeBaseUrl(url: string, fallback: string): string {
	const cleaned = (url || fallback).trim().replace(/\/+$/, '');
	return cleaned || fallback;
}

function formatBytes(bytes?: number): string | undefined {
	if (!bytes || !Number.isFinite(bytes)) {
		return undefined;
	}
	const gb = bytes / (1024 * 1024 * 1024);
	if (gb >= 1) {
		return `${gb.toFixed(1)} GB`;
	}
	const mb = bytes / (1024 * 1024);
	return `${mb.toFixed(0)} MB`;
}

export class AetherLLMClient {
	private readonly _onDidChangeSettings = new vscode.EventEmitter<AetherSettings>();
	public readonly onDidChangeSettings = this._onDidChangeSettings.event;

	constructor(private readonly context: vscode.ExtensionContext) {}

	public async getApiKey(): Promise<string> {
		return (await this.context.secrets.get(SECRET_API_KEY)) ?? '';
	}

	public async setApiKey(apiKey: string): Promise<void> {
		const trimmed = apiKey.trim();
		if (!trimmed) {
			await this.context.secrets.delete(SECRET_API_KEY);
		} else {
			await this.context.secrets.store(SECRET_API_KEY, trimmed);
		}
		this._onDidChangeSettings.fire(await this.getSettings());
	}

	public async getSettings(): Promise<AetherSettings> {
		const cfg = vscode.workspace.getConfiguration('aether');
		const apiKey = await this.getApiKey();
		return {
			provider: cfg.get<ProviderId>('provider', 'ollama'),
			openaiBaseUrl: normalizeBaseUrl(cfg.get<string>('openai.baseUrl', 'https://api.openai.com/v1'), 'https://api.openai.com/v1'),
			openaiModel: cfg.get<string>('openai.model', 'gpt-4o'),
			hasApiKey: apiKey.length > 0,
			ollamaBaseUrl: normalizeBaseUrl(cfg.get<string>('ollama.baseUrl', 'http://localhost:11434'), 'http://localhost:11434'),
			ollamaModel: cfg.get<string>('ollama.model', 'qwen2.5-coder:7b'),
			lmstudioBaseUrl: normalizeBaseUrl(cfg.get<string>('lmstudio.baseUrl', 'http://localhost:1234/v1'), 'http://localhost:1234/v1'),
			lmstudioModel: cfg.get<string>('lmstudio.model', ''),
			tabEnabled: cfg.get<boolean>('tab.enabled', true),
			tabProvider: cfg.get<TabProviderId>('tab.provider', 'same'),
			tabModel: cfg.get<string>('tab.model', ''),
			tabDebounceMs: cfg.get<number>('tab.debounceMs', 320),
			nesEnabled: cfg.get<boolean>('tab.nesEnabled', true),
			embeddingModel: cfg.get<string>('index.embeddingModel', ''),
			agentMaxSteps: cfg.get<number>('agent.maxSteps', 16),
			autoApproveWrites: cfg.get<boolean>('agent.autoApproveWrites', true),
			autoApproveTerminal: cfg.get<boolean>('agent.autoApproveTerminal', false),
			commandAllowlist: cfg.get<string[]>('agent.commandAllowlist', ['git status', 'git diff', 'git log', 'npm test', 'pnpm test', 'pytest', 'dir', 'ls']),
			commandDenylist: cfg.get<string[]>('agent.commandDenylist', []),
			respectIgnoreFiles: cfg.get<boolean>('privacy.respectIgnoreFiles', true),
			maxContextTokens: cfg.get<number>('chat.maxContextTokens', 64000),
			systemPrompt: cfg.get<string>('systemPrompt', ''),
		};
	}

	public async updateSettings(partial: Partial<AetherSettings> & { apiKey?: string }): Promise<AetherSettings> {
		const cfg = vscode.workspace.getConfiguration('aether');
		const target = vscode.ConfigurationTarget.Global;

		if (partial.provider !== undefined) {
			await cfg.update('provider', partial.provider, target);
		}
		if (partial.openaiBaseUrl !== undefined) {
			await cfg.update('openai.baseUrl', normalizeBaseUrl(partial.openaiBaseUrl, 'https://api.openai.com/v1'), target);
		}
		if (partial.openaiModel !== undefined) {
			await cfg.update('openai.model', partial.openaiModel.trim(), target);
		}
		if (partial.apiKey !== undefined) {
			await this.setApiKey(partial.apiKey);
		}
		if (partial.ollamaBaseUrl !== undefined) {
			await cfg.update('ollama.baseUrl', normalizeBaseUrl(partial.ollamaBaseUrl, 'http://localhost:11434'), target);
		}
		if (partial.ollamaModel !== undefined) {
			await cfg.update('ollama.model', partial.ollamaModel.trim(), target);
		}
		if (partial.lmstudioBaseUrl !== undefined) {
			await cfg.update('lmstudio.baseUrl', normalizeBaseUrl(partial.lmstudioBaseUrl, 'http://localhost:1234/v1'), target);
		}
		if (partial.lmstudioModel !== undefined) {
			await cfg.update('lmstudio.model', partial.lmstudioModel.trim(), target);
		}
		if (partial.tabEnabled !== undefined) {
			await cfg.update('tab.enabled', partial.tabEnabled, target);
		}
		if (partial.tabProvider !== undefined) {
			await cfg.update('tab.provider', partial.tabProvider, target);
		}
		if (partial.tabModel !== undefined) {
			await cfg.update('tab.model', partial.tabModel.trim(), target);
		}
		if (partial.tabDebounceMs !== undefined) {
			await cfg.update('tab.debounceMs', Math.max(100, Math.min(2000, Number(partial.tabDebounceMs) || 320)), target);
		}
		if (partial.nesEnabled !== undefined) {
			await cfg.update('tab.nesEnabled', partial.nesEnabled, target);
		}
		if (partial.embeddingModel !== undefined) {
			await cfg.update('index.embeddingModel', partial.embeddingModel.trim(), target);
		}
		if (partial.agentMaxSteps !== undefined) {
			await cfg.update('agent.maxSteps', Math.max(1, Math.min(50, Number(partial.agentMaxSteps) || 16)), target);
		}
		if (partial.autoApproveWrites !== undefined) {
			await cfg.update('agent.autoApproveWrites', partial.autoApproveWrites, target);
		}
		if (partial.autoApproveTerminal !== undefined) {
			await cfg.update('agent.autoApproveTerminal', partial.autoApproveTerminal, target);
		}
		if (partial.commandAllowlist !== undefined) {
			await cfg.update('agent.commandAllowlist', partial.commandAllowlist, target);
		}
		if (partial.commandDenylist !== undefined) {
			await cfg.update('agent.commandDenylist', partial.commandDenylist, target);
		}
		if (partial.respectIgnoreFiles !== undefined) {
			await cfg.update('privacy.respectIgnoreFiles', partial.respectIgnoreFiles, target);
		}
		if (partial.maxContextTokens !== undefined) {
			await cfg.update('chat.maxContextTokens', Math.max(4000, Math.min(1_000_000, Number(partial.maxContextTokens) || 64000)), target);
		}
		if (partial.systemPrompt !== undefined) {
			await cfg.update('systemPrompt', partial.systemPrompt, target);
		}

		const updated = await this.getSettings();
		this._onDidChangeSettings.fire(updated);
		return updated;
	}

	public async embedText(text: string, modelOverride?: string): Promise<number[] | undefined> {
		const settings = await this.getSettings();
		const model = (modelOverride || settings.embeddingModel || '').trim();
		if (!model) {
			return undefined;
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 8000);
		try {
			if (settings.provider === 'ollama') {
				const base = normalizeBaseUrl(settings.ollamaBaseUrl, 'http://localhost:11434').replace(/\/v1$/, '');
				const res = await fetch(`${base}/api/embeddings`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ model, prompt: text.slice(0, 4000) }),
					signal: controller.signal,
				});
				if (!res.ok) {
					return undefined;
				}
				const data = await res.json() as { embedding?: number[] };
				return Array.isArray(data.embedding) ? data.embedding : undefined;
			}

			const base = settings.provider === 'lmstudio'
				? normalizeBaseUrl(settings.lmstudioBaseUrl, 'http://localhost:1234/v1')
				: normalizeBaseUrl(settings.openaiBaseUrl, 'https://api.openai.com/v1');
			const v1Base = settings.provider === 'lmstudio' && !base.endsWith('/v1') ? `${base}/v1` : base;
			const headers: Record<string, string> = { 'Content-Type': 'application/json' };
			if (settings.provider === 'openai-compatible') {
				const key = await this.getApiKey();
				if (key) {
					headers['Authorization'] = `Bearer ${key}`;
				}
			}
			const res = await fetch(`${v1Base}/embeddings`, {
				method: 'POST',
				headers,
				body: JSON.stringify({ model, input: text.slice(0, 4000) }),
				signal: controller.signal,
			});
			if (!res.ok) {
				return undefined;
			}
			const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
			return data.data?.[0]?.embedding;
		} catch {
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	}

	public getActiveModelName(settings: AetherSettings, providerOverride?: ProviderId): string {
		const provider = providerOverride ?? settings.provider;
		switch (provider) {
			case 'ollama':
				return settings.ollamaModel || 'qwen2.5-coder:7b';
			case 'lmstudio':
				return settings.lmstudioModel || 'local-model';
			case 'openai-compatible':
			default:
				return settings.openaiModel || 'gpt-4o';
		}
	}

	private async resolveEndpoint(settings: AetherSettings, provider: ProviderId, modelOverride?: string): Promise<{
		chatUrl: string;
		headers: Record<string, string>;
		model: string;
	}> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};

		if (provider === 'ollama') {
			const base = normalizeBaseUrl(settings.ollamaBaseUrl, 'http://localhost:11434');
			const v1Base = base.endsWith('/v1') ? base : `${base}/v1`;
			let model = (modelOverride || settings.ollamaModel || '').trim();
			if (!model) {
				const models = await this.listModels('ollama').catch(() => []);
				model = models[0]?.id ?? 'qwen2.5-coder:7b';
			}
			return {
				chatUrl: `${v1Base}/chat/completions`,
				headers,
				model,
			};
		}

		if (provider === 'lmstudio') {
			const base = normalizeBaseUrl(settings.lmstudioBaseUrl, 'http://localhost:1234/v1');
			const v1Base = base.endsWith('/v1') ? base : `${base}/v1`;
			let model = (modelOverride || settings.lmstudioModel || '').trim();
			if (!model) {
				const models = await this.listModels('lmstudio').catch(() => []);
				model = models[0]?.id ?? 'local-model';
			}
			return {
				chatUrl: `${v1Base}/chat/completions`,
				headers,
				model,
			};
		}

		// openai-compatible
		const base = normalizeBaseUrl(settings.openaiBaseUrl, 'https://api.openai.com/v1');
		const apiKey = await this.getApiKey();
		if (apiKey) {
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		if (base.includes('openrouter.ai')) {
			headers['HTTP-Referer'] = 'https://aether-ide.local';
			headers['X-Title'] = 'Aether IDE';
		}
		const model = (modelOverride || settings.openaiModel || 'gpt-4o').trim();
		return {
			chatUrl: `${base}/chat/completions`,
			headers,
			model,
		};
	}

	public async listModels(provider: ProviderId): Promise<DiscoveredModel[]> {
		const settings = await this.getSettings();
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 5000);

		try {
			if (provider === 'ollama') {
				const base = normalizeBaseUrl(settings.ollamaBaseUrl, 'http://localhost:11434').replace(/\/v1$/, '');
				const res = await fetch(`${base}/api/tags`, { signal: controller.signal });
				if (!res.ok) {
					throw new Error(`Ollama returned HTTP ${res.status}`);
				}
				const data = await res.json() as { models?: Array<{ name: string; size?: number }> };
				return (data.models ?? []).map(m => ({
					id: m.name,
					name: m.name,
					provider: 'ollama' as const,
					size: formatBytes(m.size),
				}));
			}

			if (provider === 'lmstudio') {
				const base = normalizeBaseUrl(settings.lmstudioBaseUrl, 'http://localhost:1234/v1');
				const v1Base = base.endsWith('/v1') ? base : `${base}/v1`;
				const res = await fetch(`${v1Base}/models`, { signal: controller.signal });
				if (!res.ok) {
					throw new Error(`LM Studio returned HTTP ${res.status}`);
				}
				const data = await res.json() as { data?: Array<{ id: string }> };
				return (data.data ?? []).map(m => ({
					id: m.id,
					name: m.id,
					provider: 'lmstudio' as const,
				}));
			}

			// openai-compatible
			const base = normalizeBaseUrl(settings.openaiBaseUrl, 'https://api.openai.com/v1');
			const apiKey = await this.getApiKey();
			const headers: Record<string, string> = {};
			if (apiKey) {
				headers['Authorization'] = `Bearer ${apiKey}`;
			}
			const res = await fetch(`${base}/models`, { headers, signal: controller.signal });
			if (!res.ok) {
				throw new Error(`Provider returned HTTP ${res.status}`);
			}
			const data = await res.json() as { data?: Array<{ id: string }> };
			return (data.data ?? [])
				.map(m => ({
					id: m.id,
					name: m.id,
					provider: 'openai-compatible' as const,
				}))
				.sort((a, b) => a.id.localeCompare(b.id))
				.slice(0, 120);
		} finally {
			clearTimeout(timer);
		}
	}

	public async testConnection(provider: ProviderId): Promise<{ ok: boolean; models: DiscoveredModel[]; message: string }> {
		try {
			const models = await this.listModels(provider);
			return {
				ok: true,
				models,
				message: models.length > 0
					? `Connected (${models.length} model${models.length === 1 ? '' : 's'} available)`
					: 'Connected (no models currently loaded)',
			};
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				ok: false,
				models: [],
				message: msg,
			};
		}
	}

	public async streamChat(options: StreamChatOptions): Promise<StreamChatResult> {
		const settings = await this.getSettings();
		const provider = options.providerOverride ?? settings.provider;
		const endpoint = await this.resolveEndpoint(settings, provider, options.modelOverride);

		const body: Record<string, unknown> = {
			model: endpoint.model,
			messages: options.messages,
			stream: true,
			temperature: options.temperature ?? 0.2,
		};
		if (options.maxTokens) {
			body.max_tokens = options.maxTokens;
		}
		if (options.tools && options.tools.length > 0) {
			body.tools = options.tools;
			body.tool_choice = 'auto';
		}

		let response: Response;
		try {
			response = await fetch(endpoint.chatUrl, {
				method: 'POST',
				headers: endpoint.headers,
				body: JSON.stringify(body),
				signal: options.signal,
			});
		} catch (err) {
			const hint = provider === 'ollama'
				? 'Make sure Ollama is running (`ollama serve`) at ' + settings.ollamaBaseUrl
				: provider === 'lmstudio'
					? 'Make sure LM Studio Local Server is started at ' + settings.lmstudioBaseUrl
					: 'Check your API Base URL and network connection.';
			throw new Error(`Could not reach ${provider} (${err instanceof Error ? err.message : String(err)}). ${hint}`);
		}

		// Graceful fallback if local model doesn't support `tools` parameter
		if (!response.ok && options.tools && options.tools.length > 0 && response.status === 400) {
			const errText = await response.text().catch(() => '');
			if (/tool|function/i.test(errText)) {
				delete body.tools;
				delete body.tool_choice;
				response = await fetch(endpoint.chatUrl, {
					method: 'POST',
					headers: endpoint.headers,
					body: JSON.stringify(body),
					signal: options.signal,
				});
			} else {
				throw new Error(`HTTP ${response.status}: ${errText.slice(0, 400)}`);
			}
		}

		if (!response.ok) {
			const errText = await response.text().catch(() => '');
			throw new Error(`HTTP ${response.status} from ${provider}: ${errText.slice(0, 500)}`);
		}

		if (!response.body) {
			throw new Error('Empty response body from LLM server.');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder('utf-8');

		let buffer = '';
		let fullText = '';
		let fullThinking = '';
		let insideThinkTag = false;
		const toolCallMap = new Map<number, { id: string; name: string; arguments: string }>();

		const emitTextChunk = (rawChunk: string) => {
			if (!rawChunk) {
				return;
			}
			// Support <think>...</think> inline reasoning tags emitted by DeepSeek-R1 / Qwen models
			let remaining = rawChunk;
			while (remaining.length > 0) {
				if (insideThinkTag) {
					const endIdx = remaining.indexOf('</think>');
					if (endIdx === -1) {
						fullThinking += remaining;
						options.onDelta?.({ thinking: remaining });
						remaining = '';
					} else {
						const thoughtPart = remaining.slice(0, endIdx);
						if (thoughtPart) {
							fullThinking += thoughtPart;
							options.onDelta?.({ thinking: thoughtPart });
						}
						insideThinkTag = false;
						remaining = remaining.slice(endIdx + '</think>'.length);
					}
				} else {
					const startIdx = remaining.indexOf('<think>');
					if (startIdx === -1) {
						fullText += remaining;
						options.onDelta?.({ text: remaining });
						remaining = '';
					} else {
						const textPart = remaining.slice(0, startIdx);
						if (textPart) {
							fullText += textPart;
							options.onDelta?.({ text: textPart });
						}
						insideThinkTag = true;
						remaining = remaining.slice(startIdx + '<think>'.length);
					}
				}
			}
		};

		while (true) {
			const { value, done } = await reader.read();
			if (done) {
				break;
			}
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';

			for (const rawLine of lines) {
				const line = rawLine.trim();
				if (!line || line.startsWith(':')) {
					continue;
				}
				if (!line.startsWith('data:')) {
					continue;
				}
				const payload = line.slice(5).trim();
				if (payload === '[DONE]') {
					continue;
				}

				let parsed: {
					choices?: Array<{
						delta?: {
							content?: string | null;
							reasoning_content?: string | null;
							reasoning?: string | null;
							tool_calls?: Array<{
								index?: number;
								id?: string;
								function?: {
									name?: string;
									arguments?: string;
								};
							}>;
						};
					}>;
				};
				try {
					parsed = JSON.parse(payload);
				} catch {
					continue;
				}

				const delta = parsed.choices?.[0]?.delta;
				if (!delta) {
					continue;
				}

				const reasoningChunk = delta.reasoning_content ?? delta.reasoning;
				if (reasoningChunk) {
					fullThinking += reasoningChunk;
					options.onDelta?.({ thinking: reasoningChunk });
				}

				if (delta.content) {
					emitTextChunk(delta.content);
				}

				if (Array.isArray(delta.tool_calls)) {
					for (const tc of delta.tool_calls) {
						const idx = tc.index ?? 0;
						let existing = toolCallMap.get(idx);
						if (!existing) {
							existing = {
								id: tc.id || `call_${idx}_${Date.now()}`,
								name: tc.function?.name || '',
								arguments: tc.function?.arguments || '',
							};
							toolCallMap.set(idx, existing);
						} else {
							if (tc.id) {
								existing.id = tc.id;
							}
							if (tc.function?.name) {
								existing.name += tc.function.name;
							}
							if (tc.function?.arguments) {
								existing.arguments += tc.function.arguments;
							}
						}
					}
				}
			}
		}

		const toolCalls: ChatToolCall[] = [...toolCallMap.entries()]
			.sort((a, b) => a[0] - b[0])
			.map(([, tc]) => tc)
			.filter(tc => tc.name.length > 0);

		return {
			text: fullText,
			thinking: fullThinking,
			toolCalls,
			model: endpoint.model,
			provider,
		};
	}

	public async completeInline(options: CompletionOptions): Promise<string> {
		const settings = await this.getSettings();
		const provider: ProviderId = settings.tabProvider === 'same' ? settings.provider : settings.tabProvider;
		const modelOverride = settings.tabModel.trim() || undefined;

		// Fast native Ollama FIM endpoint (/api/generate with suffix)
		if (provider === 'ollama') {
			const base = normalizeBaseUrl(settings.ollamaBaseUrl, 'http://localhost:11434').replace(/\/v1$/, '');
			const model = modelOverride || settings.ollamaModel || 'qwen2.5-coder:7b';
			const isFimCapable = /coder|starcoder|codellama|deepseek|qwen|granite|codestral/i.test(model);

			if (isFimCapable) {
				const res = await fetch(`${base}/api/generate`, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					signal: options.signal,
					body: JSON.stringify({
						model,
						prompt: options.prefix,
						suffix: options.suffix,
						stream: false,
						options: {
							temperature: 0.1,
							num_predict: 128,
							stop: ['\n\n\n', '<|endoftext|>', '<|file_sep|>', '<|fim_pad|>', '```'],
						},
					}),
				});
				if (res.ok) {
					const data = await res.json() as { response?: string };
					return cleanCompletion(data.response ?? '');
				}
			}
		}

		// Universal chat-based inline completion (works with OpenAI, OpenRouter, DeepSeek, LM Studio, and any Ollama model)
		const result = await this.streamChat({
			providerOverride: provider,
			modelOverride,
			temperature: 0.1,
			maxTokens: 140,
			signal: options.signal,
			messages: [
				{
					role: 'system',
					content:
						'You are an ultra-fast inline code autocomplete engine inside an IDE. ' +
						'Output ONLY the exact code that should be inserted at <CURSOR>. ' +
						'Do NOT wrap in markdown code fences, do NOT explain, do NOT repeat text already before <CURSOR> or after <CURSOR>. ' +
						'Keep completions concise (1 to 6 lines max).',
				},
				{
					role: 'user',
					content: `File: ${options.fileName} (${options.languageId})\n\n${options.prefix}<CURSOR>${options.suffix}`,
				},
			],
		});

		return cleanCompletion(result.text);
	}
}

function cleanCompletion(raw: string): string {
	let text = raw;
	// Strip accidental markdown fences
	const fenceMatch = /^```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)\r?\n?```$/m.exec(text.trim());
	if (fenceMatch) {
		text = fenceMatch[1];
	}
	text = text.replace(/<CURSOR>/g, '');
	// Avoid returning pure whitespace or excessively long completions
	if (!text.trim()) {
		return '';
	}
	return text;
}
