import { App, Modal, Notice, Setting, setIcon } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { t } from '../../i18n';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as safeFs from '../../core/security/safeFs';
import { spawnAllowedSync } from '../../core/security/spawnAllowlist';
import { ENV_APPDATA, readEnv } from '../../util/envKeys';
import { addSectionHeading } from './utils';
import {
    isLocalHostname,
    isPrivateIpHostname,
    validateProviderUrl,
} from '../../api/providers/providerUrlGuard';

export class McpTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    build(containerEl: HTMLElement): void {
        // One intro banner for the page
        const intro = containerEl.createDiv('vault-op-box vault-op-box--intro');
        const introIcon = intro.createSpan({ cls: 'vault-op-box__icon' });
        setIcon(introIcon, 'link');
        const introText = intro.createDiv({ cls: 'vault-op-box__text' });
        introText.createEl('strong', { text: '连接' });

        introText.createDiv({ text: '将 Vault Operator 连接到 Claude 等 AI 助手，或接入外部工具服务器来扩展能力。所有连接都使用开放的 MCP 标准。' });

        this.buildConnectorSection(containerEl);
        this.buildExternalServersSection(containerEl);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Connectors
    // ─────────────────────────────────────────────────────────────────────────

    private buildConnectorSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            '连接器',
            { body: '让外部 AI 助手（Claude Desktop、Claude Code、ChatGPT Desktop）通过 Vault Operator 读写你的知识库。请先在这里启用连接器，然后用本页生成的配置连接对应助手。' },
        );

        // ── Claude Desktop / Claude Code ──────────────────────────────────
        containerEl.createEl('h4', { text: '本地连接器' });

        const mcpBridge = this.plugin.mcpBridge;
        const isEnabled = this.plugin.settings.enableMcpServer ?? false;

        new Setting(containerEl)
            .setName('启用本地连接器')
            .setDesc('连接工作时 Obsidian 必须保持运行。')
            .addToggle((toggle) =>
                toggle.setValue(isEnabled).onChange(async (v) => {
                    this.plugin.settings.enableMcpServer = v;
                    await this.plugin.saveSettings();
                    if (v && !this.plugin.mcpBridge) {
                        const { McpBridge } = await import('../../mcp/McpBridge');
                        this.plugin.mcpBridge = new McpBridge(this.plugin);
                        void this.plugin.mcpBridge.start().catch((e: unknown) =>
                            console.warn('[McpTab] Start failed:', e)
                        );
                    } else if (!v && this.plugin.mcpBridge) {
                        this.plugin.mcpBridge.stop();
                        this.plugin.mcpBridge = null;
                    }
                    this.rerender();
                }),
            );

        if (isEnabled) {
            let targetClient: 'claude' | 'codex' | 'workbuddy' | 'traeCn' = 'claude';
            new Setting(containerEl)
                .setName('写入客户端配置')
                .setDesc('选择目标平台并写入 Vault Operator MCP 配置。完成后请重启对应客户端。')
                .addDropdown((dropdown) => {
                    dropdown.addOptions({
                        claude: 'Claude Desktop',
                        codex: 'Codex',
                        workbuddy: 'WorkBuddy',
                        traeCn: 'TRAE Work CN',
                    });
                    dropdown.setValue(targetClient);
                    dropdown.onChange((value) => {
                        targetClient = value as typeof targetClient;
                    });
                })
                .addButton((btn) => {
                    btn.setButtonText('写入配置').onClick(() => {
                        this.writeClientConfig(targetClient);
                    });
                });

            this.buildLocalMcpInfo(containerEl);
        }

        // ── Remote access ─────────────────────────────────────────────────
        containerEl.createEl('h4', { text: '远程访问' });

        const remoteEnabled = this.plugin.settings.enableRemoteRelay ?? false;
        const remoteConnected = (mcpBridge as { remoteConnected?: boolean })?.remoteConnected ?? false;

        new Setting(containerEl)
            .setName('启用远程访问')
            .setDesc('连接到中继服务器，让任意设备上的 AI 助手都能访问你的知识库。')
            .addToggle((toggle) =>
                toggle.setValue(remoteEnabled).onChange(async (v) => {
                    this.plugin.settings.enableRemoteRelay = v;
                    await this.plugin.saveSettings();
                    if (v && this.plugin.mcpBridge && this.plugin.settings.relayUrl) {
                        void this.plugin.mcpBridge.connectRelay();
                    } else if (!v) {
                        this.plugin.mcpBridge?.disconnectRelay();
                    }
                    this.rerender();
                }),
            );

        if (remoteEnabled) {
            const hasRelay = !!this.plugin.settings.relayUrl;

            if (!hasRelay) {
                // ── Info banner: setup flow ───────────────────────────────
                const remoteInfo = containerEl.createDiv('vault-op-box vault-op-box--intro');
                const remoteInfoIcon = remoteInfo.createSpan({ cls: 'vault-op-box__icon' });
                setIcon(remoteInfoIcon, 'globe');
                const remoteInfoText = remoteInfo.createDiv({ cls: 'vault-op-box__text' });
                remoteInfoText.createDiv({ text: '部署在你自己 Cloudflare 账号中的中继服务器，可以让任意设备上的 AI 助手连接到你的知识库。数据仍保留在你的基础设施中。' });
                const steps = remoteInfoText.createEl('ol');

                steps.createEl('li').createEl('a', {
                    text: '在 cloudflare.com 创建免费账号',
                    href: 'https://dash.cloudflare.com/sign-up',
                });
                const step2 = steps.createEl('li');
                step2.appendText('前往 ');

                step2.createEl('a', {
                    text: 'API 令牌',
                    href: 'https://dash.cloudflare.com/profile/api-tokens',
                });
                step2.appendText(' 并点击“Create Token”。');
                const step3 = steps.createEl('li');

                step3.appendText('滚动到底部并点击“Create Custom Token”。添加两个权限：Account / Workers Scripts / Edit 和 Account / Account Settings / Read。在“Account Resources”下选择“All accounts”。移除“Zone Resources”。');
                steps.createEl('li', { text: '点击“continue to summary”，然后点击“create token”。复制令牌并粘贴到下方。' });

                // ── API Token + Deploy ────────────────────────────────────
                new Setting(containerEl)

                    .setName('Cloudflare API 令牌')
                    .setDesc('粘贴你在上面第 2 步创建的令牌。')
                    .addText((text) => {
                        text.setValue(this.plugin.settings.cloudflareApiToken ?? '');
                        text.setPlaceholder('粘贴你的 API 令牌');
                        text.inputEl.type = 'password';
                        text.onChange(async (v) => {
                            this.plugin.settings.cloudflareApiToken = v.trim();
                            await this.plugin.saveSettings();
                        });
                    });

                // Deploy button
                const deploySetting = new Setting(containerEl)
                    .setName('部署中继服务器')
                    .setDesc('将中继部署到你的账号。大约需要 10 秒。');

                const deployStatusEl = containerEl.createDiv('setting-item-description');

                deploySetting.addButton((btn) => {
                    btn.setButtonText('部署').onClick(async () => {
                        const apiToken = this.plugin.settings.cloudflareApiToken;
                        if (!apiToken) {
                            new Notice('请先输入你的 API 令牌。');
                            return;
                        }

                        btn.setDisabled(true);
                        btn.setButtonText('正在部署...');

                        try {
                            const { CloudflareDeployer } = await import('../../mcp/CloudflareDeployer');
                            const deployer = new CloudflareDeployer(apiToken);

                            // Reuse existing token if available, otherwise generate new one
                            // AUDIT-007 L-1: Use relay_ prefix instead of sk- to avoid confusion with API keys
                            const relayToken = this.plugin.settings.relayToken
                                || ('relay_' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
                                    .map(b => b.toString(16).padStart(2, '0')).join(''));

                            const result = await deployer.deploy(relayToken, (step) => {
                                deployStatusEl.setText(step);
                            });

                            // Save results
                            this.plugin.settings.relayUrl = result.url;
                            this.plugin.settings.relayToken = relayToken;
                            this.plugin.settings.cloudflareAccountId = result.accountId;
                            await this.plugin.saveSettings();

                            // Connect immediately
                            if (this.plugin.mcpBridge) {
                                void this.plugin.mcpBridge.connectRelay();
                            }

                            new Notice('中继已部署！请将该 URL 作为连接器添加到你的 AI 助手中。');
                            this.rerender();
                        } catch (e) {
                            const msg = e instanceof Error ? e.message : String(e);
                            deployStatusEl.setText(`部署失败： ${msg}`);
                            new Notice(`部署失败： ${msg}`);
                            btn.setDisabled(false);
                            btn.setButtonText('部署');
                        }
                    });
                });
            } else {
                // ── Already deployed ────────────────────────────────────────
                const baseUrl = this.plugin.settings.relayUrl.replace(/\/$/, '');
                const token = this.plugin.settings.relayToken;
                const mcpUrl = `${baseUrl}/${token}/mcp`;

                new Setting(containerEl)
                    .setName('连接器 URL')
                    .setDesc('在你的 AI 助手中使用这个 URL。它包含认证令牌，请不要分享。')
                    .addButton((btn) => {
                        btn.setButtonText('复制 URL').onClick(() => {
                            void navigator.clipboard.writeText(mcpUrl);
                            new Notice('URL 已复制');
                        });
                    });

                new Setting(containerEl)
                    .setName(remoteConnected ? '已连接' : '连接')
                    .setDesc(remoteConnected
                        ? '中继已连接。你的知识库现在可以远程访问。'
                        : '点击连接到你的中继服务器。')
                    .addButton((btn) => {
                        btn.setButtonText(remoteConnected ? '断开' : '连接').onClick(() => {
                            if (remoteConnected) {
                                this.plugin.mcpBridge?.disconnectRelay();
                            } else if (this.plugin.mcpBridge) {
                                void this.plugin.mcpBridge.connectRelay();
                            }
                            window.setTimeout(() => this.rerender(), 1000);
                        });
                    });

                // Usage instructions
                const usage = containerEl.createDiv('agent-settings-desc');
                usage.createEl('strong', { text: '将上面的 URL 作为连接器添加到你的 AI 助手中：' });
                const usageList = usage.createEl('ul');
                usageList.createEl('li', { text: '网页客户端：在设置中添加自定义连接器' });
                usageList.createEl('li', { text: '桌面客户端：在设置中添加远程服务器' });

                // Troubleshooting hint
                const troubleshoot = containerEl.createDiv('setting-item-description');
                troubleshoot.appendText('无法使用？请确认 Obsidian 正在运行，并且上方开关已启用。连接器 URL 在重启后不会改变。');
                troubleshoot.createEl('a', {
                    text: '故障排查指南',
                    href: 'https://pssah4.github.io/vault-operator/guides/connectors',
                });

                // Redeploy + Reset
                const redeployStatusEl = containerEl.createDiv('setting-item-description');

                new Setting(containerEl)
                    .setName('更新中继服务器')
                    .setDesc('将最新的中继代码推送到你的账号。连接器 URL 会保持不变。')
                    .addButton((btn) => {
                        btn.setButtonText('重新部署').onClick(async () => {
                            const apiToken = this.plugin.settings.cloudflareApiToken;
                            const accountId = this.plugin.settings.cloudflareAccountId;
                            const relayToken = this.plugin.settings.relayToken;
                            if (!apiToken || !accountId) {
                                new Notice('缺少 API 令牌或账号 ID。请尝试重置后重新部署。');
                                return;
                            }
                            btn.setDisabled(true);
                            btn.setButtonText('正在更新...');
                            try {
                                const { CloudflareDeployer } = await import('../../mcp/CloudflareDeployer');
                                const deployer = new CloudflareDeployer(apiToken);
                                await deployer.redeploy(accountId, relayToken, (step) => {
                                    redeployStatusEl.setText(step);
                                });
                                new Notice('中继已更新。');
                                btn.setDisabled(false);
                                btn.setButtonText('重新部署');
                            } catch (e) {
                                const msg = e instanceof Error ? e.message : String(e);
                                redeployStatusEl.setText(`更新失败： ${msg}`);
                                new Notice(`更新失败： ${msg}`);
                                btn.setDisabled(false);
                                btn.setButtonText('重新部署');
                            }
                        });
                    });

                new Setting(containerEl)
                    .setName('重置中继')
                    .setDesc('移除中继配置。重新部署后，你需要在 AI 助手中更新连接器 URL。')
                    .addButton((btn) => {
                        btn.setButtonText('重置').onClick(async () => {
                            this.plugin.mcpBridge?.disconnectRelay();
                            this.plugin.settings.relayUrl = '';
                            this.plugin.settings.relayToken = '';
                            this.plugin.settings.cloudflareAccountId = '';
                            await this.plugin.saveSettings();
                            this.rerender();
                        });
                    });
            }
        }
    }

    private addCopyableConfigBlock(containerEl: HTMLElement, title: string, code: string, notice: string): void {
        const block = containerEl.createDiv({ cls: 'agent-settings-desc' });
        const header = block.createDiv();
        const label = header.createEl('strong', { text: title });
        const copyBtn = header.createEl('button', { text: '复制' });
        label.style.marginRight = '8px';
        copyBtn.addEventListener('click', () => this.copyText(code, notice));

        const pre = block.createEl('pre');
        pre.style.whiteSpace = 'pre-wrap';
        pre.style.userSelect = 'text';
        pre.style.overflowX = 'auto';
        pre.createEl('code', { text: code });
    }

    private buildLocalMcpInfo(containerEl: HTMLElement): void {
        const mcpUrl = this.getLocalMcpUrl();
        const token = this.readMcpToken();
        const tokenPath = this.getMcpTokenPath();
        const displayedToken = token || '<token 尚未生成：请先开启本地连接器>';
        const bearer = `Bearer ${displayedToken}`;
        const httpJson = JSON.stringify(this.getHttpMcpConfig(), null, 2);
        const stdioJson = JSON.stringify(this.getStdioMcpConfig(), null, 2);
        const codexToml = this.getCodexTomlSnippet();

        const info = containerEl.createDiv({ cls: 'agent-settings-desc' });
        info.createEl('strong', { text: '本地 MCP 连接信息' });
        info.createDiv({
            text: '地址和 Token 用于 HTTP MCP 客户端。Claude、WorkBuddy、TRAE、Codex 通常使用 stdio 代理，代理会自动读取 Token，因此配置里不需要手填地址和 Token。Token 等同本地访问密码，请勿分享。',
        });

        const list = info.createEl('ul');
        list.createEl('li', { text: `MCP 地址：${mcpUrl}` });
        list.createEl('li', { text: `Token：${displayedToken}` });
        list.createEl('li', { text: `Token 文件：${tokenPath}` });
        list.createEl('li', { text: `Authorization Header：${bearer}` });

        const actions = info.createDiv();
        const copyUrl = actions.createEl('button', { text: '复制地址' });
        const copyToken = actions.createEl('button', { text: '复制 Token' });
        const copyHeader = actions.createEl('button', { text: '复制 Header' });
        copyUrl.style.marginRight = '8px';
        copyToken.style.marginRight = '8px';
        copyUrl.addEventListener('click', () => this.copyText(mcpUrl, 'MCP 地址已复制'));
        copyToken.addEventListener('click', () => this.copyText(token, token ? 'Token 已复制' : 'Token 尚未生成'));
        copyHeader.addEventListener('click', () => this.copyText(`Authorization: ${bearer}`, 'Header 已复制'));

        this.addCopyableConfigBlock(containerEl, 'HTTP MCP JSON（支持 Bearer Header 的客户端）', httpJson, 'HTTP MCP JSON 已复制');
        this.addCopyableConfigBlock(containerEl, 'stdio 代理 JSON（Claude / WorkBuddy / TRAE 常用）', stdioJson, 'stdio JSON 已复制');
        this.addCopyableConfigBlock(containerEl, 'Codex TOML', codexToml, 'Codex TOML 已复制');
    }

    private getLocalMcpUrl(): string {
        const port = (this.plugin.mcpBridge as { port?: number } | null)?.port ?? 27182;
        return `http://127.0.0.1:${port}`;
    }

    private getMcpTokenPath(): string {
        return path.join(os.homedir(), '.obsidian-agent', 'mcp-token');
    }

    private readMcpToken(): string {
        try {
            const settingsToken = this.plugin.settings.mcpServerToken;
            if (settingsToken) return settingsToken;
            return fs.readFileSync(this.getMcpTokenPath(), 'utf-8').trim();
        } catch {
            return '';
        }
    }

    private copyText(text: string, notice: string): void {
        void navigator.clipboard.writeText(text).then(
            () => new Notice(notice),
            (e: unknown) => new Notice(`复制失败：${e instanceof Error ? e.message : String(e)}`),
        );
    }

    private getProxyMcpConfig(): { command: string; args: string[] } {
        return {
            command: this.findNodePath(),
            args: [this.getWorkerPath()],
        };
    }

    private getHttpMcpConfig(): Record<string, unknown> {
        const token = this.readMcpToken() || '<token>';
        return {
            mcpServers: {
                vault_operator: {
                    type: 'streamable-http',
                    url: this.getLocalMcpUrl(),
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                },
            },
        };
    }

    private getStdioMcpConfig(): Record<string, unknown> {
        return {
            mcpServers: {
                vault_operator: this.getProxyMcpConfig(),
            },
        };
    }

    private getCodexTomlSnippet(): string {
        const config = this.getProxyMcpConfig();
        return '[mcp_servers.vault_operator]\n'
            + `command = ${this.tomlString(config.command)}\n`
            + `args = [${config.args.map((arg) => this.tomlString(arg)).join(', ')}]\n`
            + 'startup_timeout_sec = 30\n';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // External tool servers
    // ─────────────────────────────────────────────────────────────────────────

    private buildExternalServersSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            '外部工具服务器',
            { body: '添加由其他人维护的 MCP 服务器（网页搜索、日历、GitHub、你自己的脚本等），让智能体可以把它们作为工具调用。每个服务器都作为独立进程运行，并与 Obsidian 隔离。' },
        );

        const mcpClient = this.plugin.mcpClient;
        const addBtn = containerEl.createEl('button', { text: t('settings.mcp.addServer'), cls: 'mod-cta agent-mcp-add-btn' });
        const listEl = containerEl.createDiv({ cls: 'agent-mcp-list' });

        const renderList = () => {
            listEl.empty();
            const servers = this.plugin.settings.mcpServers ?? {};
            const names = Object.keys(servers);
            if (names.length === 0) {
                listEl.createEl('p', { cls: 'agent-settings-desc', text: t('settings.mcp.empty') });
                return;
            }
            for (const name of names) {
                const config = servers[name];
                const conn = mcpClient?.getConnection(name);
                const status = conn?.status ?? 'disconnected';

                const row = listEl.createDiv({ cls: 'agent-mcp-server-row' });
                const dot = row.createSpan({ cls: `agent-mcp-status-dot ${status}` });
                dot.setAttribute('title', status === 'error' ? (conn?.error ?? 'error') : status);

                const info = row.createDiv({ cls: 'agent-mcp-server-info' });
                info.createSpan({ cls: 'agent-mcp-server-name', text: name });
                info.createSpan({ cls: 'agent-mcp-server-type', text: config.type });
                if (config.isBuiltIn) info.createSpan({ cls: 'agent-mcp-server-badge', text: '内置' });
                if (config.isBuiltIn && config.disabled && status !== 'connected') {
                    info.createSpan({ cls: 'agent-mcp-server-hint', text: t('settings.mcp.builtInDisabledHint') });
                } else if (status === 'error' && conn?.error) {
                    info.createSpan({ cls: 'agent-mcp-server-error', text: conn.error });
                } else if (status === 'connected') {
                    info.createSpan({ cls: 'agent-mcp-server-tools', text: t('settings.mcp.toolCount', { count: conn?.tools.length ?? 0 }) });
                }

                const actions = row.createDiv({ cls: 'agent-rules-actions' });
                if (status === 'connected') {
                    const btn = actions.createEl('button', { text: t('settings.mcp.disconnect') });
                    btn.addEventListener('click', () => { void (async () => { await mcpClient?.disconnect(name); renderList(); })(); });
                } else if (status !== 'connecting') {
                    const btn = actions.createEl('button', { text: status === 'error' ? t('settings.mcp.retry') : t('settings.mcp.connect') });
                    btn.addEventListener('click', () => { void (async () => { if (mcpClient) { await mcpClient.connect(name, config); renderList(); } })(); });
                }
                const editBtn = actions.createEl('button', { cls: 'agent-rules-edit-btn' });
                setIcon(editBtn, 'pencil');
                editBtn.setAttribute('aria-label', t('settings.mcp.edit'));
                editBtn.addEventListener('click', () => openAddModal(name, config));
                if (!config.isBuiltIn) {
                    const delBtn = actions.createEl('button', { cls: 'agent-rules-delete-btn' });
                    setIcon(delBtn, 'trash-2');
                    delBtn.setAttribute('aria-label', t('settings.mcp.delete'));
                    delBtn.addEventListener('click', () => { void (async () => { if (mcpClient) await mcpClient.disconnect(name); delete this.plugin.settings.mcpServers[name]; await this.plugin.saveSettings(); renderList(); })(); });
                }
            }
        };

        const openAddModal = (editName?: string, editConfig?: import('../../types/settings').McpServerConfig) => {
            const modal = new Modal(this.app);
            modal.titleEl.setText(editName ? t('settings.mcp.editServer', { name: editName }) : t('settings.mcp.addServerTitle'));
            const { contentEl } = modal;

            const nameInput = contentEl.createEl('input', { type: 'text', placeholder: t('settings.mcp.namePlaceholder'), cls: 'agent-mcp-modal-input' });
            nameInput.value = editName ?? '';
            if (editName) nameInput.disabled = true;

            const typeSelect = contentEl.createEl('select', { cls: 'agent-mcp-modal-input' });
            for (const opt of ['sse', 'streamable-http']) {
                const o = typeSelect.createEl('option', { text: opt, value: opt });
                if (opt === (editConfig?.type ?? 'sse')) o.selected = true;
            }

            contentEl.createEl('label', { text: t('settings.mcp.labelUrl') });
            const urlInput = contentEl.createEl('input', { type: 'text', placeholder: t('settings.mcp.urlPlaceholder'), cls: 'agent-mcp-modal-input' });
            urlInput.value = editConfig?.url ?? '';

            // AUDIT-034 M-14: per-server opt-in for the SSRF guard. When off
            // (default), saveBtn rejects loopback / RFC 1918 URLs with a Notice.
            let allowLocalUrls = editConfig?.allowLocalUrls === true;
            new Setting(contentEl)
                .setName('允许本地网络地址')
                .setDesc('允许此服务器连接到 localhost 或私有网络地址。云端托管的 MCP 服务器建议保持关闭。')
                .addToggle((toggle) =>
                    toggle.setValue(allowLocalUrls).onChange((v) => {
                        allowLocalUrls = v;
                    }),
                );

            contentEl.createEl('label', { text: t('settings.mcp.labelHeaders') });
            const headersInput = contentEl.createEl('textarea', { cls: 'agent-mcp-modal-input' });
            headersInput.rows = 3;
            headersInput.value = Object.entries(editConfig?.headers ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');

            contentEl.createEl('label', { text: t('settings.mcp.labelTimeout') });
            const timeoutInput = contentEl.createEl('input', { type: 'number', placeholder: t('settings.mcp.timeoutPlaceholder'), cls: 'agent-mcp-modal-input' });
            timeoutInput.value = String(editConfig?.timeout ?? 60);

            const saveBtn = contentEl.createEl('button', { text: t('settings.mcp.saveConnect'), cls: 'mod-cta agent-mcp-modal-save' });
            saveBtn.addEventListener('click', () => { void (async () => {
                const serverName = (editName ?? nameInput.value.trim());
                if (!serverName) return;
                const type = typeSelect.value as 'sse' | 'streamable-http';
                const trimmedUrl = urlInput.value.trim();

                // AUDIT-034 M-14: validate the URL against the SSRF guard
                // before persisting. The per-server allowLocalUrls toggle opts
                // out for loopback / RFC 1918 hosts; everything else stays
                // protected by validateProviderUrl + the explicit local check.
                if (trimmedUrl) {
                    try {
                        const parsed = validateProviderUrl('custom', trimmedUrl, {
                            allowLocalhost: allowLocalUrls,
                        });
                        if (parsed && !allowLocalUrls) {
                            const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
                            if (isLocalHostname(host) || isPrivateIpHostname(host)) {
                                new Notice(
                                    `URL "${parsed.host}" targets a local or private network. `
                                    + 'Enable "Allow local URLs" to permit loopback or RFC 1918 hosts.',
                                );
                                return;
                            }
                        }
                    } catch (e) {
                        const msg = e instanceof Error ? e.message : String(e);
                        new Notice(`Invalid MCP URL: ${msg}`);
                        return;
                    }
                }

                const parseKV = (text: string): Record<string, string> => {
                    const result: Record<string, string> = {};
                    for (const line of text.split('\n')) { const eqIdx = line.indexOf('='); if (eqIdx > 0) result[line.slice(0, eqIdx).trim()] = line.slice(eqIdx + 1).trim(); }
                    return result;
                };
                const newConfig: import('../../types/settings').McpServerConfig = {
                    type,
                    url: trimmedUrl,
                    headers: parseKV(headersInput.value),
                    timeout: parseInt(timeoutInput.value) || 60,
                    disabled: false,
                    ...(allowLocalUrls ? { allowLocalUrls: true } : {}),
                    ...(editConfig?.isBuiltIn ? { isBuiltIn: true } : {}),
                };
                this.plugin.settings.mcpServers ??= {};
                this.plugin.settings.mcpServers[serverName] = newConfig;
                await this.plugin.saveSettings();
                if (mcpClient) { await mcpClient.disconnect(serverName); await mcpClient.connect(serverName, newConfig); }
                modal.close();
                renderList();
            })(); });

            modal.open();
        };

        addBtn.addEventListener('click', () => openAddModal());
        renderList();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Client Config
    // ─────────────────────────────────────────────────────────────────────────

    private writeClientConfig(target: 'claude' | 'codex' | 'workbuddy' | 'traeCn'): void {
        if (target === 'codex') {
            this.writeCodexConfig();
        } else if (target === 'workbuddy') {
            this.writeWorkBuddyConfig();
        } else if (target === 'traeCn') {
            this.writeTraeCnConfig();
        } else {
            this.writeClaudeDesktopConfig();
        }
    }

    private readJsonFile(configPath: string): Record<string, unknown> {
        try {
            return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
        } catch {
            return {};
        }
    }

    private writeJsonMcpConfig(
        configPath: string,
        serverName: string,
        serverConfig: Record<string, unknown>,
        label: string,
    ): void {
        const configDir = path.dirname(configPath);
        const config = this.readJsonFile(configPath);
        const servers = (config['mcpServers'] ?? {}) as Record<string, unknown>;
        servers[serverName] = serverConfig;
        config['mcpServers'] = servers;

        fs.mkdirSync(configDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
        new Notice(`${label} 配置已保存：${configPath}。请重启对应客户端。`);
    }

    private writeClaudeDesktopConfig(): void {
        try {
            const platform = os.platform();
            let configDir: string;
            if (platform === 'darwin') configDir = path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
            else if (platform === 'win32') configDir = path.join(readEnv(ENV_APPDATA) ?? os.homedir(), 'Claude');
            else configDir = path.join(os.homedir(), '.config', 'Claude');

            const configPath = path.join(configDir, 'claude_desktop_config.json');
            this.writeJsonMcpConfig(configPath, 'Vault Operator', this.getProxyMcpConfig(), 'Claude Desktop');
        } catch (e) {
            new Notice(`失败： ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private writeWorkBuddyConfig(): void {
        try {
            const configPath = path.join(os.homedir(), '.workbuddy', 'mcp.json');
            this.writeJsonMcpConfig(configPath, 'vault_operator', this.getProxyMcpConfig(), 'WorkBuddy');
        } catch (e) {
            new Notice(`失败： ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private writeTraeCnConfig(): void {
        try {
            const configPath = path.join(os.homedir(), 'Library', 'Application Support', 'TRAE SOLO CN', 'User', 'mcp.json');
            this.writeJsonMcpConfig(configPath, 'vault_operator', this.getProxyMcpConfig(), 'TRAE Work CN');
        } catch (e) {
            new Notice(`失败： ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private tomlString(value: string): string {
        return JSON.stringify(value);
    }

    private writeCodexConfig(): void {
        try {
            const configPath = path.join(os.homedir(), '.codex', 'config.toml');
            let content = '';
            try {
                content = fs.readFileSync(configPath, 'utf-8');
            } catch {
                content = '';
            }

            const config = this.getProxyMcpConfig();
            const block = '[mcp_servers.vault_operator]\n'
                + `command = ${this.tomlString(config.command)}\n`
                + `args = [${config.args.map((arg) => this.tomlString(arg)).join(', ')}]\n`
                + 'startup_timeout_sec = 30\n';
            const section = new RegExp('\\n?\\[mcp_servers\\.vault_operator\\][\\s\\S]*?(?=\\n\\[[^\\]]+\\]|\\s*$)');
            content = section.test(content)
                ? content.replace(section, `\n${block.trim()}\n`)
                : `${content.replace(/\s*$/, '')}\n\n${block}`;

            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, content, 'utf-8');
            new Notice(`Codex 配置已保存：${configPath}。请重启 Codex App 并开启新线程。`);
        } catch (e) {
            new Notice(`失败： ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    private getWorkerPath(): string {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- runtimeWorker uses fs which is only available via dynamic require in Electron renderer
        const runtimeWorkerMod = require('../../core/utils/runtimeWorker') as { ensureRuntimeWorker: (plugin: unknown, name: string, code: string) => string };
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- inlined bundle file generated by esbuild
        const bundledWorkers = require('../../_generated/bundled-workers') as { MCP_WORKER_CODE: string };
        return runtimeWorkerMod.ensureRuntimeWorker(this.plugin, 'mcp-server-worker.js', bundledWorkers.MCP_WORKER_CODE);
    }

    private findNodePath(): string {
        const which = process.platform === 'win32' ? 'where' : 'which';
        const candidates: string[] = [];
        try {
            const result = spawnAllowedSync(which, ['node'], { encoding: 'utf-8', timeout: 3000 });
            if (result.status === 0 && result.stdout) {
                candidates.push(String(result.stdout).trim().split('\n')[0].trim());
            }
        } catch { /* fallback */ }
        if (process.platform === 'win32') {
            candidates.push('C:\\Program Files\\nodejs\\node.exe');
            candidates.push(`${readEnv(ENV_APPDATA) ?? ''}\\nvm\\current\\node.exe`);
        } else {
            candidates.push('/usr/local/bin/node', '/opt/homebrew/bin/node', `${os.homedir()}/.nvm/current/bin/node`);
        }
        for (const c of candidates) {
            // Candidate paths live outside the safeFs allowlist (system bin dirs).
            // probeBinaryExists is the documented bypass for that exact case
            // and returns a boolean only.
            if (!c || !safeFs.probeBinaryExists(c)) continue;
            try {
                const versionResult = spawnAllowedSync(c, ['--version'], { encoding: 'utf-8', timeout: 3000 });
                const version = String(versionResult.stdout ?? '').trim();
                if (version.startsWith('v')) return c;
            } catch { /* not a valid node binary */ }
        }
        return 'node';
    }
}
