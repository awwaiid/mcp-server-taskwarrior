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

import { execFileSync } from 'child_process';

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
  project: z.string().regex(/^[a-z.]+$/).optional(),
  tags: z.array(z.string().regex(/^a-z$/)).optional(),
});

// Request schemas for different operations
const listPendingTasksRequest = z.object({
  project: z.string().regex(/^[a-z.]+$/).optional(),
  tags: z.array(z.string().regex(/^a-z$/)).optional(),
});

const listTasksRequest = z.object({
  status: z.enum(["pending", "completed", "deleted", "waiting", "recurring"]).optional(),
  project: z.string().regex(/^[a-z.]+$/).optional(),
  tags: z.array(z.string().regex(/^a-z$/)).optional(),
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
  project: z.string().regex(/^[a-z.]+$/).optional(),
  tags: z.array(z.string().regex(/^a-z$/)).optional(),
});

// Response schemas
const listTasksResponse = z.array(taskSchema);
const getTaskResponse = taskSchema;
const markTaskDoneResponse = taskSchema;
const addTaskResponse = taskSchema;

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
        let task_args = ['limit:'];  
        if (parsed.data.tags) {  
          for(let tag of parsed.data.tags) {  
            task_args.push(`+${tag}`);  
          }  
        }  
        if (parsed.data.project) {  
            task_args.push(`project:${parsed.data.project}`);  
        }  
        task_args.push('next');  
          
        const content = execFileSync('task', task_args, {   
          encoding: 'utf8',  
          maxBuffer: 1024 * 1024 * 10   
        }).trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "mark_task_done": {
        const parsed = markTaskDoneRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for mark_task_done: ${parsed.error}`);
        }
        const content = execFileSync('task', [parsed.data.identifier, 'done'], {   
          encoding: 'utf8',  
          maxBuffer: 1024 * 1024 * 10   
        }).trim();
        return {
          content: [{ type: "text", text: content }],
        };
      }

      case "add_task": {
        const parsed = addTaskRequest.safeParse(args);
        if (!parsed.success) {
          throw new Error(`Invalid arguments for add_task: ${parsed.error}`);
        }

        let task_args = [parsed.data.description];
        
        if (parsed.data.due) {
          task_args.push(`due:${parsed.data.due}`);
        }
        if (parsed.data.priority) {
          task_args.push(`priority:${parsed.data.priority}`);
        }
        if (parsed.data.project) {
          task_args.push(`project:${parsed.data.project}`);
        }
        if (parsed.data.tags) {
          for (let tag of parsed.data.tags) {
            task_args.push(`+${tag}`);
          }
        }

        const content = execFileSync('task', ['add', ...task_args], {   
          encoding: 'utf8',  
          maxBuffer: 1024 * 1024 * 10   
        }).trim();
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
