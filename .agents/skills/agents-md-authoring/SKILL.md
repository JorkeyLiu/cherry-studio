---
name: agents-md-authoring
description: Authoring and maintenance guide for the repository-root AGENTS.md — the always-on cognitive and behavioral contract for AI agents working in a codebase. Use when creating, restructuring, reviewing, or maintaining a repository-root AGENTS.md (or a CLAUDE.md / tool-compatibility entry that mirrors it). Governs only the root-level AGENTS.md; nested/subdirectory AGENTS.md files are explicitly out of scope and remain locally scoped overlays.
---

# AGENTS.md Authoring

Guide for authoring and maintaining a repository-root `AGENTS.md`. It encodes
durable principles about what a root agent guide should and should not contain,
so future sessions and projects do not need to rediscover them. This guide is
project-agnostic: it describes the *form* of a root `AGENTS.md`, never the
content of any particular project.

## Applicability boundary

- This skill governs **only the repository-root `AGENTS.md`** — the always-on
  repository contract that every agent reads at the start of a session.
- It explicitly does **not** prescribe content for **nested or subdirectory
  `AGENTS.md` files**. Those remain local overlays and may appropriately contain
  low-level, scope-local instructions for the directory they sit in. Whether a
  project uses nested `AGENTS.md` files at all, and what they contain, is out of
  scope here.
- It applies when creating, restructuring, reviewing, or maintaining the root
  `AGENTS.md`, and when setting up or fixing a `CLAUDE.md` or other
  tool-specific entry that must mirror it.

## What root AGENTS.md is

Root `AGENTS.md` is an **always-on cognitive and behavioral contract**: it tells
an agent what system it commands, who owns what, how intent and state move,
what the agent may and may not do, and what counts as done. It is **not**:

- a README (project introduction, badges, or human onboarding);
- a directory map or "first grep here" navigation aid;
- a code-search shortcut or index of every file worth knowing;
- an exhaustive inventory of services, slices, strings, or preserved artifacts;
- a task journal or change log;
- a replacement for source code, detailed architecture docs, or ADRs.

Agents and their tools can locate code; the guide exists to give the agent a
correct frame for interpreting what it finds.

## Value is not measured by shortness

A root `AGENTS.md` has no target word count. Its value is whether it carries
the **minimum complete set of highest-value information** an agent needs to
command the project. Length is acceptable — even necessary — when every section
materially improves the agent's connection to the project or its correctness.
The failure mode is not "too long"; it is "long with low density" or "short by
omitting what changes agent behavior." Trim only what does not change behavior,
not what merely adds length.

## The two layers a root AGENTS.md balances

A durable root guide carries two layers, and both are required:

### 1. High-dimensional repository connection

The cognitive layer: enough relationship-level understanding that the agent can
interpret specialist evidence and reason about the system as a whole. In
practice this includes, as applicable to the project:

- **Product/system meaning** — what the system is, what it is for, and what
  decisions govern its identity and boundaries.
- **Runtime or organizational responsibility** — which runtime role, process,
  or team owns which capability; exposure is not ownership.
- **Authority and projection** — where authoritative state lives versus where
  it is merely rendered, cached, or imported; treating a projection as
  authoritative is a class of bug.
- **State and request flow** — the one spine every user or external action
  follows through the system.
- **Change propagation** — how to classify a change by the boundary it crosses,
  because risk follows the boundary, not the diff size.
- **Evidence and judgment** — what counts as evidence for what claim, and who
  interprets it.

This layer must express **relationships, ownership, semantics, causality,
invariants, and decision boundaries**. It must not degenerate into directory /
service / slice / string inventories, "delete or preserve" lists, or "first
grep here" guidance — specialists and tools locate code.

### 2. Explicit repository rules

The behavioral layer: rules every relevant agent must follow without asking.
This includes, as applicable:

- **Authorization boundaries** — what the agent may and may not do (for
  example, git operations require explicit user authorization).
- **Validation gates** — what must pass before a task is complete (lint, test,
  format, typecheck, generated-file checks).
- **Validation mechanics are routed, not duplicated** — the root guide states
  which gates are mandatory and what counts as success (a trustworthy original
  exit code for the exact worktree state); conditional execution mechanics —
  timeout budgets, output logging, retry, evidence reuse, cleanup — belong in a
  dedicated validation skill, never in the root guide.
- **Environment / runtime constraints** — pinned toolchains, native ABI
  constraints, state-switching rules, anything where a wrong environment
  silently produces wrong results.
- **Test / evidence standards** — what evidence establishes which claim, and
  when rendered/interactive verification is required.
- **Security, logging, i18n, and style conventions** — cross-cutting rules that
  apply to every edit.
- **Skill routing** — which named skill covers which class of task, and how to
  proceed if a referenced skill is missing.

## Where content belongs (routing decisions)

Root `AGENTS.md` is one owner among several. When deciding where a fact or rule
lives, route by these defaults:

