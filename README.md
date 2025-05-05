[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/awwaiid-mcp-server-taskwarrior-badge.png)](https://mseep.ai/app/awwaiid-mcp-server-taskwarrior)

# TaskWarrior MCP Server

Node.js server implementing Model Context Protocol (MCP) for [TaskWarrior](https://taskwarrior.org/) operations.

<a href="https://glama.ai/mcp/servers/e8w3e1su1x">
  <img width="380" height="200" src="https://glama.ai/mcp/servers/e8w3e1su1x/badge" alt="TaskWarrior Server MCP server" />
</a>

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