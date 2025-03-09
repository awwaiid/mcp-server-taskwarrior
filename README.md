# TaskWarrior MCP Server

[![smithery badge](https://smithery.ai/badge/mcp-server-taskwarrior)](https://smithery.ai/server/mcp-server-taskwarrior)

Node.js server implementing Model Context Protocol (MCP) for [TaskWarrior](https://taskwarrior.org/) operations.

## Features

- View pending tasks
- Filter tasks by project and tags
- Add new tasks with descriptions, due dates, priorities, projects and tags
- Mark tasks as complete

**Note**: This runs your local `task` binary, so TaskWarrior needs to be installed and configured!

> [!WARNING]
> This currently uses task `id` which is an unstable identifier; taskwarrior
> sometimes renumbers tasks when new ones are added or removed. In the future
> this should be more careful, using task UUID instead.

## API

### Tools

- **get_next_tasks**
  - Get a list of all pending tasks
  - Optional filters:
    - `project`: Filter by project name
    - `tags`: Filter by one or more tags

- **add_task**
  - Add a new task to TaskWarrior
  - Required:
    - `description`: Task description text
  - Optional:
    - `due`: Due date (ISO timestamp)
    - `priority`: Priority level ("H", "M", or "L")
    - `project`: Project name (lowercase with dots)
    - `tags`: Array of tags (lowercase)

- **mark_task_done**
  - Mark a task as completed
  - Required:
    - `identifier`: Task ID or UUID

## Usage with Claude Desktop

Add this to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "taskwarrior": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-server-taskwarrior"
      ]
    }
  }
}
```

## Installation

### Installing via Smithery

To install TaskWarrior Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/mcp-server-taskwarrior):

```bash
npx -y @smithery/cli install mcp-server-taskwarrior --client claude
```

### Manual Installation
```bash
npm install -g mcp-server-taskwarrior
```

Make sure you have TaskWarrior (`task`) installed and configured on your system.

## Example usage ideas:

* What are my current work tasks?
  * Executes: `task project:work next`
* TODO: Call my sister (high priority)
  * Executes: `task add priority:H Call my sister`
* OK, I've called my sister
  * Executes: `task done 1`

## License

This MCP server is licensed under the MIT License. See the LICENSE file for details.
