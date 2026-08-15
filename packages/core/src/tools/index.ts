import type { ToolDefinition } from '@bajin/shared';
import { readTool, writeTool, editTool } from './fs.js';
import { bashTool } from './exec.js';
import { globTool, grepTool } from './search.js';
import { todoWriteTool, askUserQuestionTool } from './interaction.js';
import { createWebFetchTool, createWebSearchTool, htmlToText, parseDuckResults, loadWebConfig } from './web.js';

export const builtinTools: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  todoWriteTool,
  askUserQuestionTool,
  createWebFetchTool(),
  createWebSearchTool(),
];

export { readTool, writeTool, editTool, bashTool, globTool, grepTool, todoWriteTool, askUserQuestionTool };
export { createWebFetchTool, createWebSearchTool, htmlToText, parseDuckResults, loadWebConfig };
export type { FetchLike, WebConfig } from './web.js';
