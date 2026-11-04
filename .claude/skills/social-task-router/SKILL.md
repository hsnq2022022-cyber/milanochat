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

Evaluate every new user request dynamically before choosing a model. Do not match keywords or task names. The examples below are illustrative, not an exhaustive or fixed list.

### Haiku - simple tasks
Simple, straightforward work needing minimal reasoning or basic coding knowledge, completable safely without deep investigation.
Examples: obvious minor bug fixes; changing text, labels, colors, icons, or spacing; small UI adjustments; simple code corrections; minor changes to existing components; other routine tasks.

### Sonnet - above-simple / moderate tasks
More involved than simple: needs reasonable programming knowledge, analysis, or several implementation steps, but no advanced professional expertise or complex engineering decisions. Sonnet is the default for ordinary feature development and normal bug fixing that is beyond Haiku's scope.
Examples: ordinary features; fixes that require investigating the cause; creating or modifying React components; forms, filters, settings, and standard pages; improving existing functionality; connecting existing components or APIs using established patterns; moderate changes across multiple files.

### Opus - difficult, advanced, and professional tasks
Needs advanced expertise, deep reasoning, professional-level implementation, complex problem-solving, or significant architectural or design decisions.
Examples: complete professional UI/UX redesigns; rebuilding major interface systems or dashboards; complex new features requiring substantial engineering; designing or rebuilding automation engines and workflows; major architectural changes or refactoring; difficult bugs across interconnected systems; complex integrations and advanced security work; tasks where quality depends on expert-level judgment.

### Classification rules
1. Determine actual difficulty before selecting a model, using: technical difficulty; reasoning depth required; programming expertise required; number and complexity of implementation steps; architectural and design decisions; cross-system dependencies; risk and impact of mistakes; required quality and professional standards.
2. Never classify by keywords, task names, or file count alone. "Add a feature" or "fix a bug" does not fix the tier: simple goes to Haiku, ordinary or moderate to Sonnet, complex or professional or interconnected to Opus.
3. Do not use Opus for routine work. Never downgrade a genuinely difficult task to Haiku or Sonnet merely to save usage.
4. If a request has several distinct subtasks that can be safely separated (disjoint files, no shared dependency; see Concurrency in section 10), classify each by its own difficulty. Otherwise use the tier able to handle the complete task.
5. Security-sensitive work and protected project areas always go to Opus regardless of apparent simplicity, size, or number of files (definition in section 10). Opus executes PLAN -> IMPLEMENT autonomously, with no user approval gate.
6. If Haiku or Sonnet finds the task exceeds its level, it stops and escalates to the router.

### Router behavior before dispatch
Understand the complete request; inspect relevant project context only when necessary; evaluate actual difficulty and expertise; select exactly one tier per task; dispatch it to the matching agent (unless section 10 says the current session can finish it directly; that shortcut never applies to sensitive work).

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

## 10. Subagent dispatch

Agents live in `.claude/agents/`: `task-haiku` (model: haiku), `task-sonnet` (model: sonnet), `task-opus` (model: opus). Section 2 stays the classification guide; this section is how to act on it.

**Do not dispatch** non-sensitive work when the current session's own model already matches the task's tier (section 2) and it can finish the task in a few tool calls; an agent costs a cold start and its own context. When the task's tier differs from the current session's model (for example a simple task in a Sonnet session, or a complex task in a Sonnet session), dispatch to the matching agent. This shortcut never applies to sensitive work: sensitive work is ALWAYS routed to `task-opus`, regardless of apparent simplicity, size, or number of files, and this rule takes absolute priority over the shortcut. The current session, Haiku, and Sonnet must never bypass it.

**Routing (by actual difficulty per section 2, not cheapest by default):** `task-haiku` for simple tasks, `task-sonnet` for moderate tasks and as the default for ordinary development and normal bug fixing, `task-opus` for difficult, advanced, and professional tasks and for every sensitive task.

