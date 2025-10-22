#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ToolSchema,
} from "@modelcontextprotocol/sdk/types.js";
import fs from "fs/promises";
import path from "path";
import os from 'os';
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { diffLines, createTwoFilesPatch } from 'diff';
import { minimatch } from 'minimatch';

import { execSync } from 'child_process';

// Utility function to safely escape shell arguments - ONLY for user text
function escapeShellArg(arg: string): string {
  return `'${arg.replace(/'/g, "'\\''")}'`;
}

// Parse flexible date formats - accepts ISO timestamps or TaskWarrior shorthands
// TaskWarrior natively supports: +7d, -2w, eom, eoy, monday, tuesday, etc.
function parseFlexibleDate(dateStr: string): string {
  // ISO 8601 timestamp regex
  const isoRegex = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})?)?$/;

  // TaskWarrior relative date patterns: +3d, -2w, +1m, -1y, etc.
  const relativeRegex = /^[+-]\d+[dwmqy]$/;

  // TaskWarrior special dates: eom, eoq, eoy, som, soq, soy, today, tomorrow, yesterday
  const specialDates = /^(eom|eoq|eoy|som|soq|soy|today|tomorrow|yesterday|now)$/i;

  // Day names: monday, tuesday, etc.
  const dayNames = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/i;

  // Month names: january, february, etc.
  const monthNames = /^(january|february|march|april|may|june|july|august|september|october|november|december)$/i;

  // Ordinal dates: 1st, 2nd, 23rd, etc.
  const ordinalRegex = /^\d{1,2}(st|nd|rd|th)$/i;

  if (isoRegex.test(dateStr) ||
      relativeRegex.test(dateStr) ||
      specialDates.test(dateStr) ||
      dayNames.test(dateStr) ||
      monthNames.test(dateStr) ||
      ordinalRegex.test(dateStr)) {
    return dateStr;
  }

  throw new Error(`Invalid date format: "${dateStr}". Supported formats: ISO timestamps (2024-01-15T10:30:00Z), relative dates (+7d, -2w), special dates (today, tomorrow, eom), day names (monday), or ordinal dates (15th)`);
}

// Build TaskWarrior modify arguments from parsed data
function buildTaskModifyArgs(data: any): string[] {
  let task_args: string[] = [];

  if (data.description) {
    task_args.push(`description:${escapeShellArg(data.description)}`);
  }
  if (data.due) {
    parseFlexibleDate(data.due); // Validate format
    task_args.push(`due:${data.due}`);
  }
  if (data.priority) {
    task_args.push(`priority:${data.priority}`);
  }
  if (data.start) {
    parseFlexibleDate(data.start); // Validate format
    task_args.push(`start:${data.start}`);
  }
  if (data.stop_task) {
    task_args.push(`start:`);
  }
  if (data.wait) {
    parseFlexibleDate(data.wait); // Validate format
    task_args.push(`wait:${data.wait}`);
  }
  if (data.until) {
    parseFlexibleDate(data.until); // Validate format
    task_args.push(`until:${data.until}`);
  }
  if (data.scheduled) {
    parseFlexibleDate(data.scheduled); // Validate format
    task_args.push(`scheduled:${data.scheduled}`);
  }
  if (data.project) {
    task_args.push(`project:${data.project}`);
  }
  if (data.depends) {
    task_args.push(`depends:${data.depends.join(',')}`);
  }
  if (data.tags) {
    for (let tag of data.tags) {
      task_args.push(`+${tag}`);
    }
  }
  if (data.tags_remove) {
    for (let tag of data.tags_remove) {
      task_args.push(`-${tag}`);
    }
  }
  if (data.clear_fields) {
    for (let field of data.clear_fields) {
      task_args.push(`${field}:`);
    }
  }

  return task_args;
}

// Schema definitions

