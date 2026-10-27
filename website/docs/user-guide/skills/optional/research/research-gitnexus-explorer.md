---
title: "Gitnexus Explorer"
sidebar_label: "Gitnexus Explorer"
description: "Optional code graph integration; customer activation requires commercial rights and a qualified secure bridge"
---

{/* This page is auto-generated from the skill's SKILL.md by website/scripts/generate-skill-docs.py. Edit the source SKILL.md, not this page. */}

# Gitnexus Explorer

Optional code graph integration; customer activation requires commercial rights and a qualified secure bridge.

## Skill metadata

| | |
|---|---|
| Source | Optional — install with `youtab skills install official/research/gitnexus-explorer` |
| Path | `optional-skills/research/gitnexus-explorer` |
| Version | `1.0.0` |
| Author | Youtab Agent Runtime + Teknium |
| License | MIT |
| Platforms | linux, macos, windows |
| Tags | `gitnexus`, `code-intelligence`, `knowledge-graph`, `visualization` |
| Related skills | [`youtab-agent-runtime`](/docs/user-guide/skills/bundled/autonomous-ai-agents/autonomous-ai-agents-youtab-agent-runtime), [`codebase-inspection`](/docs/user-guide/skills/bundled/github/github-codebase-inspection) |

## Reference: full SKILL.md

:::info
The following is the complete skill definition that Youtab loads when this skill is triggered. This is what the agent sees as instructions when the skill is active.
:::

# GitNexus Explorer

GitNexus can index a codebase and expose a knowledge graph of symbols, call
chains, clusters, and execution flows. This optional Skill remains visible in
Youtab's catalog, but its GitNexus integration is **unavailable in customer
builds**. Other Skills, Plugins, and Youtab's own codebase inspection remain
available.

## Why activation is locked

This Skill's MIT metadata covers the Youtab instructions only. The separate
upstream GitNexus software is currently under the
[PolyForm Noncommercial 1.0.0 license](https://github.com/abhigyanpatwari/GitNexus/blob/main/LICENSE).
Commercial use requires separate rights. The upstream
[Enterprise section](https://github.com/abhigyanpatwari/GitNexus#enterprise)
explains how a customer or organization can inquire about commercial licensing.
Youtab does not bundle or automatically download GitNexus.

The previous local web bridge also forwarded an unauthenticated API exposing
indexed source and mutating operations. On Windows, it could not prove that a
concurrently modified web build was safe to publish. The shipped proxy now
fails closed and does not open a listening port, even if a GitNexus copy is
already present. A license or self-declared approval does not bypass this
security gate.

## Customer path

1. If your organization wants GitNexus, review the upstream license and
   [contact its publisher about commercial rights](https://github.com/abhigyanpatwari/GitNexus#enterprise).
   Do not send license keys or private contracts into a chat.
2. Ask Youtab to qualify the exact licensed GitNexus version and its
   authenticated local integration. Activation needs a pinned, verified
   dependency and security acceptance for the backend and web assets.
3. Until that integration ships, use Youtab's other installed Skills and code
   inspection tools. Do not clone a moving upstream branch or run a package
   manager download as a substitute for activation.

This Skill has no install, index, web server, or remote-access command in
customer builds. A customer can manage separately licensed GitNexus outside
Youtab, but that does not activate the Youtab integration.
