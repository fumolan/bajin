import { z } from 'zod';
import type { ToolDefinition } from '@bajin/shared';
import { promises as fs } from 'node:fs';

/** Skill 工具：按名加载已发现的 SKILL.md 正文到上下文 */
export interface SkillHost {
  getSkill(name: string): { file: string } | undefined;
  /** 禁用清单（config.json skillsDisabled）：命中的技能拒绝加载 */
  disabledSkills?(): string[];
}

const SkillInput = z.object({
  skill: z.string().describe('skill 名称（来自系统提示里的可用清单）'),
});

export function createSkillTool(host: () => SkillHost, clip: (body: string) => string): ToolDefinition<typeof SkillInput> {
  return {
    name: 'Skill',
    description:
      '加载一个已安装技能的 SKILL.md 操作指南。当任务与系统提示中列出的技能匹配时，先调用本工具读取操作指南再动手。',
    inputSchema: SkillInput,
    metadata: { readOnly: true, riskLevel: 'low' },
    async execute(input) {
      const found = host().getSkill(input.skill);
      if (!found) return { ok: false, output: `未安装技能: ${input.skill}` };
      if (host().disabledSkills?.().includes(input.skill)) return { ok: false, output: `技能已被禁用: ${input.skill}（设置→技能 可启用）` };
      const body = await fs.readFile(found.file, 'utf8').catch(() => null);
      if (!body) return { ok: false, output: `技能文件不可读: ${found.file}` };
      return { ok: true, output: clip(body) };
    },
  };
}
