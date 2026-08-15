import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { HookRunner, matcherHits, toolNameCandidates, loadHooksConfig, type HooksConfig, type HookOutcome } from '../src/hooks.js';

let home: string;
let proj: string;
const ctx = { cwd: '/tmp', sessionId: 'sess_test' };

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-hookhome-'));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), 'bajin-hookproj-'));
});
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
});

function cfg(events: HooksConfig['events'], enabled = true): HooksConfig {
  return { enabled, events };
}

describe('matcher 规则', () => {
  it('大小写敏感：bash 不命中 Bash，省略匹配一切，非法正则永不命中', () => {
    expect(matcherHits('bash', ['Bash'])).toBe(false);
    expect(matcherHits('Bash', ['Bash'])).toBe(true);
    expect(matcherHits(undefined, ['任何'])).toBe(true);
    expect(matcherHits('(', ['Bash'])).toBe(false);
    expect(matcherHits('Edit|Write', ['Write'])).toBe(true);
  });
  it('工具别名：Agent↔Task、Write/Edit←ApplyPatch 双向候选', () => {
    expect(matcherHits('Task', toolNameCandidates('Agent'))).toBe(true);
    expect(matcherHits('Agent', toolNameCandidates('Task'))).toBe(true);
    expect(matcherHits('ApplyPatch', toolNameCandidates('Write'))).toBe(true);
    expect(matcherHits('ApplyPatch', toolNameCandidates('Edit'))).toBe(true);
    expect(matcherHits('ApplyPatch', toolNameCandidates('Bash'))).toBe(false);
  });
});

describe('HookRunner 执行协议', () => {
  it('默认关闭：enabled 未设 true 时不执行任何钩子', async () => {
    const r = new HookRunner(cfg({ UserPromptSubmit: [{ hooks: [{ command: 'exit 2' }] }] }, false), ctx);
    const out = await r.fire('UserPromptSubmit', { prompt: 'hi' });
    expect(out.blocked).toBe(false);
  });

  it('退出码 0 = 通过，2 = 阻止（deny），其他非零 = 记录错误不中断', async () => {
    const r = new HookRunner(cfg({
      UserPromptSubmit: [
        { matcher: '危险', hooks: [{ command: 'exit 2' }] },
        { matcher: '坏', hooks: [{ command: 'exit 7' }] },
      ],
    }), ctx);
    const ok = await r.fire('UserPromptSubmit', { prompt: '普通提问' });
    expect(ok.blocked).toBe(false);
    const blocked = await r.fire('UserPromptSubmit', { prompt: '危险操作' });
    expect(blocked.blocked).toBe(true);
    const failed = await r.fire('UserPromptSubmit', { prompt: '坏的钩子' });
    expect(failed.blocked).toBe(false);
    expect(failed.errors).toHaveLength(1);
    expect(failed.errors[0]).toContain('退出码 7');
  });

  it('stdout 严格 JSON：additionalContext 注入；decision deny 阻止；多余键校验失败', async () => {
    const r = new HookRunner(cfg({
      UserPromptSubmit: [{ hooks: [{ command: `echo '{"additionalContext":"项目规范：禁止 any"}'` }] }],
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ command: `echo '{"decision":"deny","reason":"禁止 shell"}'` }] },
        { matcher: 'Read', hooks: [{ command: `echo '{"unknownKey":1}'` }] },
      ],
    }), ctx);
    const ctx2 = await r.fire('UserPromptSubmit', { prompt: 'x' });
    expect(ctx2.additionalContext).toBe('项目规范：禁止 any');
    const denied = await r.fire('PreToolUse', { toolName: 'Bash', toolInput: {} });
    expect(denied.blocked).toBe(true);
    expect(denied.decision).toBe('deny');
    expect(denied.reason).toBe('禁止 shell');
    const bad = await r.fire('PreToolUse', { toolName: 'Read', toolInput: {} });
    expect(bad.blocked).toBe(false);
    expect(bad.errors[0]).toContain('未识别键');
  });

  it('decision allow 放行（不 blocked）；非对象 JSON 报错', async () => {
    const r = new HookRunner(cfg({
      PreToolUse: [
        { matcher: 'Bash', hooks: [{ command: `echo '{"decision":"allow"}'` }] },
        { matcher: 'Write', hooks: [{ command: 'echo "[1,2]"' }] },
      ],
    }), ctx);
    const allow = await r.fire('PreToolUse', { toolName: 'Bash', toolInput: {} });
    expect(allow.blocked).toBe(false);
    expect(allow.decision).toBe('allow');
    const notObj = await r.fire('PreToolUse', { toolName: 'Write', toolInput: {} });
    expect(notObj.errors[0]).toContain('对象');
  });

  it('continue 只在 Stop 事件有效；Stop 可请求续跑', async () => {
    const r = new HookRunner(cfg({
      Stop: [{ hooks: [{ command: `echo '{"continue":true,"stopReason":"还有工作没做完"}'` }] }],
      UserPromptSubmit: [{ hooks: [{ command: `echo '{"continue":true}'` }] }],
    }), ctx);
    const stop = await r.fire('Stop', { response: 'done' });
    expect(stop.continueRun).toBe(true);
    expect(stop.reason).toBe('还有工作没做完');
    const prompt = await r.fire('UserPromptSubmit', { prompt: 'x' });
    expect(prompt.errors[0]).toContain('continue');
  });

  it('超时（timeout 秒 / timeoutMs 毫秒，后者优先）记为错误', async () => {
    const r = new HookRunner(cfg({
      UserPromptSubmit: [
        { matcher: 'a', hooks: [{ command: 'sleep 5', timeoutMs: 200 }] },
        { matcher: 'b', hooks: [{ command: 'sleep 5', timeout: 0 }] },
      ],
    }), ctx);
    const out1 = await r.fire('UserPromptSubmit', { prompt: 'a' });
    expect(out1.errors[0]).toContain('超时');
    const out2 = await r.fire('UserPromptSubmit', { prompt: 'b' });
    expect(out2.errors[0]).toContain('超时');
  }, 10_000);

  it('stdin 收到事件载荷 JSON；模板变量与环境变量注入', async () => {
    const r = new HookRunner(cfg({
      UserPromptSubmit: [{
        hooks: [{
          command: `node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(d.event+'|'+d.prompt+'|'+process.env.BAJIN_SESSION_ID+'|'+process.env.BAJIN_PROJECT_DIR)"`,
        }],
      }],
    }), ctx);
    const out = await r.fire('UserPromptSubmit', { prompt: '载荷测试' });
    // additionalContext 为空但命令成功；用 stderr 侧证不可行，改用 echo 回传验证 stdin
    expect(out.blocked).toBe(false);
    const r2 = new HookRunner(cfg({
      UserPromptSubmit: [{
        hooks: [{
          command: `node -e "const d=JSON.parse(require('fs').readFileSync(0,'utf8'));process.stdout.write(JSON.stringify({additionalContext:d.event+'/'+d.prompt+'/'+process.env.BAJIN_SESSION_ID}))"`,
        }],
      }],
    }), ctx);
    const out2 = await r2.fire('UserPromptSubmit', { prompt: 'hi' });
    expect(out2.additionalContext).toBe('UserPromptSubmit/hi/sess_test');
  });

  it('process 型：argv 免 shell 执行 + ${} 模板展开', async () => {
    const r = new HookRunner(cfg({
      UserPromptSubmit: [{
        hooks: [{
          type: 'process',
          command: process.execPath,
          args: ['-e', 'process.stdout.write(JSON.stringify({additionalContext:process.env.BAJIN_PROJECT_DIR}))'],
        }],
      }],
    }), ctx);
    const out = await r.fire('UserPromptSubmit', { prompt: 'x' });
    expect(out.additionalContext).toBe(ctx.cwd);
  });

  it('多个命中钩子的 additionalContext 拼接', async () => {
    const r = new HookRunner(cfg({
      UserPromptSubmit: [
        { hooks: [{ command: `echo '{"additionalContext":"第一段"}'` }] },
        { hooks: [{ command: `echo '{"additionalContext":"第二段"}'` }] },
      ],
    }), ctx);
    const out = await r.fire('UserPromptSubmit', { prompt: 'x' });
    expect(out.additionalContext).toBe('第一段\n第二段');
  });
});