| Content | Owner |
|---|---|
| Rules every relevant agent must follow unconditionally | root `AGENTS.md` |
| Conditional / procedural how-to for a class of task | a skill |
| Conditional validation mechanics (timeout, log, retry, cleanup, evidence reuse) | a dedicated validation skill |
| Detailed human / reference material (tables, walkthroughs, rationale) | docs |
| Canonical decision tables, low-dimensional facts, inventories | source or detailed architecture docs |
| Irreversible / governance decisions (identity, release, platform, migration) | ADRs or their equivalent |
| Scope-local rules for one directory | that directory's nested `AGENTS.md` |

The root guide should **link to canonical sources** rather than duplicate them.
Do not duplicate a canonical decision table or a volatile inventory in the root
guide; point at the authoritative location and state why it matters.

## CLAUDE.md and other tool-specific entries

When a project retains a `CLAUDE.md` or other tool-specific entry file:

- Prefer it to be a **compatibility link or pointer** to the one canonical root
  `AGENTS.md`, not a separately maintained contract with independent text.
- If the tooling cannot follow links or symlinks, use a **generated or
  synchronized copy** with a single source of truth (a sync script, a
  byte-equality check, or a documented regenerate step) so the copies cannot
  drift. Never maintain two independent texts by hand.

## Authoring workflow

1. **Inventory current content by semantic role.** Walk the existing guide (or
   the accumulated context if one does not exist) and tag each chunk: cognitive
   connection, explicit rule, conditional procedure, reference detail, volatile
   inventory, task journal.
2. **Identify project meaning, authority, and propagation.** Distill what the
   system is, who owns what, and how a change propagates — in relationships,
   not paths.
3. **Identify mandatory behaviors.** Enumerate the unconditional rules every
   agent must follow (authorization, gates, environment, evidence, style).
4. **Move conditional / detailed / volatile content to correct owners.** Route
   procedures to skills, detail to docs, canonical facts to source/ADRs,
   scope-local rules to nested `AGENTS.md`. Keep only what must be in the root.
5. **Write a coherent root mental model.** Make the cognitive layer read as one
   connected model, not a bullet dump of disconnected facts.
6. **Add concise skill and doc routing.** List the skills/docs that cover the
   conditional and detailed work, with enough signal to choose correctly.
7. **Validate links and tool compatibility.** Check every link resolves, and
   that any tool-specific entry (`CLAUDE.md` or equivalent) still mirrors the
   root guide.
8. **Compare old norms clause-by-clause.** Diff the new guide against the old
   one norm by norm (every MUST / NEVER / validation gate / git rule / security
   rule) so no gate is lost in the restructure.

## Review checklist

Before finishing, confirm:

- Can a main agent, reading only the root guide, understand **what system it
  commands** and interpret specialist evidence?
- Are **responsibilities and authority** clear (who owns what, what is
  authoritative vs. projected)?
- Are **mandatory rules explicit** rather than implied or buried?
- Are **conditional validation mechanics routed to a skill** — the guide states
  which gates are mandatory and the trustworthy-exit-code success standard, while
  timeout budgets, logging, retry, evidence-reuse, and cleanup procedure live in
  a dedicated validation skill rather than being duplicated in the root guide?
- Is content **high value** rather than merely concise? (Would removing it
  change agent behavior?)
- Are **code-location, detailed, and volatile lists externalized** to
  source/docs/skills, with the root guide linking to them?
- Are **nested `AGENTS.md` files explicitly unaffected** — no instructions here
  purport to govern subdirectory guides?
- Are **tool-specific duplicates prevented** — one canonical root, with links or
  synchronized copies?
- Did any old **MUST / NEVER / validation / git / security rule weaken** during
  the restructure?

## Anti-patterns

Avoid these shapes in a root `AGENTS.md` (examples are generic, not tied to any
project):

- A **directory dump**: "`src/` contains X, `lib/` contains Y, `tools/` contains
  Z" with no statement of relationships or authority.
- A **code-search shortcut list**: "UI bug → look in the UI folder; API bug →
  look in the services folder; storage bug → look in the database folder."
  Location is specialist work; the root guide's job is the frame, not the map.
- A **full inventory** of every service, schema table, configuration key, or
  string that must not be renamed, with no statement of which invariant the
  inventory protects.
- A **duplicated canonical table**: re-pasting a decision table that already
  lives authoritatively in an ADR or architecture doc, so the two can drift.
- A **task journal**: "As of <date>, we are migrating from X to Y; last week we
  fixed Z." Volatile state belongs in issues/tracking, not the always-on guide.
- **Two independently maintained contracts**: a root `AGENTS.md` and a separate
  `CLAUDE.md` with different text and no sync mechanism, so agents read
  conflicting instructions depending on which file their tool loads.
- A **procedural validation dump**: embedding timeout tables, retry matrices, or
  log-handling procedure in the root guide when a dedicated validation skill
  owns that detail, so the always-on contract duplicates volatile mechanics and
  drifts from the skill.
