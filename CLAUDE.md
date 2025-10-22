# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

MCP (Model Context Protocol) server for TaskWarrior that provides comprehensive task management and reporting capabilities. The server implements 17 total MCP tools covering task manipulation, reporting, and analytics operations.

## Architecture

### Single File Structure
- `index.ts` - Main server implementation containing all MCP server logic
- No separate source directory - all code is in the root TypeScript file

### Core Components
- **MCP Server Setup**: Uses `@modelcontextprotocol/sdk` for server implementation with stdio transport
- **Zod Schemas**: Comprehensive schema definitions for request/response validation and TaskWarrior field types
- **Tool Handlers**: 17 tools that execute TaskWarrior CLI commands via `execSync`
- **Shell Escaping**: `escapeShellArg()` function (index.ts:21) prevents injection attacks using single-quote escaping
- **Date Parsing**: `parseFlexibleDate()` (index.ts:27) validates both ISO timestamps and TaskWarrior shorthands (+7d, eom, monday, etc.)
- **Argument Builder**: `buildTaskModifyArgs()` (index.ts:59) constructs modify commands with proper escaping

### TaskWarrior Integration
- Direct CLI execution using `execSync` from Node.js child_process module
- Current implementation: 17 comprehensive MCP tools covering TaskWarrior's core functionality
- Commands: task management, reporting, filtering, bulk operations, and advanced workflows
- CLI pattern: Dynamic argument array construction, joined with spaces
- Output handling: Raw CLI text output, 10MB maxBuffer for large datasets
- Error handling: execSync throws on non-zero exit codes
- Requires TaskWarrior (`task`) binary installed and configured on system

### CLI Integration Pattern
```typescript
const content = execSync(`task ${args.join(" ")}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
```

### TaskWarrior Command Categories Available for Extension
1. **Task Management**: add, modify, annotate, append, prepend, edit, done, delete, start, stop, duplicate, purge, log
2. **Reporting**: Built-in reports (next, list, all, active, completed, blocked, overdue, ready, recurring) and custom reports
3. **Data Operations**: import, export, synchronize, undo
4. **System**: config, context, count, calc, help, version
5. **Visualization**: burndown charts, calendar, history, summary, timesheet

### Tool Operations (17 Total)

**Core Task Management (3)**:
1. **get_next_tasks**: Lists pending tasks with optional project/tag filtering
2. **add_task**: Creates new tasks with description, due date, priority, project, tags, and dependencies
3. **mark_task_done**: Marks tasks complete by ID or UUID

**MVP Critical Functions (7)**:
4. **modify_task**: Update task attributes (priority, due date, project, etc.)
5. **modify_tasks_bulk**: Bulk modifications using TaskWarrior filter syntax
6. **list_tasks_filtered**: Comprehensive task queries with filtering and report types
7. **delete_task**: Remove tasks from TaskWarrior database (with confirmation override)
8. **count_tasks**: Task metrics by status, project, priority
9. **annotate_task**: Add contextual notes to tasks
10. **get_task_info**: Detailed task inspection and information

**Extended Functions (4)**:
11. **append_task**: Append text to task descriptions
12. **prepend_task**: Prepend text to task descriptions
13. **duplicate_task**: Clone existing tasks
14. **undo_last**: Revert last TaskWarrior operation

**Reporting System (3)**:
15. **builtin_report**: Standard TaskWarrior reports (list, all, active, completed, blocked, overdue, ready, recurring)
16. **visualization_report**: Visual reports (burndown, calendar, history, summary, timesheet)
17. **custom_report**: User-defined columns and filters for any report type

### Custom Report Usage Examples

**Basic filtering**:
```json
{"report": "list", "filter": "project:Testing"}
{"report": "next", "filter": "priority:H"}
{"report": "list", "filter": "urgency.above:15"}
```

**Combined filters**:
```json
{"report": "list", "filter": "priority:H and project:Testing"}
{"report": "active", "filter": "project:Work and +urgent"}
```

**Custom columns**:
```json
{"report": "list", "columns": ["id", "description", "urgency"]}
{"report": "completed", "columns": ["id", "end", "description"]}
```

**Filter + custom columns**:
```json
{"report": "list", "filter": "priority:H", "columns": ["id", "project", "priority", "description"]}
```

**Command Construction Pattern**:
- Filter placement: `task [filter] [report] [column_config]`
- Column syntax: `rc.report.[report_name].columns=[cols] rc.report.[report_name].labels=[labels]`
- Supports all TaskWarrior filter syntax including logical operators and field comparisons

### Schema Constraints
- Project names: alphanumeric with dots, hyphens, underscores (`/^[a-zA-Z0-9._-]+$/`)
- Tags: lowercase alphanumeric with hyphens, underscores, @ symbols (`/^[@a-z0-9_-]+$/`)
- Priority: "H", "M", "L" only
- Task identifiers: strings (supports both ID and UUID)
- Dependencies: array of task IDs/UUIDs (passed as comma-separated to TaskWarrior)
- Reports: Built-in enum validation for standard report types
- Custom reports: Flexible string-based report names with optional column specification
- Date formats: ISO timestamps (2024-01-15T10:30:00Z), relative (+7d, -2w), special (today, eom), day names (monday), ordinals (15th)

## Configuration Requirements

TaskWarrior must be installed and configured before the MCP server will function. The server directly executes `task` commands and returns raw output.

## Distribution

Built as npm package with binary entry point at `dist/index.js`. Published files include only the `dist/` directory.

## Development Commands

- **Build**: `npm run build` - Compiles TypeScript to JavaScript in `dist/` and makes executables
- **Watch**: `npm run watch` - Watches TypeScript files for changes and rebuilds automatically
- **Prepare**: `npm run prepare` - Runs build (used by npm install)
- **Local Testing**: `npm link` - Creates global symlink for local development/testing with Claude Desktop

## Important Implementation Details

### Security
- **Shell Injection Prevention**: All user-provided text (descriptions, annotations, project names) must be escaped using `escapeShellArg()`
- **Safe Fields**: TaskWarrior keywords (priority, status, filter syntax) are NOT escaped - only user text content
- **Bulk Operations**: Use `yes |` piped to bash shell for confirmation bypass (index.ts:491)

### Error Handling
- `execSync` throws on non-zero exit codes - errors are caught in the main handler (index.ts:724)
- Error messages are returned as text content with `isError: true`
- Zod validation errors are formatted with detailed field paths (index.ts:468)

### Testing/Development
- No test suite currently exists
- Manual testing requires working TaskWarrior installation
- Use `npm run watch` during development for automatic rebuilds
- **Debug MCP calls**: Add logging to stderr (stdout reserved for MCP protocol)
- **Test integration**: Use Claude Desktop with locally linked package (`npm link`)

### Recent Changes
- **2025-10-23**: Added `depends` parameter to `add_task` function (commit 274b8f1)
  - Enables task dependency creation in a single step
  - Accepts array of task IDs/UUIDs
  - Example: `{"description": "Review PR", "depends": ["32", "33"]}`