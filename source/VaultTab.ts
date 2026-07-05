import { App, Notice, Setting } from 'obsidian';
import type ObsidianAgentPlugin from '../../main';
import { DEFAULT_AGENT_FOLDER } from '../../core/utils/agentFolder';
import { castGenerated } from '../../core/utils/runtime';
import { AgentFolderService, readStoredAgentFolder } from '../../core/utils/agentFolderService';
import { pickAgentFolder } from './AgentFolderPickerModal';
import { promptModal, confirmModal } from '../modals/PromptModal';
import { t } from '../../i18n';
import { DEFAULT_VAULT_INGEST_SETTINGS, DEFAULT_SUMMARY_PROMPT_TEMPLATE, DEFAULT_INGEST_TEMPLATES } from '../../types/settings';
import { addSectionHeading, addSliderInput } from './utils';
import { resolveCoreTemplatesFolder } from '../../core/utils/templatesFolder';
import { TemplateMaterializer } from '../../core/templates/TemplateMaterializer';
import { makeTemplateTranslator } from '../../core/templates/translateTemplate';
import { BUNDLED_NOTE_TEMPLATES } from '../../_generated/bundled-templates';


export class VaultTab {
    constructor(private plugin: ObsidianAgentPlugin, private app: App, private rerender: () => void) {}

    build(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.vault.headingCheckpoints'),
            { body: t('settings.vault.sectionCheckpointsInfo') },
        );

        new Setting(containerEl)
            .setName(t('settings.vault.enableCheckpoints'))
            .setDesc(t('settings.vault.enableCheckpointsDesc'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.enableCheckpoints ?? true).onChange(async (v) => {
                    this.plugin.settings.enableCheckpoints = v;
                    await this.plugin.saveSettings();
                }),
            );

        const timeoutSetting = new Setting(containerEl)
            .setName(t('settings.vault.snapshotTimeout'))
            .setDesc(t('settings.vault.snapshotTimeoutDesc'));
        addSliderInput(timeoutSetting, {
            min: 5, max: 120, step: 5,
            value: this.plugin.settings.checkpointTimeoutSeconds ?? 30,
            onChange: async (v) => {
                this.plugin.settings.checkpointTimeoutSeconds = v;
                await this.plugin.saveSettings();
            },
        });

        new Setting(containerEl)
            .setName(t('settings.vault.autoCleanup'))
            .setDesc(t('settings.vault.autoCleanupDesc'))
            .addToggle((t) =>
                t.setValue(this.plugin.settings.checkpointAutoCleanup ?? true).onChange(async (v) => {
                    this.plugin.settings.checkpointAutoCleanup = v;
                    await this.plugin.saveSettings();
                }),
            );

        addSectionHeading(
            containerEl,
            t('settings.vault.taskExtraction'),
            { body: t('settings.vault.sectionTaskExtractionInfo') },
        );

        const taskSettings = this.plugin.settings.taskExtraction ?? { enabled: true, taskFolder: 'Tasks' };

