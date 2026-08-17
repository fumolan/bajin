import type { ToolDefinition } from '@bajin/shared';
import { readTool, writeTool, editTool } from './fs.js';
import { bashTool } from './exec.js';
import { globTool, grepTool } from './search.js';
import { todoWriteTool, askUserQuestionTool } from './interaction.js';
import { createWebFetchTool, createWebSearchTool, htmlToText, parseDuckResults, loadWebConfig } from './web.js';
import { createCronCreateTool, createCronUpdateTool, createCronDeleteTool, createCronListTool } from './cron.js';
import { createTaskOutputTool, createTaskStopTool } from './tasks.js';
import { createDiagnosticsTool, parseTscOutput } from './diagnostics.js';
import { createBrowserNavigateTool, createBrowserContentTool, setBrowserBridge, getBrowserBridge, type BrowserBridge } from './browser.js';

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
  createCronCreateTool(),
  createCronUpdateTool(),
  createCronDeleteTool(),
  createCronListTool(),
  createTaskOutputTool(),
  createTaskStopTool(),
  createBrowserNavigateTool(),
  createBrowserContentTool(),
  createDiagnosticsTool(),
];

export { readTool, writeTool, editTool, bashTool, globTool, grepTool, todoWriteTool, askUserQuestionTool };
export { createWebFetchTool, createWebSearchTool, htmlToText, parseDuckResults, loadWebConfig };
export type { FetchLike, WebConfig } from './web.js';