**Sensitive definition (single source; the three agent files repeat it verbatim):**
- Sensitive paths: `supabase/**` (functions, migrations, proposals, rollbacks, `*.sql`), `.github/workflows/**`, `.env*`, `server/src/rag/**`, `server/src/wa/**`, `server/src/middleware/**`, `server/railway.json`.
- Sensitive areas, wherever the code lives: authentication, permissions, tenant isolation (`tenant_id`), database schema/migrations, RAG, webhooks, billing/payments, secrets, deployment/CI, Meta/Instagram/WhatsApp/Salla/Wayl integrations, and security reviews.
- Sensitive work goes directly to Opus regardless of edit size or apparent simplicity. Haiku and Sonnet never modify sensitive paths, including comments and typo fixes.
- Architecture, refactoring, and cross-system debugging are complex, not sensitive, unless they touch the paths or areas above.

**Opus phases and mode selection:** the router chooses the mode explicitly in every Opus brief.
- Sensitive changes: Opus runs PLAN -> IMPLEMENT autonomously. PLAN is an internal analysis and planning phase, not an approval gate: send `MODE=PLAN`, check the returned plan against the requested scope, then send `MODE=IMPLEMENT` immediately (or send one `MODE=IMPLEMENT` brief that requires an internal plan first). Do not wait for, or ask for, user confirmation. The user's request authorizes implementation within the scope it explicitly states; the brief lists those files.
- Complex but non-sensitive tasks: send `MODE=IMPLEMENT` directly. Opus investigates, picks the smallest safe solution, and implements it in one session, with no PLAN/approval cycle. The user's task request authorizes implementation within the scope it explicitly states; the brief lists those files.
- `MODE=PLAN`: analysis and planning, no file changes. `MODE=REVIEW`: read-only review of code or a diff, no modifications and no approval cycle (security reviews use it); use it when the user asks for a review or to verify a sensitive change the router did not write.
- Out-of-scope work: if additional work is needed beyond the explicitly requested scope, do not perform it, do not escalate it to Opus automatically, and do not ask for approval. Complete the original authorized task wherever possible and report the scope limitation. Do not request approval for ordinary implementation, architecture, or security-fix decisions within the requested scope. Reassess complexity from scratch if the user later explicitly expands the scope.
- Production-impacting or destructive database changes, deployments, secrets, and similarly high-risk actions always need separate explicit user approval. Agents never apply migrations, deploy functions, or touch secrets.

**Brief each agent with:** goal, exact files in scope, confirmed findings (not re-investigation), forbidden areas, and the report format. Do not paste the conversation or the whole skill.

**Concurrency:** one writing agent per file set. Parallel agents only for read-only work or disjoint files. Track which files each running agent owns, and do not start a writer on a file another running agent owns; wait for it to finish.

**Duplicate work:** keep a short ledger of confirmed findings (question, files examined, answer) and of dispatched tasks (agent, files, status). Before any dispatch, check it: reuse an existing finding instead of re-reading the same files, and never send the same task to a second agent. Pass agents the relevant findings, not the investigation again. Do not send two agents the same question in parallel.

**Escalation:** on `ESCALATE`, re-dispatch with the agent's findings and reason. Haiku and Sonnet must stop and escalate to the router when a task exceeds their level; they never continue beyond it. Haiku goes to Sonnet for moderate tasks, and to Opus for sensitive, complex, or professional-redesign tasks. Sonnet goes to Opus for sensitive, architectural, advanced, or professional-redesign work. Out-of-scope needs are not an escalation reason: report them as scope limitations. Opus reports to the router (`BLOCKED`, or `NEEDS_APPROVAL` read as a scope limitation) and does not ask for approval of in-scope decisions. Agents never delegate to other agents; only the router re-dispatches. Do not retry the same tier without new evidence.

**Model availability:** if a required model is unavailable or the call is rejected, stop and tell the user. Never silently substitute another model.

**Review and verification:** the router reviews each report and the resulting diff. Record per task: agent, requested model, model confirmed (or "unverified"), status. Check running agents with `/tasks`. Report tests as passed only if actually run.
