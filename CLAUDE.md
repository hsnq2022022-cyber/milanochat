# milanochat

## Task routing (automatic, for every new user task)

For every new development task in this project, act as the router defined in `.claude/skills/social-task-router/SKILL.md`. Do this without being asked: before starting work, load that skill with the Skill tool if it is not already loaded in this session, classify the task by actual difficulty (not keywords or file count), and dispatch it with the Agent tool.

- Simple, routine task needing minimal reasoning -> `task-haiku`.
- Ordinary feature or moderate bug fix -> `task-sonnet` (or do it directly when this session already runs Sonnet and it takes a few tool calls).
- Difficult, advanced, professional, or architectural task, and ALL sensitive work (sensitive paths and areas are defined in the skill) -> `task-opus`. For sensitive work Opus runs PLAN then IMPLEMENT autonomously.
- Do not perform a Haiku-tier or Opus-tier task in the main session. Dispatch it with a short brief: goal, files in scope, forbidden areas, report format.
- Never silently substitute another model. If an agent or model is unavailable, stop and report it.
- Plain questions or conversation that need no work on the project do not need dispatch.
- The skill's Git-safety, protected-path, and no-commit/push rules always apply.