describe('配置发现与合并', () => {
  function writeCfg(dir: string, rel: string, hooks: unknown): void {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ hooks }), 'utf8');
  }

  it('默认关闭；enabled:true 才启用；用户级+工作区事件组按序合并', async () => {
    writeCfg(home, '.bajin/config.json', { enabled: true, events: { UserPromptSubmit: [{ matcher: '用户', hooks: [{ command: 'true' }] }] } });
    writeCfg(proj, '.bajin/config.json', { events: { UserPromptSubmit: [{ matcher: '项目', hooks: [{ command: 'true' }] }] } });
    const merged = await loadHooksConfig(proj, home);
    expect(merged.enabled).toBe(true); // 用户级开启即启用
    const groups = merged.events?.['UserPromptSubmit'] ?? [];
    expect(groups).toHaveLength(2);
    expect(groups[0]!.matcher).toBe('用户'); // 用户级在前
    expect(groups[1]!.matcher).toBe('项目');
  });

  it('两边都没 enabled → 合并后仍关闭', async () => {
    writeCfg(home, '.bajin/config.json', { events: { Stop: [{ hooks: [{ command: 'true' }] }] } });
    const merged = await loadHooksConfig(proj, home);
    expect(merged.enabled).toBe(false);
  });

  it('工作区向上扫描到 .git 根，近目录事件组排在远目录之后', async () => {
    fs.mkdirSync(path.join(proj, '.git'), { recursive: true });
    writeCfg(proj, '.bajin/config.json', { enabled: true, events: { Stop: [{ matcher: '根', hooks: [{ command: 'true' }] }] } });
    writeCfg(proj, 'sub/.bajin/config.json', { events: { Stop: [{ matcher: '子', hooks: [{ command: 'true' }] }] } });
    const merged = await loadHooksConfig(path.join(proj, 'sub'), home);
    const matchers = (merged.events?.['Stop'] ?? []).map((g) => g.matcher);
    expect(matchers).toEqual(['根', '子']); // 远 → 近追加
    // .git 之上不扫描
    writeCfg(path.dirname(proj), '.bajin/config.json', { events: { Stop: [{ matcher: '外部', hooks: [{ command: 'true' }] }] } });
    const merged2 = await loadHooksConfig(path.join(proj, 'sub'), home);
    expect((merged2.events?.['Stop'] ?? []).some((g) => g.matcher === '外部')).toBe(false);
    fs.rmSync(path.join(path.dirname(proj), '.bajin'), { recursive: true, force: true });
  });

  it('合并后经 HookRunner 实跑：工作区钩子生效', async () => {
    writeCfg(proj, '.bajin/config.json', {
      enabled: true,
      events: { UserPromptSubmit: [{ matcher: '关键词', hooks: [{ command: `echo '{"additionalContext":"命中"}'` }] }] },
    });
    const merged = await loadHooksConfig(proj, home);
    const runner = new HookRunner(merged, { cwd: proj, sessionId: 's1' });
    const out: HookOutcome = await runner.fire('UserPromptSubmit', { prompt: '带 关键词 的提问' });
    expect(out.additionalContext).toBe('命中');
  });
});
