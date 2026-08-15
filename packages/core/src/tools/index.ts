import type { ToolDefinition } from '@bajin/shared';
import { readTool, writeTool, editTool } from './fs.js';
import { bashTool } from './exec.js';
import { globTool, grepTool } from './search.js';
import { todoWriteTool, askUserQuestionTool } from './interaction.js';

export const builtinTools: ToolDefinition[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  globTool,
  grepTool,
  todoWriteTool,
  askUserQuestionTool,
];

export { readTool, writeTool, editTool, bashTool, globTool, grepTool, todoWriteTool, askUserQuestionTool };