// Base task schema that covers common TaskWarrior fields
const taskSchema = z.object({
  uuid: z.string().uuid(),
  description: z.string(),
  status: z.enum(["pending", "completed", "deleted", "waiting", "recurring"]),
  entry: z.string().datetime(), // ISO timestamp
  modified: z.string().datetime().optional(), // ISO timestamp
  due: z.string().optional(), // ISO timestamp
  priority: z.enum(["H", "M", "L"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
});

// Request schemas for different operations
const listPendingTasksRequest = z.object({
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
});

const listTasksRequest = z.object({
  status: z.enum(["pending", "completed", "deleted", "waiting", "recurring"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
});

const getTaskRequest = z.object({
  identifier: z.string(),
});

const markTaskDoneRequest = z.object({
  identifier: z.string(),
});

const addTaskRequest = z.object({
  description: z.string(),
  // Optional fields that can be set when adding
  due: z.string().optional(), // ISO timestamp
  priority: z.enum(["H", "M", "L"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
  depends: z.array(z.string().min(1, "Dependency must be a valid task ID or UUID")).optional(),
});

const modifyTaskRequest = z.object({
  identifier: z.string().min(1, "Task identifier cannot be empty"),
  // Optional fields that can be modified
  description: z.string().min(1, "Description cannot be empty").optional(),
  due: z.string().min(1, "Due date cannot be empty").optional(),
  start: z.string().min(1, "Start date cannot be empty").optional(),
  stop_task: z.boolean().optional(),
  wait: z.string().min(1, "Wait date cannot be empty").optional(),
  until: z.string().min(1, "Until date cannot be empty").optional(),
  scheduled: z.string().min(1, "Scheduled date cannot be empty").optional(),
  priority: z.enum(["H", "M", "L"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/, "Project name can only contain letters, numbers, dots, hyphens, and underscores").optional(),
  depends: z.array(z.string().min(1, "Dependency must be a valid task ID or UUID")).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/, "Tags can only contain lowercase letters, numbers, hyphens, underscores, and @ symbols")).optional(),
  tags_remove: z.array(z.string().regex(/^[@a-z0-9_-]+$/, "Tags can only contain lowercase letters, numbers, hyphens, underscores, and @ symbols")).optional(),
  clear_fields: z.array(z.enum(["due", "start", "wait", "until", "scheduled", "priority", "project", "depends"])).optional(),
});

const modifyTasksBulkRequest = z.object({
  filter: z.string().min(1, "Filter cannot be empty"),
  // Same modification fields as modify_task
  description: z.string().min(1, "Description cannot be empty").optional(),
  due: z.string().min(1, "Due date cannot be empty").optional(),
  start: z.string().min(1, "Start date cannot be empty").optional(),
  stop_task: z.boolean().optional(),
  wait: z.string().min(1, "Wait date cannot be empty").optional(),
  until: z.string().min(1, "Until date cannot be empty").optional(),
  scheduled: z.string().min(1, "Scheduled date cannot be empty").optional(),
  priority: z.enum(["H", "M", "L"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/, "Project name can only contain letters, numbers, dots, hyphens, and underscores").optional(),
  depends: z.array(z.string().min(1, "Dependency must be a valid task ID or UUID")).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/, "Tags can only contain lowercase letters, numbers, hyphens, underscores, and @ symbols")).optional(),
  tags_remove: z.array(z.string().regex(/^[@a-z0-9_-]+$/, "Tags can only contain lowercase letters, numbers, hyphens, underscores, and @ symbols")).optional(),
  clear_fields: z.array(z.enum(["due", "start", "wait", "until", "scheduled", "priority", "project", "depends"])).optional(),
});

const getTaskInfoRequest = z.object({
  identifier: z.string(),
});

const countTasksRequest = z.object({
  status: z.enum(["pending", "completed", "deleted", "waiting", "recurring"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
  priority: z.enum(["H", "M", "L"]).optional(),
});

const listTasksFilteredRequest = z.object({
  status: z.enum(["pending", "completed", "deleted", "waiting", "recurring"]).optional(),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
  priority: z.enum(["H", "M", "L"]).optional(),
  report: z.string().optional(), // Report type: list, next, all, etc.
});

const deleteTaskRequest = z.object({
  identifier: z.string(),
});

const annotateTaskRequest = z.object({
  identifier: z.string(),
  annotation: z.string(),
});

const appendTaskRequest = z.object({
  identifier: z.string(),
  text: z.string(),
});

const prependTaskRequest = z.object({
  identifier: z.string(),
  text: z.string(),
});

const duplicateTaskRequest = z.object({
  identifier: z.string(),
});

const undoLastRequest = z.object({
  // No parameters needed for undo
});

const builtinReportRequest = z.object({
  report: z.enum(["list", "all", "active", "completed", "blocked", "overdue", "ready", "recurring"]),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
  priority: z.enum(["H", "M", "L"]).optional(),
});

const visualizationReportRequest = z.object({
  report: z.enum(["burndown", "calendar", "history", "summary", "timesheet"]),
  project: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional(),
  tags: z.array(z.string().regex(/^[@a-z0-9_-]+$/)).optional(),
});

const customReportRequest = z.object({
  report: z.string(),
  columns: z.array(z.string()).optional(),
  filter: z.string().optional(),
});

// Response schemas
const listTasksResponse = z.array(taskSchema);
const getTaskResponse = taskSchema;
const markTaskDoneResponse = taskSchema;
const addTaskResponse = taskSchema;
const modifyTaskResponse = taskSchema;
const getTaskInfoResponse = z.string();
const countTasksResponse = z.string();
const listTasksFilteredResponse = z.string();
const deleteTaskResponse = z.string();
const annotateTaskResponse = z.string();
const appendTaskResponse = z.string();
const prependTaskResponse = z.string();
const duplicateTaskResponse = z.string();
const undoLastResponse = z.string();
const builtinReportResponse = z.string();
const visualizationReportResponse = z.string();
const customReportResponse = z.string();

// Error schema
const errorResponse = z.object({
  error: z.string(),
  code: z.number(),
});

// Server setup
const server = new Server(
  {
    name: "taskwarrior-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Tool handlers
const ToolInputSchema = ToolSchema.shape.inputSchema;
type ToolInput = z.infer<typeof ToolInputSchema>;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "get_next_tasks",
        description: "Get a list of all pending tasks",
        inputSchema: zodToJsonSchema(listPendingTasksRequest) as ToolInput,
      },
      {
        name: "mark_task_done", 
        description: "Mark a task as done (completed)",
        inputSchema: zodToJsonSchema(markTaskDoneRequest) as ToolInput,
      },
      {
        name: "add_task",
        description: "Add a new task",
        inputSchema: zodToJsonSchema(addTaskRequest) as ToolInput,
      },
      {
        name: "modify_task",
        description: "Modify an existing task",
        inputSchema: zodToJsonSchema(modifyTaskRequest) as ToolInput,
      },
      {
        name: "modify_tasks_bulk",
        description: "Modify multiple tasks using TaskWarrior filter syntax",
        inputSchema: zodToJsonSchema(modifyTasksBulkRequest) as ToolInput,
      },
      {
        name: "get_task_info",
        description: "Get detailed information about a specific task",
        inputSchema: zodToJsonSchema(getTaskInfoRequest) as ToolInput,
      },
      {
        name: "count_tasks",
        description: "Count tasks matching specified filters",
        inputSchema: zodToJsonSchema(countTasksRequest) as ToolInput,
      },
      {
        name: "list_tasks_filtered",
        description: "List tasks with comprehensive filtering options",
        inputSchema: zodToJsonSchema(listTasksFilteredRequest) as ToolInput,
      },
      {
        name: "delete_task",
        description: "Delete a task from TaskWarrior",
        inputSchema: zodToJsonSchema(deleteTaskRequest) as ToolInput,
      },
      {
        name: "annotate_task",
        description: "Add an annotation to a task",
        inputSchema: zodToJsonSchema(annotateTaskRequest) as ToolInput,
      },
      {
        name: "append_task",
        description: "Append text to a task description",
        inputSchema: zodToJsonSchema(appendTaskRequest) as ToolInput,
      },
      {
        name: "prepend_task",
        description: "Prepend text to a task description",
        inputSchema: zodToJsonSchema(prependTaskRequest) as ToolInput,
      },
      {
        name: "duplicate_task",
        description: "Duplicate an existing task",
        inputSchema: zodToJsonSchema(duplicateTaskRequest) as ToolInput,
      },
      {
        name: "undo_last",
        description: "Undo the last TaskWarrior operation",
        inputSchema: zodToJsonSchema(undoLastRequest) as ToolInput,
      },
      {
        name: "builtin_report",
        description: "Generate built-in TaskWarrior reports (list, all, active, completed, blocked, overdue, ready, recurring)",
        inputSchema: zodToJsonSchema(builtinReportRequest) as ToolInput,
      },
      {
        name: "visualization_report",
        description: "Generate TaskWarrior visualization reports (burndown, calendar, history, summary, timesheet)",
        inputSchema: zodToJsonSchema(visualizationReportRequest) as ToolInput,
      },
      {
        name: "custom_report",
        description: "Execute custom TaskWarrior reports with user-defined columns and filters",
        inputSchema: zodToJsonSchema(customReportRequest) as ToolInput,
      },
    ],
  };
});


server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args } = request.params;

    switch (name) {
      case "get_next_tasks": {
        const parsed = listPendingTasksRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_next_tasks: ${parsed.error}`);
        }
        let task_args = [];
        if (parsed.data.tags) {
          for(let tag of parsed.data.tags) {
            task_args.push(`+${tag}`);
          }
        }
        if (parsed.data.project) {
            task_args.push(`project:${parsed.data.project}`);
        }
        const content = execSync(`task limit: ${task_args.join(" ")} next`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "mark_task_done": {
        const parsed = markTaskDoneRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for mark_task_done: ${parsed.error}`);
        }
        const content = execSync(`task ${parsed.data.identifier} done`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "add_task": {
        const parsed = addTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for add_task: ${parsed.error}`);
        }

        let task_args = [`add`];

        // Add description with proper escaping
        task_args.push(escapeShellArg(parsed.data.description));

        if (parsed.data.due) {
          parseFlexibleDate(parsed.data.due); // Validate format
          task_args.push(`due:${parsed.data.due}`);
        }
        if (parsed.data.priority) {
          task_args.push(`priority:${parsed.data.priority}`);
        }
        if (parsed.data.project) {
          task_args.push(`project:${escapeShellArg(parsed.data.project)}`);
        }
        if (parsed.data.tags) {
          for (let tag of parsed.data.tags) {
            task_args.push(`+${escapeShellArg(tag)}`);
          }
        }
        if (parsed.data.depends) {
          task_args.push(`depends:${parsed.data.depends.join(',')}`);
        }

        const content = execSync(`task ${task_args.join(" ")}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "modify_task": {
        const parsed = modifyTaskRequest.safeParse(args);
        if (!parsed.success) {
          const errorDetails = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
          throw new Error(`Invalid arguments for modify_task: ${errorDetails}`);
        }

        const task_args = buildTaskModifyArgs(parsed.data);

        const identifier = escapeShellArg(parsed.data.identifier);
        const content = execSync(`task ${identifier} modify ${task_args.join(" ")}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "modify_tasks_bulk": {
        const parsed = modifyTasksBulkRequest.safeParse(args);
        if (!parsed.success) {
          const errorDetails = parsed.error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
          throw new Error(`Invalid arguments for modify_tasks_bulk: ${errorDetails}`);
        }

        const task_args = buildTaskModifyArgs(parsed.data);

        const filter = parsed.data.filter;
        const content = execSync(`yes | task ${filter} modify ${task_args.join(" ")}`, { maxBuffer: 1024 * 1024 * 10, shell: '/bin/bash' }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "get_task_info": {
        const parsed = getTaskInfoRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for get_task_info: ${parsed.error}`);
        }

        const content = execSync(`task ${parsed.data.identifier} info`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "count_tasks": {
        const parsed = countTasksRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for count_tasks: ${parsed.error}`);
        }

        let task_args = [];

        if (parsed.data.status) {
          task_args.push(`status:${parsed.data.status}`);
        }
        if (parsed.data.project) {
          task_args.push(`project:${parsed.data.project}`);
        }
        if (parsed.data.priority) {
          task_args.push(`priority:${parsed.data.priority}`);
        }
        if (parsed.data.tags) {
          for (let tag of parsed.data.tags) {
            task_args.push(`+${tag}`);
          }
        }

        const content = execSync(`task ${task_args.join(" ")} count`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "list_tasks_filtered": {
        const parsed = listTasksFilteredRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for list_tasks_filtered: ${parsed.error}`);
        }

        let task_args = [];

        if (parsed.data.status) {
          task_args.push(`status:${parsed.data.status}`);
        }
        if (parsed.data.project) {
          task_args.push(`project:${parsed.data.project}`);
        }
        if (parsed.data.priority) {
          task_args.push(`priority:${parsed.data.priority}`);
        }
        if (parsed.data.tags) {
          for (let tag of parsed.data.tags) {
            task_args.push(`+${tag}`);
          }
        }

        // Use specified report or default to 'list'
        const report = parsed.data.report || 'list';
        const content = execSync(`task ${task_args.join(" ")} ${report}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "delete_task": {
        const parsed = deleteTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for delete_task: ${parsed.error}`);
        }

        const content = execSync(`task rc.confirmation=no ${parsed.data.identifier} delete`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "annotate_task": {
        const parsed = annotateTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for annotate_task: ${parsed.error}`);
        }

        const content = execSync(`task ${parsed.data.identifier} annotate ${escapeShellArg(parsed.data.annotation)}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "append_task": {
        const parsed = appendTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for append_task: ${parsed.error}`);
        }

        const content = execSync(`task ${parsed.data.identifier} append ${escapeShellArg(parsed.data.text)}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "prepend_task": {
        const parsed = prependTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for prepend_task: ${parsed.error}`);
        }

        const content = execSync(`task ${parsed.data.identifier} prepend ${escapeShellArg(parsed.data.text)}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "duplicate_task": {
        const parsed = duplicateTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for duplicate_task: ${parsed.error}`);
        }

        const content = execSync(`task ${parsed.data.identifier} duplicate`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "undo_last": {
        const parsed = undoLastRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for undo_last: ${parsed.error}`);
        }

        const content = execSync(`task rc.confirmation=no undo`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "builtin_report": {
        const parsed = builtinReportRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for builtin_report: ${parsed.error}`);
        }

        let task_args = [];

        if (parsed.data.project) {
          task_args.push(`project:${parsed.data.project}`);
        }
        if (parsed.data.priority) {
          task_args.push(`priority:${parsed.data.priority}`);
        }
        if (parsed.data.tags) {
          for (let tag of parsed.data.tags) {
            task_args.push(`+${tag}`);
          }
        }

        const content = execSync(`task ${task_args.join(" ")} ${parsed.data.report}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "visualization_report": {
        const parsed = visualizationReportRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for visualization_report: ${parsed.error}`);
        }

        let task_args = [];

        if (parsed.data.project) {
          task_args.push(`project:${parsed.data.project}`);
        }
        if (parsed.data.tags) {
          for (let tag of parsed.data.tags) {
            task_args.push(`+${tag}`);
          }
        }

        const content = execSync(`task ${task_args.join(" ")} ${parsed.data.report}`, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "custom_report": {
        const parsed = customReportRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for custom_report: ${parsed.error}`);
        }

        let cmd_parts = ["task"];

        // Add filter before the report name
        if (parsed.data.filter) {
          cmd_parts.push(parsed.data.filter);
        }

        // Add report name
        cmd_parts.push(parsed.data.report);

        // Add column configuration if specified
        if (parsed.data.columns && parsed.data.columns.length > 0) {
          const columns = parsed.data.columns.join(",");
          const labels = parsed.data.columns.map(col => col.charAt(0).toUpperCase() + col.slice(1)).join(",");
          cmd_parts.push(`rc.report.${parsed.data.report}.columns=${columns}`);
          cmd_parts.push(`rc.report.${parsed.data.report}.labels=${labels}`);
        }

        const command = cmd_parts.join(" ");
        const content = execSync(command, { maxBuffer: 1024 * 1024 * 10 }).toString().trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${errorMessage}` }],
      isError: true,
    };
  }
});

// Start server
async function runServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("MCP TaskWarrior Server running on stdio");
}

runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});
