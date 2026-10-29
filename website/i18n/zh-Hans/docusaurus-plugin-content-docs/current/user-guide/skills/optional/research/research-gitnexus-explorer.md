---
title: "Gitnexus Explorer"
sidebar_label: "Gitnexus Explorer"
description: "可选 GitNexus 代码图谱集成的商业许可和安全要求"
---

{/* This page is auto-generated from the skill's SKILL.md by website/scripts/generate-skill-docs.py. Edit the source SKILL.md, not this page. */}

# Gitnexus Explorer

可选的 GitNexus Explorer Skill 仍在 Youtab 目录中。客户版本中的 GitNexus 集成
在完成许可和安全验证之前不可用；其他 Skills 和 Plugins 不受影响。

## Skill 元数据

| | |
|---|---|
| 来源 | 可选 — 使用 `youtab skills install official/research/gitnexus-explorer` 安装 |
| 路径 | `optional-skills/research/gitnexus-explorer` |
| 版本 | `1.0.0` |
| 作者 | Youtab Agent Runtime + Teknium |
| Skill 许可证 | MIT；GitNexus 上游另有许可证 |
| 平台 | linux, macos, windows |
| 标签 | `gitnexus`, `code-intelligence`, `knowledge-graph`, `visualization` |
| 相关 skill | [`youtab-agent-runtime`](/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-youtab-agent-runtime), [`codebase-inspection`](/user-guide/skills/bundled/github/github-codebase-inspection) |

## 参考：完整 SKILL.md

:::info
以下为 Youtab 触发此 Skill 时加载的说明。
:::

# GitNexus Explorer

GitNexus 可以为代码库建立索引，并提供符号、调用链、聚类和执行流的知识图谱。
此可选 Skill 仍显示在 Youtab 目录中，但其 GitNexus 集成在客户版本中
**尚未启用**。其他 Skills、Plugins 及 Youtab 自带的代码库检查能力仍可使用。

## 禁用原因

此 Skill 的 MIT 元数据仅适用于 Youtab 的说明文件，不涵盖独立的 GitNexus 软件。
GitNexus 上游目前采用
[PolyForm Noncommercial 1.0.0 许可证](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE)。
商业使用需要另行取得权利。上游
[Enterprise 说明](https://github.com/abhigyanpatwari/GitNexus#enterprise)
提供商业许可的咨询方式。Youtab 不捆绑或自动下载 GitNexus。

此前的本地 Web 桥接会转发未经身份验证的 API，可能暴露已索引的源码并执行修改。
在 Windows 上，该桥接也无法证明并发修改的 Web 构建文件可以安全发布。
随附的代理现在会拒绝启动且不会监听端口，即使已有 GitNexus 副本也是如此。
许可证或自行声明已获批准不会绕过此安全限制。

## 客户后续步骤

1. 如组织需要 GitNexus，请先阅读上游许可证，并
   [联系发布者取得商业使用权](https://github.com/abhigyanpatwari/GitNexus#enterprise)。
   不要在聊天中发送许可证密钥或私人合同。
2. 请 Youtab 对获得许可的确切 GitNexus 版本及经过身份验证的本地集成进行验证。
   启用前需要固定并验证依赖版本，并通过后端与 Web 文件的安全验收。
3. 在集成正式提供之前，使用 Youtab 已安装的其他 Skills 和代码检查工具。
   不要克隆不断变化的上游分支或通过包管理器下载来代替正式启用。

客户版本中的此 Skill 不提供安装、索引、Web 服务或远程访问命令。
客户可以在 Youtab 之外自行管理另行获得许可的 GitNexus，
但这不会启用 Youtab 集成。