        new Setting(containerEl)
            .setName(t('settings.vault.taskExtractionEnable'))
            .setDesc(t('settings.vault.taskExtractionEnableDesc'))
            .addToggle((toggle) =>
                toggle.setValue(taskSettings.enabled).onChange(async (v) => {
                    this.plugin.settings.taskExtraction = { ...taskSettings, enabled: v };
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName(t('settings.vault.taskFolder'))
            .setDesc(t('settings.vault.taskFolderDesc'))
            .addText((text) =>
                text
                    .setPlaceholder('Tasks')
                    .setValue(taskSettings.taskFolder)
                    .onChange(async (v) => {
                        const folder = v.trim() || 'Tasks';
                        this.plugin.settings.taskExtraction = { ...taskSettings, taskFolder: folder };
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName(t('settings.vault.preferTaskNotes'))
            .setDesc(t('settings.vault.preferTaskNotesDesc'))
            .addToggle((toggle) =>
                toggle.setValue(taskSettings.preferTaskNotesPlugin ?? true).onChange(async (v) => {
                    this.plugin.settings.taskExtraction = { ...taskSettings, preferTaskNotesPlugin: v };
                    await this.plugin.saveSettings();
                }),
            );

        // ── Default output folder (v2.10.0) ────────────────────────────────────
        new Setting(containerEl)
            .setName('默认输出文件夹')
            .setDesc('当 agent 只提供文件名而无路径时，生成文件（xlsx、docx、pptx、drawio、excalidraw）的存放文件夹。请使用尾部斜杠，例如 "Inbox/"。')
            .addText((text) =>
                text
                    .setPlaceholder('Inbox/')
                    .setValue(this.plugin.settings.defaultOutputFolder ?? 'Inbox/')
                    .onChange(async (v) => {
                        const trimmed = v.trim();
                        this.plugin.settings.defaultOutputFolder = trimmed.length > 0 ? trimmed : 'Inbox/';
                        await this.plugin.saveSettings();
                    }),
            );

        addSectionHeading(
            containerEl,
            t('settings.vault.agentFolderHeading'),
            { body: t('settings.vault.sectionAgentFolderInfo') },
        );

        let currentInput: HTMLInputElement | null = null;
        const service = new AgentFolderService(this.plugin);

        /**
         * FEATURE-0508 P0+P1: persist, notify live components, show the
         * change notice. Does NOT migrate data — that's the button below.
         */
        const applyPathChange = async (newPath: string) => {
            const previous = readStoredAgentFolder(this.plugin);
            const sanitized = newPath.trim().length > 0 ? newPath.trim() : DEFAULT_AGENT_FOLDER;
            this.plugin.settings.agentFolderPath = sanitized;
            await this.plugin.saveSettings();
            await service.retargetLiveComponents();
            service.showChangeNotice(previous, sanitized);
        };

        new Setting(containerEl)
            .setName(t('settings.vault.agentFolder'))
            .setDesc(t('settings.vault.agentFolderFieldDesc'))
            .addText((text) => {
                currentInput = text.inputEl;
                text
                    .setPlaceholder(DEFAULT_AGENT_FOLDER)
                    .setValue(this.plugin.settings.agentFolderPath ?? DEFAULT_AGENT_FOLDER)
                    .onChange((v) => { void applyPathChange(v); });
            })
            .addButton((btn) =>
                btn
                    .setButtonText(t('settings.vault.agentFolderPick'))
                    .setIcon('folder')
                    .onClick(() => {
                        void (async () => {
                            const picked = await pickAgentFolder(this.app);
                            if (!picked) return;
                            if (currentInput) currentInput.value = picked.path;
                            await applyPathChange(picked.path);
                        })();
                    }),
            );

        // ── P2: migrate data button ───────────────────────────────────────────
        new Setting(containerEl)
            .setName(t('settings.vault.agentFolderMigrate'))
            .setDesc(t('settings.vault.agentFolderMigrateDesc'))
            .addButton((btn) =>
                btn
                    .setButtonText(t('settings.vault.agentFolderMigrateButton'))
                    .setIcon('arrow-right-left')
                    .onClick(() => { void this.handleMigrateClick(service); }),
            );

        // ── FEAT-29-01 Storage Layout Migration ───────────────────────────
        this.buildLayoutMigrationSection(containerEl, applyPathChange, service);

        // ── BA-25 Karpathy-Wiki-Pattern (Vault-Ingest) ────────────────────
        this.buildVaultIngestSection(containerEl);

        // ── IMP-20-06-01 Wave 4: Freshness verifier sub-flags ─────────────
        this.buildFreshnessSection(containerEl);

        // ── IMP-19-01-01: Vault Health auto-apply for rule-based repairs ──
        this.buildVaultHealthSection(containerEl);
    }

    /**
     * IMP-19-01-01: opt-in auto-apply for deterministic Vault Health
     * repairs. Default off; the toggle lists the three rule checks
     * covered so the user knows what gets auto-applied.
     */
    private buildVaultHealthSection(containerEl: HTMLElement): void {
        addSectionHeading(containerEl, '库健康自动修复', {
            body: '当健康检查发现互链或一致性规则违规时，弹窗可以在展示列表前自动应用修复。更广泛的审查仍由你掌控。',
        });

        const vh = this.plugin.settings.vaultHealth;

        new Setting(containerEl)
            .setName('健康检查时自动应用规则修复')
            .setDesc('在弹窗打开前自动修复三项确定性规则检查（缺失反向链接、category 不匹配、标签不一致）。检查点会先运行，因此你可以从修复后的界面撤销。默认关闭。')
            .addToggle((tg) =>
                tg.setValue(vh.autoApplyRuleRepairs).onChange(async (v) => {
                    this.plugin.settings.vaultHealth = { ...vh, autoApplyRuleRepairs: v };
                    await this.plugin.saveSettings();
                }),
            );
    }

    /**
     * Freshness verifier sub-flags.
     *
     * All sub-toggles default OFF. The note-level verifier runs only
     * when the user explicitly enables external sources; the frontmatter
     * mirror and frontier escalation are independent opt-ins on top.
     */
    private buildFreshnessSection(containerEl: HTMLElement): void {
        addSectionHeading(containerEl, '笔记新鲜度校验', {
            body: '在周期性更新过程中对照外部来源交叉校验笔记。所有子开关默认关闭。',
        });

        const freshness = this.plugin.settings.freshness;

        new Setting(containerEl)
            .setName('启用外部来源')
            .setDesc('为每个候选笔记向已配置的网页搜索提供商发送至多一条短查询。默认关闭（无外部流量）。')
            .addToggle((tg) =>
                tg.setValue(freshness.externalSources.enabled).onChange(async (v) => {
                    this.plugin.settings.freshness = {
                        ...freshness,
                        externalSources: { ...freshness.externalSources, enabled: v },
                    };
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('将新鲜度提示写入笔记 frontmatter')
            .setDesc('将最新判定以单个 `freshness` 键镜像写入笔记。默认关闭；判定结果已存在于知识审查标签页中。')
            .addToggle((tg) =>
                tg.setValue(freshness.writeFrontmatter).onChange(async (v) => {
                    this.plugin.settings.freshness = { ...freshness, writeFrontmatter: v };
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('校验置信度低时允许旗舰模型升级')
            .setDesc('当中层模型判定置信度较低时重新询问旗舰模型；仅当旗舰提供商被标记为零数据保留时才会触发。')
            .addToggle((tg) =>
                tg.setValue(freshness.allowFrontierEscalation).onChange(async (v) => {
                    this.plugin.settings.freshness = { ...freshness, allowFrontierEscalation: v };
                    await this.plugin.saveSettings();
                }),
            );

        const thresholdSetting = new Setting(containerEl)
            .setName('前沿模型置信度阈值')
            .setDesc('仅当中层模型判定置信度低于此数值时才升级。');
        addSliderInput(thresholdSetting, {
            min: 0.0, max: 1.0, step: 0.05,
            value: freshness.frontierConfidenceThreshold,
            onChange: async (v) => {
                this.plugin.settings.freshness = { ...freshness, frontierConfidenceThreshold: v };
                await this.plugin.saveSettings();
            },
        });

        new Setting(containerEl)
            .setName('排除路径')
            .setDesc('以逗号分隔的路径前缀，校验器不会读取这些路径。')
            .addText((text) => {
                text.setValue(freshness.excludePaths.join(', '))
                    .onChange(async (v) => {
                        const paths = v.split(',').map((s) => s.trim()).filter(Boolean);
                        this.plugin.settings.freshness = { ...freshness, excludePaths: paths };
                        await this.plugin.saveSettings();
                    });
            });
    }

    /**
     * Storage Layout Consolidation section.
     *
     * Consolidates the historical plugin-storage roots (.obsidian-agent,
     * .obsilo-vault, .vault-operator, vault-parent/obsilo-shared) into a
     * single vault-local layout with data/ and cache/ sub-folders. Opt-in
     * because it relocates files across roots and switches the lookup paths
     * for dependent services.
     */
    private buildLayoutMigrationSection(
        containerEl: HTMLElement,
        applyPathChange: (newPath: string) => Promise<void>,
        service: AgentFolderService,
    ): void {
        addSectionHeading(
            containerEl,
            '存储布局整合',
            {
                body: '将插件存储整合到单一的库内路径下，包含 data/ 和 cache/ 子文件夹。替换历史根目录 .obsidian-agent、.obsilo-vault、.vault-operator 以及 vault-parent 下的 obsilo-shared 文件夹。移动任何文件之前会先写入备份快照。该操作可在插件重载后继续执行。',
            },
        );

        const statusValue = this.plugin.settings._layoutMigrationStatus ?? 'pending';
        new Setting(containerEl)
            .setName('迁移状态')
            .setDesc(`当前状态：${statusValue}`);

        new Setting(containerEl)
            .setName('运行布局迁移')
            .setDesc('激活迁移。激活后请重载插件（Cmd-P / Ctrl-P -> Reload Vault Operator）。迁移将在下次插件启动时运行。会先将备份快照写入 Obsidian 插件数据目录（位于库目录之外）。')
            .addButton((btn) =>
                btn
                    .setButtonText(
                        statusValue === 'complete' ? '已迁移' : '激活迁移',
                    )
                    .setIcon('arrow-right-left')
                    .setTooltip(
                        statusValue === 'complete'
                            ? '存储布局迁移已完成。无需操作。'
                            : '激活存储布局迁移。之后需要重载插件。',
                    )
                    .setDisabled(statusValue === 'complete')
                    .onClick(() => {
                        void (async () => {
                            if (statusValue === 'complete') {
                                new Notice(
                                    '存储布局迁移已完成。无需操作。',
                                    5000,
                                );
                                return;
                            }
                            const ok = await confirmModal(this.app, {
                                title: '激活存储布局迁移？',
                                message: '迁移会将所有插件数据（知识索引、历史、记忆、技能、规则、工作流、片段、日志、插件技能、资源缓存、检查点、开发环境、临时文件）移动到包含 data/ 和 cache/ 子文件夹的整合路径中。\n\n首次移动前会写入备份快照。该操作可恢复执行。激活后你需要重载插件（Cmd-P / Ctrl-P -> Reload Vault Operator）。是否继续？',
                                confirmLabel: '激活迁移',
                                cancelLabel: '取消',
                            });
                            if (!ok) return;
                            this.plugin.settings._layoutMigrationOptIn = true;
                            await this.plugin.saveSettings();
                            new Notice(
                                '迁移已激活。请通过命令面板重载插件以应用更改。',
                                10000,
                            );
                            this.rerender();
                        })();
                    }),
            );

        // Reset agent folder path to default
        const currentPath = this.plugin.settings.agentFolderPath ?? DEFAULT_AGENT_FOLDER;
        const isDefault = currentPath === DEFAULT_AGENT_FOLDER;
        new Setting(containerEl)
            .setName('重置为默认 agent 文件夹路径')
            .setDesc(
                isDefault
                    ? `当前路径已是默认值（${DEFAULT_AGENT_FOLDER}）。`
                    : `当前路径：${currentPath}。重置会将其还原为 ${DEFAULT_AGENT_FOLDER}。`,
            )
            .addButton((btn) =>
                btn
                    .setButtonText(`重置为 ${DEFAULT_AGENT_FOLDER}`)
                    .setIcon('rotate-ccw')
                    .setTooltip(
                        isDefault
                            ? `Agent 文件夹路径已是默认值（${DEFAULT_AGENT_FOLDER}）。`
                            : `将 agent 文件夹路径重置为 ${DEFAULT_AGENT_FOLDER}。`,
                    )
                    .setDisabled(isDefault)
                    .onClick(() => {
                        void (async () => {
                            if (isDefault) {
                                new Notice(
                                    `Agent 文件夹路径已是默认值（${DEFAULT_AGENT_FOLDER}）。`,
                                    5000,
                                );
                                return;
                            }
                            const ok = await confirmModal(this.app, {
                                title: '重置 agent 文件夹路径？',
                                message:
                                    `当前路径：${currentPath}\n`
                                    + `新路径：${DEFAULT_AGENT_FOLDER}\n\n`
                                    + '插件技能、知识索引和记忆数据库会从当前文件夹复制到默认文件夹。'
                                    + '原文件保留在原处；请在确认新位置可用后手动删除。是否继续？',
                                confirmLabel: '重置并迁移文件',
                                cancelLabel: '取消',
                            });
                            if (!ok) return;

                            // Move plugin skills, vault-dna snapshot, knowledge db,
                            // memory db from currentPath to DEFAULT_AGENT_FOLDER via
                            // the existing migration helper, then flip the setting.
                            const migrationResult = await service.migrate(currentPath, DEFAULT_AGENT_FOLDER);
                            await applyPathChange(DEFAULT_AGENT_FOLDER);

                            const movedSummary: string[] = [];
                            if (migrationResult.movedKnowledgeDb) movedSummary.push('知识索引');
                            if (migrationResult.movedMemoryDb) movedSummary.push('记忆数据库');
                            if (migrationResult.movedVaultDna) movedSummary.push('vault-DNA 快照');
                            if (migrationResult.movedPluginSkills > 0) {
                                movedSummary.push(`${migrationResult.movedPluginSkills} 个插件技能文件`);
                            }
                            const movedLine = movedSummary.length > 0
                                ? `已移动：${movedSummary.join('、')}。`
                                : '无需移动（原路径没有插件数据）。';
                            const errLine = migrationResult.errors.length > 0
                                ? ` ${migrationResult.errors.length} 个非致命错误；请查看开发者控制台。`
                                : '';
                            new Notice(
                                `Agent 文件夹路径已重置为 ${DEFAULT_AGENT_FOLDER}。${movedLine}${errLine}`,
                                8000,
                            );
                            if (migrationResult.errors.length > 0) {
                                console.warn('[VaultOperator] Reset-to-default migration errors:', migrationResult.errors);
                            }
                            this.rerender();
                        })();
                    }),
            );

        // Restore previous layout from a backup snapshot
        new Setting(containerEl)
            .setName('从备份恢复之前的布局')
            .setDesc(
                statusValue === 'complete'
                    ? '通过从迁移创建的备份快照恢复来撤销存储布局整合。选择最近的备份，四个历史根目录会被重建，整合后的 data/ 和 cache/ 文件夹会被删除。之后需要重载插件。'
                    : '只有在迁移完成后恢复才有意义。当前迁移尚未运行或未完成。',
            )
            .addButton((btn) =>
                btn
                    .setButtonText('从备份恢复')
                    .setIcon('history')
                    .setTooltip(
                        statusValue === 'complete'
                            ? '恢复存储迁移之前使用的布局。'
                            : '迁移未完成；无可恢复内容。',
                    )
                    .setDisabled(statusValue !== 'complete')
                    .onClick(() => {
                        void this.handleRestoreClick(statusValue);
                    }),
            );

        // Notice for users who had chatHistoryFolder set before the setting was removed
        const legacyChatHistory = this.plugin.settings._chatHistoryFolderLegacy;
        if (legacyChatHistory) {
            new Setting(containerEl)
                .setName('聊天历史文件夹设置已移除')
                .setDesc(
                    `chatHistoryFolder 设置已不再使用。你之前的路径为：${legacyChatHistory}。`
                    + '对话仍可通过插件侧边栏的历史面板访问。旧的库文件夹保留在原处；'
                    + '如不再需要，请手动删除。',
                )
                .addButton((btn) =>
                    btn
                        .setButtonText('知道了，关闭')
                        .setIcon('check')
                        .onClick(() => {
                            void (async () => {
                                this.plugin.settings._chatHistoryFolderLegacy = undefined;
                                await this.plugin.saveSettings();
                                this.rerender();
                            })();
                        }),
                );
        }
    }

    /**
     * BA-25 PLAN-10..14 Vault-Ingest-Settings:
     *   - Standard-Prompt fuer Auto-Summary (Sebastians Wortlaut Default)
     *   - Auto-Summary-Toggle (Default off)
     *   - Frontmatter-Write-Toggle (Default off, Variante B aus BA-25)
     *   - Auto-Trigger via Frontmatter-Property (FEAT-19-27)
     *   - PDF-Strategie (Page-Refs vs Markdown-Mirror)
     *
     * Plugin-Reload-Notiz: Aenderungen an Auto-Trigger-Property erfordern
     * Plugin-Reload damit der vault.on-Listener neu registriert.
     */
    private buildVaultIngestSection(containerEl: HTMLElement): void {
        addSectionHeading(
            containerEl,
            t('settings.vault.headingIngest'),
            { body: t('settings.vault.sectionIngestInfo') },
        );

        const cfg = this.plugin.settings.vaultIngest ?? { ...DEFAULT_VAULT_INGEST_SETTINGS };
        // Sicherstellen dass Setting-Objekt existiert (Migration aus aelteren Settings-Versionen)
        if (!this.plugin.settings.vaultIngest) {
            this.plugin.settings.vaultIngest = cfg;
        }
        // FIX (Live-Bug 2026-05-04): shallow Object.assign in loadSettings
        // ueberschreibt vaultIngest komplett wenn es im persistenten data.json
        // existiert, auch wenn neue Sub-Objekte (topHubBlock, stufe2Hint,
        // autoTrigger) im Saved fehlen. Hier defensive Init pro Sub-Objekt
        // damit alte Settings-Files mit neuen Toggles funktionieren.
        if (!cfg.topHubBlock) {
            cfg.topHubBlock = { ...DEFAULT_VAULT_INGEST_SETTINGS.topHubBlock };
        }
        if (!cfg.stufe2Hint) {
            cfg.stufe2Hint = { ...DEFAULT_VAULT_INGEST_SETTINGS.stufe2Hint };
        }
        if (!cfg.autoTrigger) {
            cfg.autoTrigger = { ...DEFAULT_VAULT_INGEST_SETTINGS.autoTrigger };
        }
        if (!cfg.autoSummary) {
            cfg.autoSummary = { ...DEFAULT_VAULT_INGEST_SETTINGS.autoSummary };
        }
        if (!cfg.summaryPrompt) {
            cfg.summaryPrompt = { ...DEFAULT_VAULT_INGEST_SETTINGS.summaryPrompt };
        }

        // Auto-Summary-Toggle
        new Setting(containerEl)
            .setName('索引时自动摘要')
            .setDesc('启用后，语义索引会为每篇 frontmatter 中尚无摘要的笔记生成一段简短摘要。已有摘要会被复用且不会被覆盖。每篇笔记消耗一次 LLM 调用（使用你的默认模型）。')
            .addToggle((toggle) =>
                toggle.setValue(cfg.autoSummary.enabled).onChange(async (v) => {
                    cfg.autoSummary.enabled = v;
                    this.plugin.settings.vaultIngest = cfg;
                    await this.plugin.saveSettings();
                }),
            );

        // Frontmatter-Write-Toggle
        new Setting(containerEl)
            .setName('将自动摘要写入 frontmatter')
            .setDesc('启用后，生成的摘要也会以 "Zusammenfassung" 属性写入笔记的 frontmatter（保留结构，不覆盖已有值）。默认关闭，以确保 agent 未经许可不会修改你的笔记。启用后，请运行下方的回填操作来为已有笔记生成摘要。')
            .addToggle((toggle) =>
                toggle.setValue(cfg.autoSummary.writeFrontmatter).onChange(async (v) => {
                    cfg.autoSummary.writeFrontmatter = v;
                    this.plugin.settings.vaultIngest = cfg;
                    await this.plugin.saveSettings();
                }),
            );

        // Standard-Prompt-Editor
        new Setting(containerEl)
            .setName('默认摘要提示词')
            .setDesc('用于生成笔记摘要的提示词模板。可按库单独编辑。"重置"会恢复内置默认值。')
            .addButton((btn) =>
                btn
                    .setButtonText('编辑')
                    .setIcon('pencil')
                    .onClick(async () => {
                        const next = await promptModal(this.app, {
                            title: '默认摘要提示词',
                            defaultValue: cfg.summaryPrompt.template,
                            placeholder: '多行提示词模板...',
                            submitLabel: '保存',
                        });
                        if (next === null) return;
                        cfg.summaryPrompt.template = next || DEFAULT_SUMMARY_PROMPT_TEMPLATE;
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                        this.rerender();
                    }),
            )
            .addButton((btn) =>
                btn
                    .setButtonText('重置')
                    .onClick(async () => {
                        cfg.summaryPrompt.template = DEFAULT_SUMMARY_PROMPT_TEMPLATE;
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                        this.rerender();
                    }),
            );

        addSectionHeading(
            containerEl,
            '收件箱分诊自动触发',
            { body: '监视库中带有特定 frontmatter 属性和值的笔记。当出现匹配时（例如你保存了一篇 `category: source` 的笔记），agent 会自动将其加入分诊队列并在后台处理。适用于希望新来源被自动摘要并归档、无需手动调用的收件箱式工作流。切换主开关后需要重载插件以（注销）注册文件监听器。' },
            { level: 'h4' },
        );

        new Setting(containerEl)
            .setName('启用自动触发')
            .setDesc('当笔记带有下方配置的属性和值时，分诊会自动开始。默认关闭。')
            .addToggle((toggle) =>
                toggle.setValue(cfg.autoTrigger.enabled).onChange(async (v) => {
                    cfg.autoTrigger.enabled = v;
                    this.plugin.settings.vaultIngest = cfg;
                    await this.plugin.saveSettings();
                    if (v) {
                        new Notice('自动触发已启用。请重载插件以注册文件监听器。', 8000);
                    }
                }),
            );

        new Setting(containerEl)
            .setName('属性名')
            .setDesc('要监视的 frontmatter 属性名，例如 category。')
            .addText((text) =>
                text
                    .setValue(cfg.autoTrigger.propertyName)
                    .setPlaceholder('Category')
                    .onChange(async (v) => {
                        cfg.autoTrigger.propertyName = v.trim();
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('属性值')
            .setDesc('触发匹配的值，例如 source。多个值请用逗号分隔。')
            .addText((text) =>
                text
                    .setValue(Array.isArray(cfg.autoTrigger.propertyValue) ? cfg.autoTrigger.propertyValue.join(', ') : cfg.autoTrigger.propertyValue)
                    .setPlaceholder('Source')
                    .onChange(async (v) => {
                        const parts = v.split(',').map((s) => s.trim()).filter(Boolean);
                        cfg.autoTrigger.propertyValue = parts.length > 1 ? parts : (parts[0] ?? '');
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('触发时显示通知')
            .setDesc('自动触发时显示一条提示。默认关闭（库健康弹窗已列出被触发的笔记）。')
            .addToggle((toggle) =>
                toggle.setValue(cfg.autoTrigger.notification).onChange(async (v) => {
                    cfg.autoTrigger.notification = v;
                    this.plugin.settings.vaultIngest = cfg;
                    await this.plugin.saveSettings();
                }),
            );

        addSectionHeading(
            containerEl,
            'PDF 处理',
            { body: '控制 agent 引用 PDF 时的引用方式。页面引用保持 PDF 不变并链接到具体页面。Markdown 镜像会额外将文本提取到一份并行的 markdown 文件中，使 agent 能在块级别引用和链接。默认使用页面引用；仅当 PDF 文字密集且需要引用级粒度时才使用 Markdown 镜像。' },
            { level: 'h4' },
        );

        new Setting(containerEl)
            .setName('PDF 策略')
            .setDesc('页面引用（默认）：PDF 保留在库中，引用使用 [[file.pdf#page=N]]。Markdown 镜像（可选）：会额外创建一份 markdown 副本以获得块级粒度。适用于文字密集、需要引用级参考的 PDF。')
            .addDropdown((dd) =>
                dd
                    .addOption('page-refs', '页面引用（默认）')
                    .addOption('markdown-mirror', 'Markdown 镜像（可选）')
                    .setValue(cfg.pdfStrategy)
                    .onChange(async (v) => {
                        cfg.pdfStrategy = v as 'page-refs' | 'markdown-mirror';
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        addSectionHeading(
            containerEl,
            '摄入技能的笔记模板',
            { body: '指向一个 Markdown 文件的库内相对路径，该文件的 YAML frontmatter 用作新摄入来源笔记的基础。留空则回退到内置默认值。适用于希望每篇新来源笔记都带有自定义 frontmatter 属性集的情况。' },
            { level: 'h4' },
        );

        new Setting(containerEl)
            .setName('/ingest 模板')
            .setDesc('快速单次摄入技能使用的 frontmatter 模板。')
            .addText((text) =>
                text
                    .setPlaceholder('Tools & Settings/Templates/Quelle Template.md')
                    .setValue(cfg.templates?.ingestNoteTemplate ?? '')
                    .onChange(async (v) => {
                        cfg.templates = cfg.templates ?? DEFAULT_INGEST_TEMPLATES();
                        cfg.templates.ingestNoteTemplate = v.trim();
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('/ingest-deep 模板')
            .setDesc('多轮深度摄入技能使用的 frontmatter 模板。')
            .addText((text) =>
                text
                    .setPlaceholder('Tools & Settings/Templates/Quelle Template.md')
                    .setValue(cfg.templates?.ingestDeepNoteTemplate ?? '')
                    .onChange(async (v) => {
                        cfg.templates = cfg.templates ?? DEFAULT_INGEST_TEMPLATES();
                        cfg.templates.ingestDeepNoteTemplate = v.trim();
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('/meeting-summary 模板')
            .setDesc('会议记录摘要技能使用的 frontmatter 模板。')
            .addText((text) =>
                text
                    .setPlaceholder('Tools & Settings/Templates/Meeting-Notiz Template.md')
                    .setValue(cfg.templates?.meetingSummaryTemplate ?? '')
                    .onChange(async (v) => {
                        cfg.templates = cfg.templates ?? DEFAULT_INGEST_TEMPLATES();
                        cfg.templates.meetingSummaryTemplate = v.trim();
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        // FEAT-29-14: separate template for the Sense-Making-Notes /
        // Zettel that /ingest and /ingest-deep produce on top of the
        // source note. Default category is "Quellen-Notiz" / "Source note".
        new Setting(containerEl)
            .setName('意义建构笔记模板')
            .setDesc('用于 /ingest 和 /ingest-deep 产出的次级输出笔记（意义建构摘要或按要点拆分的 zettel）的 frontmatter 模板。')
            .addText((text) =>
                text
                    .setPlaceholder('Tools & Settings/Templates/Notiz Template.md')
                    .setValue(cfg.templates?.quellenNotizTemplate ?? '')
                    .onChange(async (v) => {
                        cfg.templates = cfg.templates ?? DEFAULT_INGEST_TEMPLATES();
                        cfg.templates.quellenNotizTemplate = v.trim();
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );

        // FEAT-29-14: Re-materialize button. Re-runs the same code path
        // as the FirstRun-Templates step using the persisted
        // `templatesLanguage` (default 'de'). Skip-existing by default
        // so user edits are preserved; the modal offers force-overwrite.
        new Setting(containerEl)
            .setName('重新物化默认模板')
            .setDesc('将内置的来源、笔记和会议笔记模板重新写入你配置的模板文件夹。已有文件会被跳过，除非你确认覆盖。')
            .addButton((btn) =>
                btn
                    .setButtonText('重新物化')
                    .onClick(async () => {
                        await this.handleRematerializeTemplates();
                    }),
            );

        addSectionHeading(
            containerEl,
            '系统提示词中的顶部枢纽块',
            { body: '枢纽笔记是库中被链接最多的笔记，是知识图谱的结构骨架（中央索引笔记、MOC、关键主题页）。启用后，你前 30 个枢纽笔记的简短摘要会被注入每次对话的系统提示词中，使 agent 拥有库的高层地图。能改善一般问题的接地性，但每次调用都会增加 token 成本。' },
            { level: 'h4' },
        );

        const privacyWarn = containerEl.createEl('div', { cls: 'agent-settings-desc' });
        privacyWarn.createEl('strong', { text: '隐私提示：' });
        privacyWarn.appendText(
            '启用后，你前 30 个枢纽笔记的摘要会在每次对话时发送给 LLM 提供商。'
            + '启用前请检查你的枢纽笔记是否包含敏感数据（日记、病历、商业信息）。'
            + '该设置可随时撤销，但已发送给提供商的数据仍会保留在其处。',
        );

        new Setting(containerEl)
            .setName('已阅读并接受隐私提示')
            .setDesc('只有在此确认后才能启用顶部枢纽块。')
            .addToggle((toggle) =>
                toggle.setValue(cfg.topHubBlock.privacyAcknowledged).onChange(async (v) => {
                    cfg.topHubBlock.privacyAcknowledged = v;
                    if (!v) cfg.topHubBlock.enabled = false; // disable enabled if ack revoked
                    this.plugin.settings.vaultIngest = cfg;
                    await this.plugin.saveSettings();
                    this.rerender();
                }),
            );

        const enabledSetting = new Setting(containerEl)
            .setName('启用顶部枢纽块')
            .setDesc('默认关闭。需要先接受隐私提示。')
            .addToggle((toggle) =>
                toggle
                    .setValue(cfg.topHubBlock.enabled)
                    .setDisabled(!cfg.topHubBlock.privacyAcknowledged)
                    .onChange(async (v) => {
                        if (v && !cfg.topHubBlock.privacyAcknowledged) {
                            new Notice('请先接受隐私提示。', 6000);
                            toggle.setValue(false);
                            return;
                        }
                        cfg.topHubBlock.enabled = v;
                        this.plugin.settings.vaultIngest = cfg;
                        await this.plugin.saveSettings();
                    }),
            );
        if (!cfg.topHubBlock.privacyAcknowledged) {
            enabledSetting.descEl.createEl('br');
            enabledSetting.descEl.createEl('em', { text: '（在接受隐私提示前已禁用）' });
        }

        addSectionHeading(
            containerEl,
            '热门集群（周期性新鲜度检查）',
            { body: '"集群"是从库的本体论中派生出的主题分组（例如 "AI"、"烹饪"）。一个每周后台任务会检查自笔记上次更新以来外部世界是否已有新进展，但仅针对你在下方标记为"热门"的集群。请标记时效性重要的主题（快速变化的领域、活跃的项目）。默认：未选择任何集群。每次运行有 token 预算上限以控制成本。' },
            { level: 'h4' },
        );

        const store = this.plugin.clusterMetadataStore;
        if (!store) {
            containerEl.createEl('p', { cls: 'agent-settings-desc', text: '集群元数据存储未加载。' });
        } else {
            const all = store.getAll();
            if (all.length === 0) {
                containerEl.createEl('p', {
                    cls: 'agent-settings-desc',
                    text: '本体论中尚无集群。请先运行库索引。',
                });
            } else {
                for (const cluster of all) {
                    new Setting(containerEl)
                        .setName(cluster.cluster)
                        .setDesc(`半衰期：${cluster.halfLifeDays}天${cluster.lastExternalCheck ? '。上次检查：' + cluster.lastExternalCheck.split('T')[0] : ''}`)
                        .addToggle((toggle) =>
                            toggle
                                .setValue(cluster.hotCluster)
                                .onChange(async (v) => {
                                    store.setHotCluster(cluster.cluster, v);
                                    await this.plugin.knowledgeDB?.save();
                                }),
                        );
                }
            }
        }

        addSectionHeading(
            containerEl,
            '过时集群的活动提示',
            { body: '当你打开或编辑一篇属于知识看起来已过时（新鲜度分数低）的集群的笔记时，插件可以显示一条温和的提示，建议针对外部来源运行一次"反回声"搜索，以呈现可能已发生的变化。默认关闭以避免提示刷屏。每集群冷却和每日上限可防止重复打扰。' },
            { level: 'h4' },
        );
        new Setting(containerEl)
            .setName('启用活动提示')
            .setDesc('当你打开或编辑一篇属于较久未刷新的集群的笔记时，显示温和的提示。')
            .addToggle((toggle) => {
                toggle.setValue(cfg.stufe2Hint.enabled).onChange(async (v) => {
                    cfg.stufe2Hint.enabled = v;
                    await this.plugin.saveSettings();
                });
            });
        new Setting(containerEl)
            .setName('新鲜度分数阈值')
            .setDesc('当集群的新鲜度分数低于此值（0..100）时触发提示。默认 70。')
            .addText((text) => {
                text.setValue(String(cfg.stufe2Hint.hintThresholdScore))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (Number.isFinite(n) && n >= 0 && n <= 100) {
                            cfg.stufe2Hint.hintThresholdScore = n;
                            await this.plugin.saveSettings();
                        }
                    });
            });
        new Setting(containerEl)
            .setName('距上次外部检查的最小天数')
            .setDesc('默认 30。防止在周期性新鲜度检查刚运行后立即提示。')
            .addText((text) => {
                text.setValue(String(cfg.stufe2Hint.minDaysSinceCheck))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (Number.isFinite(n) && n >= 0) {
                            cfg.stufe2Hint.minDaysSinceCheck = n;
                            await this.plugin.saveSettings();
                        }
                    });
            });
        new Setting(containerEl)
            .setName('每个集群冷却天数')
            .setDesc('默认 7。在此期间每个集群至多提示一次。')
            .addText((text) => {
                text.setValue(String(cfg.stufe2Hint.perClusterCooldownDays))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (Number.isFinite(n) && n >= 1) {
                            cfg.stufe2Hint.perClusterCooldownDays = n;
                            await this.plugin.saveSettings();
                        }
                    });
            });
        new Setting(containerEl)
            .setName('每天最大提示数（全局）')
            .setDesc('默认 5。在繁忙日限制提示总数以避免刷屏。')
            .addText((text) => {
                text.setValue(String(cfg.stufe2Hint.maxHintsPerDay))
                    .onChange(async (v) => {
                        const n = parseInt(v, 10);
                        if (Number.isFinite(n) && n >= 1) {
                            cfg.stufe2Hint.maxHintsPerDay = n;
                            await this.plugin.saveSettings();
                        }
                    });
            });

        addSectionHeading(
            containerEl,
            '手动操作',
            { body: '可对整个库运行的一次性操作：回填缺失的 frontmatter 摘要、扫描收件箱以匹配自动触发、向枢纽笔记插入内容地图标记，或重建缓存的顶部枢纽块。每个操作都是幂等的，可安全重复运行。' },
            { level: 'h4' },
        );
        new Setting(containerEl)
            .setName('运行 frontmatter 回填')
            .setDesc('遍历所有 Markdown 笔记并添加缺失的 frontmatter 摘要。需要先启用上方的自动摘要开关。大型库可能耗时较长。')
            .addButton((btn) => btn.setButtonText('运行回填').onClick(() => { void this.plugin.runFrontmatterBackfill(); }));
        new Setting(containerEl)
            .setName('立即运行收件箱分诊')
            .setDesc('扫描所有匹配自动触发属性的笔记，并将它们作为待处理项加入分诊日志。')
            .addButton((btn) => btn.setButtonText('分诊收件箱').onClick(() => { void this.plugin.runInboxTriage(); }));
        new Setting(containerEl)
            .setName('插入内容地图标记')
            .setDesc('内容地图是一种列出相关笔记的枢纽笔记。此操作会向所有名称匹配已知集群的枢纽候选笔记插入自动生成的标记块。幂等（可安全重复运行）。')
            .addButton((btn) => btn.setButtonText('插入标记').onClick(() => { void this.plugin.injectInitialMOCMarkers(); }));
        new Setting(containerEl)
            .setName('刷新内容地图页面')
            .setDesc('更新枢纽页面内自动生成的标记块。用户编辑过的块会被跳过。')
            .addButton((btn) => btn.setButtonText('刷新枢纽页面').onClick(() => { void this.plugin.refreshAllMOCs(); }));
        new Setting(containerEl)
            .setName('重新生成顶部枢纽块')
            .setDesc('手动重建列出你顶部枢纽的缓存系统提示词块。否则只会在枢纽成员变化时刷新（有 24 小时冷却）。')
            .addButton((btn) => btn.setButtonText('重新生成').onClick(() => {
                if (!this.plugin.topHubBlockGenerator) { new Notice('顶部枢纽生成器不可用。'); return; }
                const r = this.plugin.topHubBlockGenerator.generate();
                this.plugin.topHubBlockState = r.state;
                this.plugin.topHubBlockMarkdown = r.block;
                new Notice(`顶部枢纽块已重新生成：${r.hubs.length} 个枢纽。`);
            }));
    }

    /**
     * FEATURE-0508 P2: prompt for the OLD path, preview what's there,
     * confirm, migrate. Originals stay in place — user deletes manually
     * after verifying the new location works.
     */
    /**
     * Restore the legacy layout from a backup snapshot the consolidation
     * migration wrote. Lists available backups, asks the user to confirm,
     * then runs the restore service. Resets the migration status so the
     * Settings UI reflects the rollback after the next plugin reload.
     */
    private async handleRestoreClick(statusValue: string): Promise<void> {
        if (statusValue !== 'complete') {
            new Notice('布局迁移未完成；无可恢复内容。', 5000);
            return;
        }
        const vaultBasePath = (this.app.vault.adapter as unknown as {
            getBasePath?(): string;
        }).getBasePath?.() ?? '';
        if (!vaultBasePath) {
            new Notice('无法解析库根路径；恢复已中止。', 6000);
            return;
        }
        const nodePath = await import('path');
        const nodeOs = await import('os');
        const nodeFs = await import('fs');
        const nodeCrypto = await import('crypto');
        // Backup pfad mirror to main.ts -- {homedir}/.vault-operator-migration-backups/{vault-hash}/
        // ensures snapshots stay outside any sync container (iCloud, Obsidian-Sync).
        // AUDIT-034 Info-5: sha256 is the canonical hash; md5 path is probed as
        // backward-compatibility fallback for backups written by older versions.
        const vaultIdHashSha256 = nodeCrypto
            .createHash('sha256')
            .update(vaultBasePath)
            .digest('hex')
            .slice(0, 12);
        const vaultIdHashMd5 = nodeCrypto
            .createHash('md5')
            .update(vaultBasePath)
            .digest('hex')
            .slice(0, 12);
        const backupsRoot = nodePath.join(
            nodeOs.homedir(),
            '.vault-operator-migration-backups',
        );
        const sha256Dir = nodePath.join(backupsRoot, vaultIdHashSha256);
        const legacyMd5Dir = nodePath.join(backupsRoot, vaultIdHashMd5);
        const pluginDataDir = nodeFs.existsSync(sha256Dir) || !nodeFs.existsSync(legacyMd5Dir)
            ? sha256Dir
            : legacyMd5Dir;
        const vaultParent = nodePath.dirname(vaultBasePath);

        const { listBackupFolders, restoreLayoutFromBackup } = await import(
            '../../core/utils/restoreLayoutFromBackup'
        );
        const backups = await listBackupFolders(pluginDataDir);
        if (backups.length === 0) {
            new Notice(
                '未找到备份快照。恢复仅在全新迁移后可用。',
                7000,
            );
            return;
        }
        const latest = backups[0];
        const latestName = nodePath.basename(latest);
        const ok = await confirmModal(this.app, {
            title: '从备份恢复之前的布局？',
            message:
                `最新备份：${latestName}\n\n`
                + '恢复此快照将：\n'
                + '  - 重建四个历史插件文件夹\n'
                + '  - 删除整合后的 .vault-operator/data 和 .vault-operator/cache 文件夹\n'
                + '  - 重置迁移状态，以便日后可重新运行整合\n\n'
                + '之后你需要重载插件（Cmd-P / Ctrl-P -> Reload Vault Operator）。是否继续？',
            confirmLabel: '从备份恢复',
            cancelLabel: '取消',
        });
        if (!ok) return;

        const report = await restoreLayoutFromBackup({
            vaultBasePath,
            vaultParent,
            backupPath: latest,
            removeConsolidated: true,
        });

        if (!report.allRestoreSucceeded) {
            const failed = report.entries.filter((e) => e.status === 'failed' || e.status === 'skipped-destination-populated');
            console.warn('[VaultOperator] Restore-from-backup partial failure:', report);
            new Notice(
                `恢复未能顺利完成：${failed.length} 个目标被阻塞。请查看开发者控制台。`,
                10000,
            );
            return;
        }

        // Reset migration flags so the UI offers the migration again and the
        // next plugin start does not skip the trigger.
        this.plugin.settings._layoutMigrationStatus = undefined;
        this.plugin.settings._layoutMigrationOptIn = false;
        await this.plugin.saveSettings();

        new Notice(
            '已从备份恢复布局。请通过命令面板重载插件以应用旧布局。',
            10000,
        );
        this.rerender();
    }

    private async handleMigrateClick(service: AgentFolderService): Promise<void> {
        const currentPath = readStoredAgentFolder(this.plugin);
        const oldPathInput = await promptModal(this.app, {
            title: '迁移 agent 文件夹数据',
            message:
                `从哪个文件夹迁移数据？\n\n`
                + `当前 agent 文件夹为 "${currentPath}"。\n`
                + `请输入需要复制数据的旧路径。`,
            defaultValue: DEFAULT_AGENT_FOLDER,
            submitLabel: '下一步',
        });
        if (!oldPathInput) return;
        const oldPath = oldPathInput.trim();
        if (!oldPath || oldPath === currentPath) {
            new Notice('无需操作：新旧路径相同。');
            return;
        }

        const preview = await service.previewMigration(oldPath);
        const hasAnything = preview.pluginSkills.length > 0
            || preview.vaultDnaExists
            || preview.knowledgeDbExists
            || preview.memoryDbExists;
        if (!hasAnything) {
            new Notice(`未在 "${oldPath}" 找到插件数据。未迁移任何内容。`);
            return;
        }

        const parts: string[] = [];
        if (preview.pluginSkills.length > 0) parts.push(`${preview.pluginSkills.length} 个插件技能文件`);
        if (preview.vaultDnaExists) parts.push('vault-dna.json');
        if (preview.knowledgeDbExists) parts.push('knowledge.db');
        if (preview.memoryDbExists) parts.push('memory.db');
        const mb = (preview.totalBytes / (1024 * 1024)).toFixed(1);
        const summary = `${parts.join(', ')} (~${mb} MB)`;

        const confirmed = await confirmModal(this.app, {
            title: '确认迁移',
            message:
                `迁移 ${summary}\n\n`
                + `从：${oldPath}\n`
                + `到：${currentPath}\n\n`
                + `原文件保留在原处。请在确认新位置可用后手动删除。\n\n`
                + `迁移后请重载 Obsidian，以使知识和记忆数据库在新路径重新打开。`,
            confirmLabel: '迁移',
        });
        if (!confirmed) return;

        const result = await service.migrate(oldPath, currentPath);
        const summaryParts: string[] = [];
        if (result.movedPluginSkills > 0) summaryParts.push(`${result.movedPluginSkills} 个插件技能文件`);
        if (result.movedVaultDna) summaryParts.push('vault-dna.json');
        if (result.movedKnowledgeDb) summaryParts.push('knowledge.db');
        if (result.movedMemoryDb) summaryParts.push('memory.db');

        if (result.errors.length > 0) {
            new Notice(
                `迁移完成但有 ${result.errors.length} 个错误。已移动：${summaryParts.join('、') || '无'}。首个错误：${result.errors[0]}`,
                15_000,
            );
        } else if (summaryParts.length === 0) {
            new Notice('未迁移任何内容。目标位置已有相同文件。');
        } else {
            new Notice(
                `已迁移 ${summaryParts.join('、')}。请重载 Obsidian 以使知识和记忆数据库在新位置打开。`,
                15_000,
            );
        }
    }

    /**
     * FEAT-29-14: Re-runs the FirstRunWizard templates materialization
     * from the Vault settings tab. Reads the persisted templatesLanguage
     * (default 'de') and the Obsidian-Core-Templates folder. Skip-existing
     * by default; offers force-overwrite via confirm modal.
     */
    private async handleRematerializeTemplates(): Promise<void> {
        const folder = await resolveCoreTemplatesFolder(this.app);
        if (!folder) {
            new Notice(
                '未设置模板文件夹。请先启用 Obsidian 核心模板插件并选择一个文件夹。',
                8000,
            );
            return;
        }

        const tpl = this.plugin.settings.vaultIngest.templates;
        const lang = (tpl.templatesLanguage && tpl.templatesLanguage.length > 0)
            ? tpl.templatesLanguage
            : 'de';

        const force = await confirmModal(this.app, {
            title: '重新物化模板',
            message:
                `目标文件夹：${folder}\n` +
                `语言：${lang}\n\n` +
                '点击"确定"写入内置默认值，跳过已存在的文件。\n' +
                '点击"覆盖"用内置默认值替换已有文件（破坏性操作！）。',
            confirmLabel: '覆盖',
            destructive: true,
        });

        // `BUNDLED_NOTE_TEMPLATES` is imported from gitignored `_generated/`.
        // The bot's fresh-clone lint widens the type to `error`; locally
        // it resolves to `Record<string, Record<string, string>>`. The
        // `castGenerated` helper routes through an `unknown` parameter so
        // the cast is necessary in both contexts: locally it removes the
        // type mismatch, at the bot it narrows the widened error type.
        // No eslint-disable directive needed.
        const templates = castGenerated<Record<string, Record<string, string>>>(BUNDLED_NOTE_TEMPLATES);
        const materializer = new TemplateMaterializer(this.app, templates);
        const translator = (lang !== 'de' && lang !== 'en')
            ? makeTemplateTranslator(this.plugin)
            : undefined;

        try {
            const result = await materializer.materialize(folder, lang, { force, translator });
            const summary = `模板已重新物化：写入 ${result.written.length} 个，跳过 ${result.skipped.length} 个${result.failed.length ? `，失败 ${result.failed.length} 个` : ''}。`;
            new Notice(summary, 6000);
            if (result.failed.length > 0) {
                console.warn('[templates] re-materialization failures:', result.failed);
            }
        } catch (e) {
            console.error('[templates] re-materialization failed:', e);
            new Notice(`模板重新物化失败 —— ${(e as Error).message ?? String(e)}`, 10_000);
        }
    }
}
