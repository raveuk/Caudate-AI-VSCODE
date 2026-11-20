/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Aether IDE. All rights reserved.
 *  Licensed under the MIT License.
 *--------------------------------------------------------------------------------------------*/

(function () {
	const vscode = acquireVsCodeApi();

	const state = {
		settings: null,
		presets: [],
		discoveredModels: {},
		session: null,
		sessions: [],
		activeFile: null,
		isStreaming: false,
		tokenEstimate: 0,
		pendingEdits: [],
		notepads: [],
		mcpServers: [],
		vectorStatus: null,
		worktreeTasks: [],
		chips: [],
		images: [],
		popupKind: null, // 'mention' | 'slash'
		popupItems: [],
		popupIndex: 0,
		editingNotepadId: null,
	};

	const els = {
		messages: document.getElementById('messages'),
		promptInput: document.getElementById('prompt-input'),
		chipsRow: document.getElementById('chips-row'),
		imagesRow: document.getElementById('images-row'),
		mentionPopup: document.getElementById('mention-popup'),
		modelPicker: document.getElementById('model-picker'),
		btnSend: document.getElementById('btn-send'),
		btnStop: document.getElementById('btn-stop'),
		btnNew: document.getElementById('btn-new'),
		btnAgents: document.getElementById('btn-agents'),
		btnNotepads: document.getElementById('btn-notepads'),
		btnHistory: document.getElementById('btn-history'),
		btnSettings: document.getElementById('btn-settings'),
		btnAddContext: document.getElementById('btn-add-context'),
		btnSlash: document.getElementById('btn-slash'),
		btnAttachImg: document.getElementById('btn-attach-img'),
		imgFileInput: document.getElementById('img-file-input'),
		btnCompact: document.getElementById('btn-compact'),
		tokenFill: document.getElementById('token-fill'),
		tokenLabel: document.getElementById('token-label'),
		reviewBar: document.getElementById('review-bar'),
		reviewSummary: document.getElementById('review-summary'),
		btnReviewNext: document.getElementById('btn-review-next'),
		btnReviewKeep: document.getElementById('btn-review-keep'),
		btnReviewUndo: document.getElementById('btn-review-undo'),
		drawerAgents: document.getElementById('drawer-agents'),
		drawerNotepads: document.getElementById('drawer-notepads'),
		drawerHistory: document.getElementById('drawer-history'),
		drawerSettings: document.getElementById('drawer-settings'),
		wtPrompt: document.getElementById('wt-prompt'),
		btnSpawnWt: document.getElementById('btn-spawn-wt'),
		wtList: document.getElementById('wt-list'),
		npTitle: document.getElementById('np-title'),
		npContent: document.getElementById('np-content'),
		btnSaveNp: document.getElementById('btn-save-np'),
		npList: document.getElementById('np-list'),
		historyList: document.getElementById('history-list'),
		presetGrid: document.getElementById('preset-grid'),
		setProvider: document.getElementById('set-provider'),
		panelOpenai: document.getElementById('panel-openai'),
		panelOllama: document.getElementById('panel-ollama'),
		panelLmstudio: document.getElementById('panel-lmstudio'),
		setOpenaiUrl: document.getElementById('set-openai-url'),
		setOpenaiKey: document.getElementById('set-openai-key'),
		keyBadge: document.getElementById('key-badge'),
		setOpenaiModel: document.getElementById('set-openai-model'),
		setOllamaUrl: document.getElementById('set-ollama-url'),
		setOllamaModel: document.getElementById('set-ollama-model'),
		ollamaModelsList: document.getElementById('ollama-models-list'),
		setLmstudioUrl: document.getElementById('set-lmstudio-url'),
		setLmstudioModel: document.getElementById('set-lmstudio-model'),
		lmstudioModelsList: document.getElementById('lmstudio-models-list'),
		btnTestConn: document.getElementById('btn-test-conn'),
		connStatus: document.getElementById('conn-status'),
		setTabEnabled: document.getElementById('set-tab-enabled'),
		setNesEnabled: document.getElementById('set-nes-enabled'),
		setTabProvider: document.getElementById('set-tab-provider'),
		setTabModel: document.getElementById('set-tab-model'),
		setEmbedModel: document.getElementById('set-embed-model'),
		btnRebuildIndex: document.getElementById('btn-rebuild-index'),
		indexStatus: document.getElementById('index-status'),
		mcpList: document.getElementById('mcp-list'),
		btnReloadMcp: document.getElementById('btn-reload-mcp'),
		btnEditMcp: document.getElementById('btn-edit-mcp'),
		setAutoWrites: document.getElementById('set-auto-writes'),
		setAutoTerminal: document.getElementById('set-auto-terminal'),
		setRespectIgnore: document.getElementById('set-respect-ignore'),
		setAllowlist: document.getElementById('set-allowlist'),
		setDenylist: document.getElementById('set-denylist'),
		setSysPrompt: document.getElementById('set-sys-prompt'),
		btnSaveSettings: document.getElementById('btn-save-settings'),
	};

	function escapeHtml(str) {
		return String(str ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function renderMarkdown(rawText) {
		if (!rawText) {
			return '';
		}
		const blocks = [];
		const textWithPlaceholders = rawText.replace(/```([a-zA-Z0-9_+-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
			const idx = blocks.length;
			blocks.push({ lang: lang || 'code', code });
			return `@@CODEBLOCK_${idx}@@`;
		});

		const paragraphs = textWithPlaceholders.split(/\n{2,}/);
		let html = paragraphs.map(p => {
			const trimmed = p.trim();
			if (/^@@CODEBLOCK_\d+@@$/.test(trimmed)) {
				return trimmed;
			}
			let escaped = escapeHtml(trimmed);
			escaped = escaped.replace(/`([^`]+)`/g, '<code>$1</code>');
			escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
			escaped = escaped.replace(/\n/g, '<br/>');
			return `<p>${escaped}</p>`;
		}).join('');

		html = html.replace(/@@CODEBLOCK_(\d+)@@/g, (_, idxStr) => {
			const block = blocks[Number(idxStr)];
			if (!block) {
				return '';
			}
			const encoded = encodeURIComponent(block.code);
			return `
				<div class="code-block">
					<div class="code-block-header">
						<span>${escapeHtml(block.lang)}</span>
						<div class="tool-card-actions">
							<button class="mini-btn" data-copy-code="${encoded}">Copy</button>
							<button class="mini-btn" data-apply-code="${encoded}">Apply</button>
						</div>
					</div>
					<pre><code>${escapeHtml(block.code)}</code></pre>
				</div>`;
		});

		return html;
	}

	function renderChips() {
		els.chipsRow.innerHTML = state.chips.map(chip => `
			<span class="chip" title="${escapeHtml(chip.detail || chip.label)}">
				<span>@${escapeHtml(chip.label)}</span>
				<button data-remove-chip="${escapeHtml(chip.id)}" title="Remove">✕</button>
			</span>
		`).join('');
	}

	function renderImages() {
		els.imagesRow.innerHTML = state.images.map(img => `
			<span class="img-chip" title="${escapeHtml(img.name)}">
				<img src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />
				<button data-remove-img="${escapeHtml(img.id)}" title="Remove">✕</button>
			</span>
		`).join('');
	}

	function readFilesAsImages(fileList) {
		for (const file of fileList) {
			if (!file.type || !file.type.startsWith('image/')) {
				continue;
			}
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === 'string') {
					state.images.push({
						id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
						name: file.name || 'screenshot.png',
						dataUrl: reader.result,
					});
					renderImages();
				}
			};
			reader.readAsDataURL(file);
		}
	}

	function renderToolCard(card) {
		const edit = card.editRecord;
		const statsHtml = edit
			? `<span class="diff-stats"><span class="diff-add">+${edit.addedLines}</span><span class="diff-del">-${edit.removedLines}</span></span>`
			: '';

		let actionsHtml = '';
		if (card.status === 'pending') {
			actionsHtml = `
				<button class="mini-btn approve" data-approve="${escapeHtml(card.id)}">Approve</button>
				<button class="mini-btn deny" data-deny="${escapeHtml(card.id)}">Deny</button>
			`;
		} else if (edit) {
			actionsHtml = `
				<button class="mini-btn" data-open-diff="${escapeHtml(edit.id)}">Diff</button>
				${edit.reverted
					? `<span class="badge">Reverted</span>`
					: `<button class="mini-btn deny" data-revert-edit="${escapeHtml(edit.id)}">Revert</button>`
				}
			`;
		} else if (card.command) {
			actionsHtml = `<button class="mini-btn" data-move-terminal="${encodeURIComponent(card.command)}">Terminal ↗</button>`;
		}

		const showOutput = card.output && (card.toolName === 'run_terminal_command' || card.status === 'running' || card.status === 'error' || card.status === 'denied' || card.toolName.startsWith('browser_') || card.toolName.startsWith('mcp__'));
		const screenshotHtml = card.screenshotDataUrl
			? `<img class="tool-screenshot" src="${card.screenshotDataUrl}" alt="Browser verification screenshot" />`
			: '';

		return `
			<div class="tool-card">
				<div class="tool-card-head">
					<div class="tool-card-title" title="${escapeHtml(card.argsPreview)}">
						<span class="tool-dot ${escapeHtml(card.status)}"></span>
						<span>${escapeHtml(card.summary)}</span>
						${statsHtml}
					</div>
					<div class="tool-card-actions">${actionsHtml}</div>
				</div>
				${showOutput ? `<div class="tool-card-output">${escapeHtml(card.output)}</div>` : ''}
				${screenshotHtml}
			</div>
		`;
	}

	function renderMessages() {
		const session = state.session;
		if (!session || !session.turns || session.turns.length === 0) {
			const providerName = state.settings
				? (state.settings.provider === 'ollama' ? 'Ollama' : state.settings.provider === 'lmstudio' ? 'LM Studio' : 'OpenAI-compatible')
				: 'AI';
			els.messages.innerHTML = `
				<div class="empty-state">
					<div class="empty-logo">Caudate AI</div>
					<div class="empty-subtitle">
						Autonomous Agent, Browser Verifier, MCP Client & Composer powered by <strong>${escapeHtml(providerName)}</strong>.
					</div>
					<div class="quick-hints">
						<button class="quick-hint" data-quick="/plan Design a clean architecture for this project.">
							<span>Create Implementation Plan</span><kbd>/plan</kbd>
						</button>
						<button class="quick-hint" data-quick="/review">
							<span>AI Code Review on Git Diff</span><kbd>/review</kbd>
						</button>
						<button class="quick-hint" data-quick="/fix">
							<span>Fix Active File Diagnostics</span><kbd>/fix</kbd>
						</button>
						<button class="quick-hint" data-open-drawer="agents">
							<span>Launch Parallel Git Worktree Agent</span><kbd>⎇</kbd>
						</button>
						<button class="quick-hint" data-open-drawer="settings">
							<span>Configure Providers, MCP & Vector Index</span><kbd>⚙</kbd>
						</button>
					</div>
				</div>
			`;
			return;
		}

		const html = session.turns.map((turn, idx) => {
			if (turn.role === 'user') {
				const nextTurn = session.turns[idx + 1];
				const hasEdits = Boolean(nextTurn && Array.isArray(nextTurn.toolCards) && nextTurn.toolCards.some(c => c.editRecord && !c.editRecord.reverted));
				const chipsHtml = (turn.contextChips || []).map(c => `<span class="chip">@${escapeHtml(c.label)}</span>`).join('');
				const imgsHtml = (turn.images || []).map(img => `<img class="turn-thumb" src="${img.dataUrl}" alt="${escapeHtml(img.name)}" />`).join('');
				return `
					<div class="turn turn-user">
						<div class="turn-user-header">
							<span>You · ${escapeHtml((turn.mode || 'agent').toUpperCase())}</span>
							${hasEdits && turn.checkpointId ? `<button class="mini-btn" data-restore-cp="${escapeHtml(turn.checkpointId)}">↺ Restore Checkpoint</button>` : ''}
						</div>
						<div class="turn-user-body">${escapeHtml(turn.content)}</div>
						${chipsHtml ? `<div class="turn-chips">${chipsHtml}</div>` : ''}
						${imgsHtml ? `<div class="turn-images">${imgsHtml}</div>` : ''}
					</div>
				`;
			}

			const thinkingHtml = turn.thinking
				? `<details class="thinking-block"><summary>Reasoning</summary><div class="thinking-content">${escapeHtml(turn.thinking)}</div></details>`
				: '';
			const toolsHtml = turn.toolCards && turn.toolCards.length > 0
				? `<div class="tool-cards">${turn.toolCards.map(renderToolCard).join('')}</div>`
				: '';
			const bodyHtml = turn.content
				? `<div class="md-body">${renderMarkdown(turn.content)}</div>`
				: (state.isStreaming && idx === session.turns.length - 1 ? `<div class="turn-assistant-meta">Thinking...</div>` : '');
			const artifactHtml = turn.artifact
				? `<div class="artifact-card">
						<div class="artifact-title">📋 ${escapeHtml(turn.artifact.title)}</div>
						<div class="artifact-actions">
							<button class="mini-btn" data-open-artifact="${encodeURIComponent(turn.artifact.markdown)}">Open MD</button>
							${turn.artifact.approved
								? `<span class="badge ok">Approved</span>`
								: `<button class="mini-btn approve" data-approve-plan="${escapeHtml(turn.artifact.id)}">▶ Approve & Execute</button>`
							}
						</div>
					</div>`
				: '';
			const errHtml = turn.error
				? `<div class="error-banner">${escapeHtml(turn.error)}</div>`
				: '';

			return `
				<div class="turn turn-assistant" data-turn-id="${escapeHtml(turn.id)}">
					<div class="turn-assistant-meta">
						<span>Caudate</span>
						${turn.model ? `<span>· ${escapeHtml(turn.model)}</span>` : ''}
					</div>
					${thinkingHtml}
					${toolsHtml}
					${bodyHtml}
					${artifactHtml}
					${errHtml}
				</div>
			`;
		}).join('');

		els.messages.innerHTML = html;
		els.messages.scrollTop = els.messages.scrollHeight;
	}

	function syncReviewBar() {
		const edits = state.pendingEdits || [];
		if (edits.length === 0) {
			els.reviewBar.classList.add('hidden');
			return;
		}
		const add = edits.reduce((a, e) => a + (e.addedLines || 0), 0);
		const del = edits.reduce((a, e) => a + (e.removedLines || 0), 0);
		els.reviewSummary.textContent = `${edits.length} file${edits.length === 1 ? '' : 's'} changed (+${add} -${del})`;
		els.reviewBar.classList.remove('hidden');
	}

	function syncTokenMeter() {
		const max = state.settings?.maxContextTokens || 64000;
		const used = state.tokenEstimate || 0;
		const pct = Math.min(100, Math.round((used / max) * 100));
		els.tokenFill.style.width = `${pct}%`;
		els.tokenFill.classList.toggle('warn', pct >= 65 && pct < 85);
		els.tokenFill.classList.toggle('danger', pct >= 85);
		const fmt = n => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
		els.tokenLabel.textContent = `${fmt(used)} / ${fmt(max)} tok`;
	}

	function syncModeTabs() {
		const mode = state.session?.mode || 'agent';
		document.querySelectorAll('.mode-tab').forEach(btn => {
			btn.classList.toggle('active', btn.dataset.mode === mode);
		});
	}

	function syncStreamingUi() {
		els.btnStop.classList.toggle('hidden', !state.isStreaming);
		els.btnSend.classList.toggle('hidden', state.isStreaming);
	}

	function syncModelPicker() {
		if (!state.settings) {
			return;
		}
		const s = state.settings;
		const provider = s.provider;
		const activeModel = provider === 'ollama' ? s.ollamaModel : provider === 'lmstudio' ? s.lmstudioModel : s.openaiModel;
		const discovered = state.discoveredModels[provider] || [];
		const options = new Map();
		if (activeModel) {
			options.set(activeModel, activeModel);
		}
		for (const m of discovered) {
			options.set(m.id, m.size ? `${m.id} (${m.size})` : m.id);
		}
		if (options.size === 0) {
			const fallback = provider === 'ollama' ? 'qwen2.5-coder:7b' : provider === 'lmstudio' ? 'local-model' : 'gpt-4o';
			options.set(fallback, fallback);
		}
		els.modelPicker.innerHTML = [...options.entries()]
			.map(([id, label]) => `<option value="${escapeHtml(id)}" ${id === activeModel ? 'selected' : ''}>${escapeHtml(label)}</option>`)
			.join('');
	}

	function syncSettingsForm() {
		const s = state.settings;
		if (!s) {
			return;
		}
		els.setProvider.value = s.provider;
		els.setOpenaiUrl.value = s.openaiBaseUrl;
		els.setOpenaiModel.value = s.openaiModel;
		els.keyBadge.textContent = s.hasApiKey ? 'Saved securely' : 'Not set';
		els.keyBadge.classList.toggle('ok', s.hasApiKey);
		els.setOllamaUrl.value = s.ollamaBaseUrl;
		els.setOllamaModel.value = s.ollamaModel;
		els.setLmstudioUrl.value = s.lmstudioBaseUrl;
		els.setLmstudioModel.value = s.lmstudioModel;
		els.setTabEnabled.checked = s.tabEnabled;
		els.setNesEnabled.checked = s.nesEnabled;
		els.setTabProvider.value = s.tabProvider;
		els.setTabModel.value = s.tabModel;
		els.setEmbedModel.value = s.embeddingModel || '';
		els.setAutoWrites.checked = s.autoApproveWrites;
		els.setAutoTerminal.checked = s.autoApproveTerminal;
		els.setRespectIgnore.checked = s.respectIgnoreFiles;
		els.setAllowlist.value = (s.commandAllowlist || []).join(', ');
		els.setDenylist.value = (s.commandDenylist || []).join(', ');
		els.setSysPrompt.value = s.systemPrompt;

		updateProviderSections(s.provider);

		els.presetGrid.innerHTML = (state.presets || []).map(p => `
			<button class="preset-btn" data-preset="${escapeHtml(p.id)}">${escapeHtml(p.name)}</button>
		`).join('');

		const ollamaModels = state.discoveredModels.ollama || [];
		els.ollamaModelsList.innerHTML = ollamaModels.map(m => `<option value="${escapeHtml(m.id)}"></option>`).join('');
		const lmsModels = state.discoveredModels.lmstudio || [];
		els.lmstudioModelsList.innerHTML = lmsModels.map(m => `<option value="${escapeHtml(m.id)}"></option>`).join('');

		if (state.vectorStatus) {
			const vs = state.vectorStatus;
			els.indexStatus.textContent = vs.isIndexing
				? 'Indexing...'
				: `${vs.indexedFiles} files · ${vs.indexedChunks} chunks (${vs.usingEmbeddings ? 'vector' : 'lexical'})`;
		}

		// MCP Server list
		if (!state.mcpServers || state.mcpServers.length === 0) {
			els.mcpList.innerHTML = `<div class="conn-status">No MCP servers configured. Click "Edit mcp.json" to add stdio or HTTP MCP servers.</div>`;
		} else {
			els.mcpList.innerHTML = state.mcpServers.map(srv => `
				<div class="info-card">
					<div class="info-card-head">
						<span class="info-card-title">${escapeHtml(srv.name)} (${escapeHtml(srv.transport)})</span>
						<span class="badge ${srv.status === 'connected' ? 'ok' : 'err'}">${srv.status === 'connected' ? `${srv.toolCount} tools` : 'error'}</span>
					</div>
					${srv.error ? `<div class="info-card-sub">${escapeHtml(srv.error)}</div>` : ''}
				</div>
			`).join('');
		}
	}

	function renderWorktrees() {
		const tasks = state.worktreeTasks || [];
		if (tasks.length === 0) {
			els.wtList.innerHTML = `<div class="conn-status">No parallel worktree agents yet. Launch one above to work on tasks in isolated git branches simultaneously.</div>`;
			return;
		}
		els.wtList.innerHTML = tasks.map(t => `
			<div class="info-card">
				<div class="info-card-head">
					<span class="info-card-title" title="${escapeHtml(t.branch)}">${escapeHtml(t.branch)}</span>
					<span class="badge ${t.status === 'completed' || t.status === 'merged' ? 'ok' : t.status === 'failed' ? 'err' : ''}">${escapeHtml(t.status)}</span>
				</div>
				<div class="info-card-sub">${escapeHtml(t.prompt)}</div>
				<div class="info-card-sub">${escapeHtml(t.summary)}</div>
				<div class="settings-row">
					${t.status === 'completed' ? `<button class="mini-btn approve" data-merge-wt="${escapeHtml(t.id)}">Merge Branch</button>` : ''}
					${t.status !== 'discarded' && t.status !== 'merged' ? `<button class="mini-btn" data-open-wt="${escapeHtml(t.id)}">Open Folder</button>` : ''}
					${t.status !== 'discarded' && t.status !== 'merged' ? `<button class="mini-btn deny" data-discard-wt="${escapeHtml(t.id)}">Discard</button>` : ''}
				</div>
			</div>
		`).join('');
	}

	function renderNotepads() {
		const list = state.notepads || [];
		if (list.length === 0) {
			els.npList.innerHTML = `<div class="conn-status">No notepads yet. Save architecture notes, specs, or prompts above to reuse via @notepad.</div>`;
			return;
		}
		els.npList.innerHTML = list.map(n => `
			<div class="info-card">
				<div class="info-card-head">
					<span class="info-card-title">${escapeHtml(n.title)}</span>
					<div class="tool-card-actions">
						<button class="mini-btn" data-attach-np="${escapeHtml(n.id)}">@ Attach</button>
						<button class="mini-btn" data-edit-np="${escapeHtml(n.id)}">Edit</button>
						<button class="mini-btn deny" data-del-np="${escapeHtml(n.id)}">✕</button>
					</div>
				</div>
				<div class="info-card-sub">${escapeHtml(n.content.slice(0, 140))}</div>
			</div>
		`).join('');
	}

	function updateProviderSections(provider) {
		els.panelOpenai.classList.toggle('hidden', provider !== 'openai-compatible');
		els.panelOllama.classList.toggle('hidden', provider !== 'ollama');
		els.panelLmstudio.classList.toggle('hidden', provider !== 'lmstudio');
	}

	function renderHistory() {
		const activeId = state.session?.id;
		els.historyList.innerHTML = (state.sessions || []).map(s => `
			<div class="history-item ${s.id === activeId ? 'active' : ''}" data-select-session="${escapeHtml(s.id)}">
				<div class="history-meta">
					<div class="history-title">${escapeHtml(s.title)}</div>
					<div class="history-sub">${escapeHtml(s.mode.toUpperCase())} · ${s.turnCount} msg${s.turnCount === 1 ? '' : 's'}</div>
				</div>
				<button class="icon-btn" data-delete-session="${escapeHtml(s.id)}" title="Delete">✕</button>
			</div>
		`).join('');
	}

	function toggleDrawer(drawerName) {
		const map = {
			settings: els.drawerSettings,
			history: els.drawerHistory,
			agents: els.drawerAgents,
			notepads: els.drawerNotepads,
		};
		for (const [k, el] of Object.entries(map)) {
			if (k === drawerName) {
				el.classList.toggle('hidden');
			} else {
				el.classList.add('hidden');
			}
		}
		if (drawerName === 'settings' && !els.drawerSettings.classList.contains('hidden')) {
			syncSettingsForm();
		} else if (drawerName === 'history' && !els.drawerHistory.classList.contains('hidden')) {
			renderHistory();
		} else if (drawerName === 'agents' && !els.drawerAgents.classList.contains('hidden')) {
			renderWorktrees();
		} else if (drawerName === 'notepads' && !els.drawerNotepads.classList.contains('hidden')) {
			renderNotepads();
		}
	}

	function sendCurrentPrompt() {
		const text = els.promptInput.value.trim();
		if ((!text && state.images.length === 0) || state.isStreaming) {
			return;
		}
		const mode = state.session?.mode || 'agent';
		vscode.postMessage({
			type: 'sendPrompt',
			text,
			mode,
			chips: state.chips,
			images: state.images,
		});
		els.promptInput.value = '';
		state.chips = [];
		state.images = [];
		renderChips();
		renderImages();
		hidePopup();
	}

	function hidePopup() {
		els.mentionPopup.classList.add('hidden');
		state.popupItems = [];
		state.popupKind = null;
	}

	function renderPopup() {
		if (!state.popupItems.length) {
			hidePopup();
			return;
		}
		els.mentionPopup.classList.remove('hidden');
		if (state.popupKind === 'slash') {
			els.mentionPopup.innerHTML = state.popupItems.map((item, idx) => `
				<div class="mention-item ${idx === state.popupIndex ? 'selected' : ''}" data-popup-idx="${idx}">
					<span>/${escapeHtml(item.name)}</span>
					<span class="mention-detail">${escapeHtml(item.description)}</span>
				</div>
			`).join('');
		} else {
			els.mentionPopup.innerHTML = state.popupItems.map((item, idx) => `
				<div class="mention-item ${idx === state.popupIndex ? 'selected' : ''}" data-popup-idx="${idx}">
					<span>@${escapeHtml(item.label)}</span>
					<span class="mention-detail">${escapeHtml(item.detail || item.kind)}</span>
				</div>
			`).join('');
		}
	}

	function selectPopupItem(idx) {
		const item = state.popupItems[idx];
		if (!item) {
			return;
		}
		if (state.popupKind === 'slash') {
			els.promptInput.value = `/${item.name} `;
			hidePopup();
			els.promptInput.focus();
			return;
		}

		if (item.kind === 'docs') {
			els.promptInput.value = els.promptInput.value.replace(/@[^\s@]*$/, '');
			hidePopup();
			vscode.postMessage({ type: 'promptDocUrl' });
			return;
		}

		const chip = {
			id: `chip_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
			kind: item.kind,
			label: item.label,
			detail: item.detail,
			filePath: item.filePath,
			notepadId: item.notepadId,
		};
		if (!state.chips.some(c => c.kind === chip.kind && c.filePath === chip.filePath && c.label === chip.label)) {
			state.chips.push(chip);
			renderChips();
		}
		els.promptInput.value = els.promptInput.value.replace(/@[^\s@]*$/, '');
		hidePopup();
		els.promptInput.focus();
	}

	// Event Listeners
	document.querySelectorAll('.mode-tab').forEach(btn => {
		btn.addEventListener('click', () => vscode.postMessage({ type: 'setMode', mode: btn.dataset.mode }));
	});

	els.btnNew.addEventListener('click', () => { toggleDrawer(null); vscode.postMessage({ type: 'newChat' }); });
	els.btnAgents.addEventListener('click', () => toggleDrawer('agents'));
	els.btnNotepads.addEventListener('click', () => toggleDrawer('notepads'));
	els.btnHistory.addEventListener('click', () => toggleDrawer('history'));
	els.btnSettings.addEventListener('click', () => toggleDrawer('settings'));
	document.querySelectorAll('.drawer-close').forEach(btn => btn.addEventListener('click', () => toggleDrawer(null)));

	els.btnAddContext.addEventListener('click', () => vscode.postMessage({ type: 'queryMentions', query: '' }));
	els.btnSlash.addEventListener('click', () => vscode.postMessage({ type: 'querySlashCommands', query: '' }));
	els.btnAttachImg.addEventListener('click', () => els.imgFileInput.click());
	els.imgFileInput.addEventListener('change', () => {
		if (els.imgFileInput.files) {
			readFilesAsImages(els.imgFileInput.files);
			els.imgFileInput.value = '';
		}
	});
	els.btnCompact.addEventListener('click', () => vscode.postMessage({ type: 'compactChat' }));

	els.btnReviewNext.addEventListener('click', () => vscode.postMessage({ type: 'reviewNextFile' }));
	els.btnReviewKeep.addEventListener('click', () => vscode.postMessage({ type: 'reviewKeepAll' }));
	els.btnReviewUndo.addEventListener('click', () => vscode.postMessage({ type: 'reviewUndoAll' }));

	els.btnSend.addEventListener('click', sendCurrentPrompt);
	els.btnStop.addEventListener('click', () => vscode.postMessage({ type: 'stop' }));

	// Paste screenshot directly into chat input
	els.promptInput.addEventListener('paste', e => {
		const items = e.clipboardData?.items;
		if (!items) {
			return;
		}
		const files = [];
		for (const item of items) {
			if (item.kind === 'file' && item.type.startsWith('image/')) {
				const f = item.getAsFile();
				if (f) {
					files.push(f);
				}
			}
		}
		if (files.length > 0) {
			readFilesAsImages(files);
		}
	});

	els.modelPicker.addEventListener('change', () => {
		if (!state.settings) {
			return;
		}
		const val = els.modelPicker.value;
		const p = state.settings.provider;
		const update = p === 'ollama' ? { ollamaModel: val } : p === 'lmstudio' ? { lmstudioModel: val } : { openaiModel: val };
		vscode.postMessage({ type: 'updateSettings', settings: update });
	});

	els.setProvider.addEventListener('change', () => updateProviderSections(els.setProvider.value));

	els.presetGrid.addEventListener('click', e => {
		const btn = e.target.closest('[data-preset]');
		if (!btn) {
			return;
		}
		const preset = state.presets.find(p => p.id === btn.dataset.preset);
		if (!preset) {
			return;
		}
		els.setProvider.value = preset.provider;
		updateProviderSections(preset.provider);
		if (preset.provider === 'openai-compatible') {
			els.setOpenaiUrl.value = preset.baseUrl;
			els.setOpenaiModel.value = preset.defaultModel;
		} else if (preset.provider === 'ollama') {
			els.setOllamaUrl.value = preset.baseUrl;
			if (!els.setOllamaModel.value) {
				els.setOllamaModel.value = preset.defaultModel;
			}
		} else if (preset.provider === 'lmstudio') {
			els.setLmstudioUrl.value = preset.baseUrl;
		}
	});

	function collectSettingsPayload() {
		const parseList = val => val.split(',').map(s => s.trim()).filter(Boolean);
		const payload = {
			provider: els.setProvider.value,
			openaiBaseUrl: els.setOpenaiUrl.value.trim(),
			openaiModel: els.setOpenaiModel.value.trim(),
			ollamaBaseUrl: els.setOllamaUrl.value.trim(),
			ollamaModel: els.setOllamaModel.value.trim(),
			lmstudioBaseUrl: els.setLmstudioUrl.value.trim(),
			lmstudioModel: els.setLmstudioModel.value.trim(),
			tabEnabled: els.setTabEnabled.checked,
			nesEnabled: els.setNesEnabled.checked,
			tabProvider: els.setTabProvider.value,
			tabModel: els.setTabModel.value.trim(),
			embeddingModel: els.setEmbedModel.value.trim(),
			autoApproveWrites: els.setAutoWrites.checked,
			autoApproveTerminal: els.setAutoTerminal.checked,
			respectIgnoreFiles: els.setRespectIgnore.checked,
			commandAllowlist: parseList(els.setAllowlist.value),
			commandDenylist: parseList(els.setDenylist.value),
			systemPrompt: els.setSysPrompt.value,
		};
		if (els.setOpenaiKey.value.trim()) {
			payload.apiKey = els.setOpenaiKey.value.trim();
		}
		return payload;
	}

	els.btnSaveSettings.addEventListener('click', () => {
		vscode.postMessage({ type: 'updateSettings', settings: collectSettingsPayload() });
		els.setOpenaiKey.value = '';
		els.connStatus.textContent = 'Settings saved';
		els.connStatus.className = 'conn-status ok';
		setTimeout(() => toggleDrawer(null), 400);
	});

	els.btnTestConn.addEventListener('click', () => {
		els.connStatus.textContent = 'Testing...';
		els.connStatus.className = 'conn-status';
		vscode.postMessage({ type: 'updateSettings', settings: collectSettingsPayload() });
		vscode.postMessage({ type: 'testProvider', provider: els.setProvider.value });
	});

	els.btnRebuildIndex.addEventListener('click', () => {
		vscode.postMessage({ type: 'updateSettings', settings: collectSettingsPayload() });
		vscode.postMessage({ type: 'rebuildIndex' });
	});

	els.btnReloadMcp.addEventListener('click', () => vscode.postMessage({ type: 'reloadMcp' }));
	els.btnEditMcp.addEventListener('click', () => vscode.postMessage({ type: 'editMcpConfig' }));

	els.btnSpawnWt.addEventListener('click', () => {
		const prompt = els.wtPrompt.value.trim();
		if (!prompt) {
			return;
		}
		els.wtPrompt.value = '';
		vscode.postMessage({ type: 'spawnWorktree', prompt });
	});

	els.wtList.addEventListener('click', e => {
		const btn = e.target.closest('button');
		if (!btn) {
			return;
		}
		if (btn.dataset.mergeWt) {
			vscode.postMessage({ type: 'mergeWorktree', taskId: btn.dataset.mergeWt });
		} else if (btn.dataset.openWt) {
			vscode.postMessage({ type: 'openWorktree', taskId: btn.dataset.openWt });
		} else if (btn.dataset.discardWt) {
			vscode.postMessage({ type: 'discardWorktree', taskId: btn.dataset.discardWt });
		}
	});

	els.btnSaveNp.addEventListener('click', () => {
		const title = els.npTitle.value.trim();
		const content = els.npContent.value.trim();
		if (!title && !content) {
			return;
		}
		vscode.postMessage({ type: 'saveNotepad', id: state.editingNotepadId, title: title || 'Untitled Note', content });
		state.editingNotepadId = null;
		els.npTitle.value = '';
		els.npContent.value = '';
	});

	els.npList.addEventListener('click', e => {
		const btn = e.target.closest('button');
		if (!btn) {
			return;
		}
		if (btn.dataset.delNp) {
			vscode.postMessage({ type: 'deleteNotepad', id: btn.dataset.delNp });
		} else if (btn.dataset.editNp) {
			const np = state.notepads.find(n => n.id === btn.dataset.editNp);
			if (np) {
				state.editingNotepadId = np.id;
				els.npTitle.value = np.title;
				els.npContent.value = np.content;
			}
		} else if (btn.dataset.attachNp) {
			const np = state.notepads.find(n => n.id === btn.dataset.attachNp);
			if (np) {
				state.chips.push({
					id: `npchip_${Date.now()}`,
					kind: 'notepad',
					label: `notepad:${np.title}`,
					detail: np.content.slice(0, 60),
					notepadId: np.id,
				});
				renderChips();
				toggleDrawer(null);
				els.promptInput.focus();
			}
		}
	});

	els.promptInput.addEventListener('input', () => {
		const val = els.promptInput.value;
		const slashMatch = /^\/([a-zA-Z0-9_-]*)$/.exec(val);
		if (slashMatch) {
			vscode.postMessage({ type: 'querySlashCommands', query: slashMatch[1] });
			return;
		}
		const mentionMatch = /(?:^|\s)@([^\s@]*)$/.exec(val);
		if (mentionMatch) {
			vscode.postMessage({ type: 'queryMentions', query: mentionMatch[1] });
		} else {
			hidePopup();
		}
	});

	els.promptInput.addEventListener('keydown', e => {
		if (!els.mentionPopup.classList.contains('hidden')) {
			if (e.key === 'ArrowDown') {
				e.preventDefault();
				state.popupIndex = (state.popupIndex + 1) % state.popupItems.length;
				renderPopup();
				return;
			}
			if (e.key === 'ArrowUp') {
				e.preventDefault();
				state.popupIndex = (state.popupIndex - 1 + state.popupItems.length) % state.popupItems.length;
				renderPopup();
				return;
			}
			if (e.key === 'Enter' || e.key === 'Tab') {
				e.preventDefault();
				selectPopupItem(state.popupIndex);
				return;
			}
			if (e.key === 'Escape') {
				e.preventDefault();
				hidePopup();
				return;
			}
		}
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			sendCurrentPrompt();
		}
	});

	els.mentionPopup.addEventListener('click', e => {
		const item = e.target.closest('[data-popup-idx]');
		if (item) {
			selectPopupItem(Number(item.dataset.popupIdx));
		}
	});

	els.chipsRow.addEventListener('click', e => {
		const btn = e.target.closest('[data-remove-chip]');
		if (btn) {
			state.chips = state.chips.filter(c => c.id !== btn.dataset.removeChip);
			renderChips();
		}
	});

	els.imagesRow.addEventListener('click', e => {
		const btn = e.target.closest('[data-remove-img]');
		if (btn) {
			state.images = state.images.filter(i => i.id !== btn.dataset.removeImg);
			renderImages();
		}
	});

	els.historyList.addEventListener('click', e => {
		const delBtn = e.target.closest('[data-delete-session]');
		if (delBtn) {
			e.stopPropagation();
			vscode.postMessage({ type: 'deleteSession', sessionId: delBtn.dataset.deleteSession });
			return;
		}
		const row = e.target.closest('[data-select-session]');
		if (row) {
			vscode.postMessage({ type: 'selectSession', sessionId: row.dataset.selectSession });
			toggleDrawer(null);
		}
	});

	els.messages.addEventListener('click', e => {
		const target = e.target.closest('button');
		if (!target) {
			return;
		}
		if (target.dataset.openDrawer) {
			toggleDrawer(target.dataset.openDrawer);
		} else if (target.dataset.quick) {
			els.promptInput.value = target.dataset.quick;
			sendCurrentPrompt();
		} else if (target.dataset.openDiff) {
			vscode.postMessage({ type: 'openDiff', editId: target.dataset.openDiff });
		} else if (target.dataset.revertEdit) {
			vscode.postMessage({ type: 'revertEdit', editId: target.dataset.revertEdit });
		} else if (target.dataset.restoreCp) {
			vscode.postMessage({ type: 'restoreCheckpoint', checkpointId: target.dataset.restoreCp });
		} else if (target.dataset.approve) {
			vscode.postMessage({ type: 'approvalDecision', toolCallId: target.dataset.approve, approved: true });
		} else if (target.dataset.deny) {
			vscode.postMessage({ type: 'approvalDecision', toolCallId: target.dataset.deny, approved: false });
		} else if (target.dataset.moveTerminal) {
			vscode.postMessage({ type: 'moveToTerminal', command: decodeURIComponent(target.dataset.moveTerminal) });
		} else if (target.dataset.approvePlan) {
			vscode.postMessage({ type: 'approveArtifactPlan', artifactId: target.dataset.approvePlan });
		} else if (target.dataset.openArtifact) {
			vscode.postMessage({ type: 'openArtifactMarkdown', markdown: decodeURIComponent(target.dataset.openArtifact) });
		} else if (target.dataset.copyCode) {
			navigator.clipboard?.writeText(decodeURIComponent(target.dataset.copyCode));
			target.textContent = 'Copied';
			setTimeout(() => { target.textContent = 'Copy'; }, 1200);
		} else if (target.dataset.applyCode) {
			vscode.postMessage({ type: 'applyCodeBlock', code: decodeURIComponent(target.dataset.applyCode) });
		}
	});

	window.addEventListener('message', event => {
		const msg = event.data;
		if (!msg) {
			return;
		}
		switch (msg.type) {
			case 'state':
				state.settings = msg.settings;
				state.presets = msg.presets || [];
				state.discoveredModels = msg.discoveredModels || {};
				state.session = msg.session;
				state.sessions = msg.sessions || [];
				state.activeFile = msg.activeFile;
				state.isStreaming = Boolean(msg.isStreaming);
				state.tokenEstimate = msg.tokenEstimate || 0;
				state.pendingEdits = msg.pendingEdits || [];
				state.notepads = msg.notepads || [];
				state.mcpServers = msg.mcpServers || [];
				state.vectorStatus = msg.vectorStatus || null;
				state.worktreeTasks = msg.worktreeTasks || [];
				syncModeTabs();
				syncStreamingUi();
				syncModelPicker();
				syncReviewBar();
				syncTokenMeter();
				renderMessages();
				if (!els.drawerHistory.classList.contains('hidden')) {
					renderHistory();
				}
				if (!els.drawerSettings.classList.contains('hidden')) {
					syncSettingsForm();
				}
				if (!els.drawerAgents.classList.contains('hidden')) {
					renderWorktrees();
				}
				if (!els.drawerNotepads.classList.contains('hidden')) {
					renderNotepads();
				}
				break;

			case 'turnUpdate':
				if (state.session && msg.turn) {
					const idx = state.session.turns.findIndex(t => t.id === msg.turn.id);
					if (idx !== -1) {
						state.session.turns[idx] = msg.turn;
					} else {
						state.session.turns.push(msg.turn);
					}
					renderMessages();
				}
				break;

			case 'streaming':
				state.isStreaming = Boolean(msg.value);
				syncStreamingUi();
				break;

			case 'openDrawer':
				toggleDrawer(msg.drawer);
				break;

			case 'focusInput':
				toggleDrawer(null);
				els.promptInput.focus();
				break;

			case 'attachChip':
				if (msg.chip && !state.chips.some(c => c.id === msg.chip.id)) {
					state.chips.push(msg.chip);
					renderChips();
				}
				break;

			case 'prefillPrompt':
				els.promptInput.value = msg.text || '';
				if (msg.autoSend) {
					sendCurrentPrompt();
				} else {
					els.promptInput.focus();
				}
				break;

			case 'mentionResults':
				state.popupKind = 'mention';
				state.popupItems = msg.items || [];
				state.popupIndex = 0;
				renderPopup();
				break;

			case 'slashResults':
				state.popupKind = 'slash';
				state.popupItems = msg.items || [];
				state.popupIndex = 0;
				renderPopup();
				break;

			case 'providerTestResult':
				if (!msg.silent) {
					els.connStatus.textContent = msg.message || (msg.ok ? 'Connected' : 'Failed');
					els.connStatus.className = `conn-status ${msg.ok ? 'ok' : 'err'}`;
				}
				if (msg.ok && msg.provider) {
					state.discoveredModels[msg.provider] = msg.models || [];
					syncModelPicker();
					syncSettingsForm();
				}
				break;
		}
	});

	vscode.postMessage({ type: 'ready' });
})();
