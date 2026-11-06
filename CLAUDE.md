# CLAUDE.md

## Проектът

archgraph е нодова карта на архитектурата на кода (PHP, Node, Python): engine, MCP сървър, нодов UI и VS Code разширение. Виж [README.md](README.md).

**Claude е водещ на проекта и негов основен потребител.** Claude взима техническите решения и пише кода. Собственикът (Камен) определя приоритетите, тества върху истински проекти и одобрява commit, push и нови зависимости. Разговорът е на български.

## В началото на всяка сесия

1. `docs/PLAN.md` – на кой етап сме.
2. `docs/DECISIONS.md` – взетите решения. Не се преразглеждат без нова причина.
3. `.tasks/` – задачите в Kaizen. Взимай само задачи със завършени зависимости.

## Правила

- Ново архитектурно решение → нов запис в `docs/DECISIONS.md`.
- Завършен етап → маркирай го ✅ в `docs/PLAN.md`.
- Всичко отвъд езиковите адаптери работи само с общия модел (`packages/model`) и не знае за PHP, Node или Python.
- Всеки адаптер и всяко правило се тества срещу fixture проект с `expected.json`.
- Без нови зависимости, без commit и без push без одобрение.

## Task System

This project uses a file-based task management system. Tasks are in `.tasks/` directory.

### Reading Tasks

- Check `.tasks/` for your assigned tasks (assignee: claude-code)
- Parse YAML frontmatter for metadata (status, priority, dependencies)
- Read Markdown body for requirements (Description, Acceptance Criteria, Subtasks, Context)
- Respect dependency order — do not start a task if its dependencies are not `done`

### Working on Tasks

1. Before starting: change status to `in-progress` (update frontmatter `status` field)
2. Update `updated` timestamp when modifying a task
3. Check off subtasks as you complete them (`- [x]`)
4. Add progress notes in the `## Notes` section
5. When finished: change status to `review`

### Task Format

Tasks use YAML frontmatter (between `---` markers) + Markdown body.
Frontmatter fields: id, title, status, priority, created, updated, assignee, dependencies, tags, estimate, branch.
Body sections: ## Description, ## Acceptance Criteria, ## Subtasks, ## Context, ## Notes.

### Git Workflow

If Git integration is enabled for this project:

- When you change a task status to `in-progress`, a branch `task/TASK-{NNN}` is created automatically
- Commit your work to this branch
- When you change status to `review`, the branch is pushed and a Merge Request / Pull Request is created automatically
- ALWAYS commit and push your changes BEFORE changing status to `review`
- The `branch` and `mr_url` frontmatter fields are auto-populated — do not edit them manually

### Rules

- NEVER change a task's `id` or `created` fields
- ALWAYS update `updated` timestamp on any modification
- NEVER start a task with unfinished dependencies (status != done)
- ALWAYS mark status as `review` (not `done`) when you finish — human reviews and marks done
- If blocked, change status to `blocked` and explain in ## Notes
