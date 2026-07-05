# Vault Operator 中文汉化

基于官方 [Vault Operator](https://github.com/pssah4/vault-operator) v3.2.0 源码构建的中文汉化版本。

## 快速安装

### 方式一：直接下载构建产物（推荐）

1. 下载 `dist/` 目录下的三个文件：`main.js`、`manifest.json`、`styles.css`
2. 在 Obsidian 中先安装官方 Vault Operator 插件并启用一次（确保插件目录存在）
3. 关闭 Obsidian
4. 把下载的三个文件复制到插件目录，覆盖同名文件：
   - macOS：`<你的知识库>/.obsidian/plugins/vault-operator/`
   - Windows：`<你的知识库>\.obsidian\plugins\vault-operator\`
5. 重新打开 Obsidian，界面即为中文

### 方式二：克隆本仓库

```bash
git clone https://github.com/jfpeng20-dev/Vault-Operator-zh.git
cd Vault-Operator-zh/dist
```

然后把 `dist/` 里的三个文件复制到插件目录覆盖即可。

## 切换语言

默认显示中文。如需切回英文，打开 Obsidian 开发者控制台（macOS：`Cmd+Option+I`，Windows：`Ctrl+Shift+I`），在 Console 中执行：

```js
localStorage.setItem('vault-operator-ui-lang', 'en')
```

重新加载 Obsidian 即可。切回中文：

```js
localStorage.removeItem('vault-operator-ui-lang')
```

## 汉化范围

- 设置面板全部标签页（服务提供商、模型、嵌入向量、网页搜索、MCP、智能体、自动批准、运行循环、记忆、规则、工作流、技能、提示词、界面、外壳、日志、调试、备份、知识库、语言）
- 聊天侧栏（消息、工具活动、批准卡片、检查点、错误提示）
- 所有模态框（模型配置、差异审阅、知识库健康修复等）
- Onboarding 引导流程
- 命令面板
- 14 个内置技能的描述

共计 1420 个 i18n 翻译键 + 180+ 处硬编码 UI 字符串 + 14 个技能描述。

## 仓库结构

```
.
├── dist/                       # 可直接使用的构建产物
│   ├── main.js                 # 已汉化的插件主程序（5.2 MB）
│   ├── manifest.json           # 插件清单（v3.2.0）
│   ├── styles.css              # 样式表（原版未改）
│   └── 安装说明.md             # 详细安装步骤
└── source/                     # 源码改动（便于维护和重新构建）
    ├── zh.ts                   # 中文翻译字典（1420 个键）
    ├── index.ts                # i18n 入口（locale 检测逻辑）
    ├── VaultTab.ts             # 知识库设置页（硬编码字符串已汉化）
    ├── SkillsTab.ts            # 技能设置页（硬编码字符串已汉化）
    └── bundled-skills/         # 14 个内置技能（description 已汉化）
        ├── humanizer/SKILL.md
        ├── ingest/SKILL.md
        ├── ...
        └── vault-operator-guide/SKILL.md
```

## 重新构建（插件更新后）

当官方插件更新版本后，可按以下步骤重新构建汉化版：

```bash
# 1. 克隆官方源码
git clone https://github.com/pssah4/vault-operator.git
cd vault-operator
npm install

# 2. 把本仓库 source/ 下的文件覆盖到官方源码对应位置
#    - source/zh.ts           → src/i18n/locales/zh.ts（新建）
#    - source/index.ts        → src/i18n/index.ts（覆盖）
#    - source/VaultTab.ts     → src/ui/settings/VaultTab.ts（覆盖）
#    - source/SkillsTab.ts    → src/ui/settings/SkillsTab.ts（覆盖）
#    - source/bundled-skills/ → bundled-skills/（覆盖）

# 3. 构建
node esbuild.config.mjs production

# 4. 把产物 main.js / manifest.json / styles.css 拷到插件目录
```

构建要求：Node.js 18+，桌面端 Obsidian 1.13+。

## 技术说明

汉化基于官方 i18n 框架（`src/i18n/`）实现：

- 新增 `zh.ts` 中文翻译字典，与 `en.ts` 逐键对齐（1420 个键）
- 修改 `index.ts` 的 `t()` 函数，加入 locale 检测：`localStorage` 显式覆盖 → Obsidian 界面语言 → 浏览器语言 → 默认中文
- `t()` 查找顺序：当前语言 → 英语回退 → 原始 key，确保任何漏译不会显示为空白
- `VaultTab.ts` 和 `SkillsTab.ts` 中未经 `t()` 的硬编码英文字符串直接替换为中文
- 14 个内置技能的 `SKILL.md` frontmatter `description` 字段译成中文

## 致谢

- 原插件作者 [pssah4](https://github.com/pssah4)，采用 Apache 2.0 开源协议
- Vault Operator 官方仓库：https://github.com/pssah4/vault-operator

## License

Apache 2.0（与原插件一致）
