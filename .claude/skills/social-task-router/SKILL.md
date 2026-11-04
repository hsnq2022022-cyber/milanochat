---
name: social-task-router
description: Routes development tasks in the إدارة سوشيال project according to complexity, minimizes unnecessary context and token usage, and protects existing project work.
---

# Social Task Router

You are working on the existing إدارة سوشيال project.

Your objective is to complete development efficiently while preserving existing functionality, project architecture, and user changes.

## 1. Project protection

- Inspect the existing project before making changes.
- Never replace the project with a new implementation.
- Never delete user files or overwrite existing work without explicit approval.
- Never run git reset --hard, git clean, force push, or destructive migrations.
- Never resolve merge conflicts by choosing one side blindly.
- Preserve existing integrations, database schemas, Edge Functions, and authentication flows.
- Do not modify production data or deployment settings without explicit authorization.

## 2. Task classification

Classify each task before implementation.

### Haiku-level tasks
Use Haiku when available for:
- Small, isolated edits.
- Simple explanations.
- Formatting and naming corrections.
- Reading a small file.
- Straightforward documentation updates.

### Sonnet-level tasks
Use Sonnet for:
- Normal feature development.
- Bug fixes involving multiple files.
- API and UI integration.
- Writing and updating tests.
- Reviewing related components.
- Implementing well-defined changes.

### Opus-level tasks
Use Opus for:
- Complex architecture decisions.
- Difficult debugging across multiple systems.
- Security and authentication problems.
- Database and RAG architecture changes.
- Complex Meta, Instagram, WhatsApp, and Salla integrations.
- Reviewing high-impact changes before implementation.

Use only models actually available in the current Claude Code session. Do not request unavailable models.

Important: This classification is guidance. Do not claim that the skill automatically switches models. If model switching is needed, use only supported Claude Code model-selection mechanisms.

## 3. Token efficiency

- Read only files relevant to the current task.
- Avoid repeatedly reading large files.
- Search for symbols and references before opening entire files.
- Do not repeat investigations already completed.
- Keep a concise record of confirmed findings.
- Separate confirmed facts from assumptions.
- Do not load the entire repository into context unnecessarily.
- Delegate only independent, well-defined tasks when supported.
- Avoid unnecessary subagents and repeated summaries.

## 4. Development workflow

For every substantial task:

1. Inspect the relevant code and existing architecture.
2. Identify dependencies and possible side effects.
3. State the intended changes briefly.
4. Implement the smallest safe solution.
5. Run relevant tests, type checks, or builds when available.
6. Inspect the resulting diff.
7. Report exactly what changed and what remains unverified.

Do not claim a test passed unless it was actually executed successfully.

## 5. Project-specific priorities

Preserve the existing product direction:

- Arabic-first, RTL interface.
- Iraqi Arabic and supported Gulf dialects.
- Instagram, Facebook, and WhatsApp integrations.
- AI customer support and sales automation.
- Knowledge-based answers without invented prices or unsupported claims.
- Existing Supabase architecture and Edge Functions.
- Existing tenant isolation, authentication, and permissions.

Do not redesign unrelated parts of the product during a focused bug fix.

## 6. Failure handling

If an implementation fails:

- Read the actual error.
- Identify its root cause.
- Do not repeat the same failed approach without new evidence.
- Reconsider the implementation before making another change.
- Escalate complex reasoning to a stronger available model when appropriate.
- Never invent successful results.

## 7. Progress tracking

For substantial multi-step work, maintain concise project notes only when useful:

- .router/CONTEXT.md
- .router/PLAN.md
- .router/PROGRESS.md

Before creating or modifying these files, inspect whether they already exist and preserve their contents.

Record confirmed decisions, completed work, test results, and remaining tasks.

## 8. Git safety

- Inspect git status before making changes.
- Preserve staged and unstaged user changes.
- Do not commit or push unless explicitly requested.
- If merge conflicts exist, stop and report them before touching conflicted files.
- Do not stage unrelated files.
- Review the exact diff before proposing a commit.

## 9. Final report

After completing a task, report:

- What was changed.
- Which files were affected.
- Tests actually executed and their results.
- Any unresolved risks or limitations.
- The next necessary step, if one exists.
