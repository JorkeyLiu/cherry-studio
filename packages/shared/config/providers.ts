/**
 * @fileoverview Shared provider configuration (debranded).
 *
 * Historical LLM provider brand allowlists (Claude-supported provider ids,
 * Silicon Anthropic-compatible model lists/hosts) were removed: no
 * independent non-LLM consumer remains, and active request/capability
 * behavior must never branch on provider brand id. Provider ids are opaque
 * join keys only; Anthropic-protocol support follows `type === 'anthropic'`
 * plus the per-connection stored `anthropicApiHost`.
 *
 * Non-LLM provider domain stores (websearch/MCP, document preprocess) were
 * retired together with their features; nothing brand-specific remains here.
 */

export {}
