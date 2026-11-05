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

## 2. Task analysis and strict model routing

Before implementation, you MUST strictly classify the task. Do not overthink this.

### 🚨 STRICT ROUTING RULES (NON-NEGOTIABLE)
- **Default Model:** You are FORBIDDEN from using Opus unless the task EXPLICITLY matches the Opus conditions below. Default to Sonnet.
- **Delegation:** You MUST use the `Task` tool to delegate tasks to the specific model. Do not just "act" like the model.
- **No Opus for Reading:** You are FORBIDDEN from using Opus to read files, search code, or run basic terminal commands.

### Haiku-level (MUST delegate to Haiku using Task tool)
- Reading specific files (when path is provided).
- Searching for a specific symbol or string (grep).
- Formatting, naming, or simple text replacements.
- Running standard tests or build commands.
- *Rule:* If the task is just retrieving information or making a 1-line change, USE HAIKU.

### Sonnet-level (Default for implementation)
- Writing new code, building features.
- Fixing standard bugs.
- Modifying files across multiple directories.
- UI/API integration.
- *Rule:* If you are writing code, use SONNET.

### Opus-level (STRICTLY RESTRICTED)
You may ONLY use Opus if the task strictly requires one of the following:
1. Designing a completely new system architecture from scratch.
2. Debugging a critical failure that Haiku and Sonnet have already failed to fix (provide proof of failure).
3. High-risk security or authentication changes.
- *Rule:* Do not use Opus just because the word "Supabase" or "Instagram" is mentioned.

### Escalation
- Start with Sonnet (or Haiku for reads).
- ONLY escalate to Opus if Sonnet explicitly returns an error or states it cannot complete the task.
- Pass concise context when escalating; never re-read the whole project.

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
