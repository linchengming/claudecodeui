import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { queryClaudeSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';
import { ClaudeSessionsProvider } from '@/modules/providers/list/claude/claude-sessions.provider.js';
import { createClaudeQuotaRetryService } from '@/modules/providers/services/claude-quota-retry.service.js';
import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';

function harness(waitOverride?: (milliseconds: number, signal: AbortSignal) => Promise<void>) {
  let now = Date.parse('2026-09-23T12:00:00Z');
  const waits: number[] = [];
  const events: AnyRecord[] = [];
  const service = createClaudeQuotaRetryService({
    enabled: () => true,
    intervalMs: () => 300_000,
    now: () => now,
    wait: async (milliseconds, signal) => {
      waits.push(milliseconds);
      if (waitOverride) await waitOverride(milliseconds, signal);
      now += milliseconds;
    },
  });
  const writer: ProviderRuntimeWriter = {
    isWebSocketWriter: true,
    userId: 1,
    send: (event) => events.push(event as AnyRecord),
    setSessionId() {},
  };
  const context: ProviderRuntimeContext = {
    resolveProviderSessionId: () => null,
    resolveResumeModel: async (_id, model) => model ?? undefined,
    getProviderModels: async () => ({ OPTIONS: [], DEFAULT: 'best' }),
    normalizeMessage: () => [],
    isProviderInstalled: async () => true,
  };
  const options = { sessionId: 'session-1', cwd: 'project', model: 'best', effort: 'xhigh' };
  return { service, waits, events, writer, context, options, now: () => now };
}

function runtime(run: IProviderRuntime['run']): IProviderRuntime {
  return { run, abort: () => false };
}

function quotaFailure(context: ProviderRuntimeContext, writer: ProviderRuntimeWriter) {
  writer.setSessionId?.('native-1');
  context.normalizeMessage({
    type: 'assistant', error: 'rate_limit',
    message: { content: [{ type: 'text', text: "You've hit your limit" }] },
  }, 'native-1');
  context.normalizeMessage({ type: 'result', is_error: true, errors: ["You've hit your limit"] }, 'native-1');
  // Claude's adapter currently reports exitCode 0 even for is_error results;
  // structured quota detection must take precedence over that terminal code.
  writer.send({ kind: 'complete', exitCode: 0 });
}

test('waits past a five-hour reset without an attempt cap, then resumes the same session', async () => {
  const h = harness();
  const start = h.now();
  const attempts: Array<{ command: string; options: AnyRecord; nativeId: string | null }> = [];
  const result = await h.service.run(runtime(async (command, options, writer, context) => {
    attempts.push({ command, options, nativeId: context.resolveProviderSessionId('session-1') });
    if (attempts.length <= 61) {
      quotaFailure(context, writer);
      return;
    }
    context.normalizeMessage({ type: 'result', is_error: false, result: 'done' }, 'native-1');
    writer.send({ kind: 'text', content: 'done' });
    writer.send({ kind: 'complete', exitCode: 0 });
    return 'success';
  }), 'finish the requested task', { ...h.options, images: ['original-image'] }, h.writer, h.context);

  assert.equal(result, 'success');
  assert.equal(attempts.length, 62);
  assert.equal(h.now() - start, 61 * 300_000);
  assert.equal(attempts[0].command, 'finish the requested task');
  for (const attempt of attempts.slice(1)) {
    assert.equal(attempt.nativeId, 'native-1');
    assert.match(attempt.command, /do not repeat completed actions/);
    assert.equal(attempt.options.cwd, 'project');
    assert.equal(attempt.options.model, 'best');
    assert.equal(attempt.options.effort, 'xhigh');
    assert.deepEqual(attempt.options.images, []);
    assert.equal(attempt.options.resumeFromScratch, false);
  }
  assert.equal(h.events.filter((event) => event.kind === 'complete').length, 1);
  assert.equal(h.events.filter((event) => event.quotaRetry?.retryAt).length, 61);
});

test('honors a structured five-hour reset time with a grace period', async () => {
  const h = harness();
  const start = h.now();
  let attempts = 0;
  await h.service.run(runtime(async (_command, _options, writer, context) => {
    if (++attempts === 1) {
      context.normalizeMessage({
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', resetsAt: (start + 5 * 3600_000) / 1000, rateLimitType: 'five_hour' },
      }, 'native-1');
      quotaFailure(context, writer);
    } else writer.send({ kind: 'complete', exitCode: 0 });
  }), 'task', h.options, h.writer, h.context);
  assert.equal(attempts, 2);
  assert.equal(h.now() - start, 5 * 3600_000 + 5000);
  assert.equal(h.events.find((event) => event.quotaRetry?.retryAt)?.quotaRetry.retryAt,
    new Date(start + 5 * 3600_000 + 5000).toISOString());
});

test('Stop cancels waiting immediately without launching another CLI', async () => {
  let waiting!: () => void;
  const startedWaiting = new Promise<void>((resolve) => { waiting = resolve; });
  const h = harness(async (_ms, signal) => {
    waiting();
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  });
  let attempts = 0;
  const running = h.service.run(runtime(async (_command, _options, writer, context) => {
    attempts++;
    quotaFailure(context, writer);
  }), 'task', h.options, h.writer, h.context);
  await startedWaiting;
  assert.equal(h.service.cancel('session-1'), true);
  await running;
  assert.equal(attempts, 1);
  assert.equal(h.events.at(-1)?.aborted, true);
  assert.equal(h.service.cancel('session-1'), false);
});

test('first assistant reply after a retry reports recovery once, without a quotaRetry marker', async () => {
  const h = harness();
  let attempts = 0;
  await h.service.run(runtime(async (_command, _options, writer, context) => {
    if (++attempts === 1) {
      quotaFailure(context, writer);
      return;
    }
    context.normalizeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'resuming' }] } }, 'native-1');
    context.normalizeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'still going' }] } }, 'native-1');
    context.normalizeMessage({ type: 'result', is_error: false, result: 'done' }, 'native-1');
    writer.send({ kind: 'complete', exitCode: 0 });
  }), 'task', h.options, h.writer, h.context);
  const statuses = h.events.filter((event) => event.kind === 'status');
  const recovered = statuses.filter((event) => /额度已恢复/.test(event.text));
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].quotaRetry, undefined);
  assert.match(recovered[0].text, /第 1 次重试成功/);
  assert.ok(statuses.indexOf(recovered[0]) > statuses.findIndex((event) => /正在重试额度/.test(event.text)));
  // Runs that never hit the quota must not announce a recovery.
  const clean = harness();
  await clean.service.run(runtime(async (_command, _options, writer, context) => {
    context.normalizeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }, 'native-1');
    writer.send({ kind: 'complete', exitCode: 0 });
  }), 'task', clean.options, clean.writer, clean.context);
  assert.equal(clean.events.filter((event) => event.kind === 'status').length, 0);
});

test('quota messages in normal replies and tool failures do not replay completed work', async () => {
  const h = harness();
  let attempts = 0;
  await h.service.run(runtime(async (_command, _options, writer, context) => {
    attempts++;
    context.normalizeMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Handle rate_limit_error here.' }] } }, 'native-1');
    writer.send({ kind: 'tool_result', isError: true, content: '429 quota exhausted in test fixture' });
    context.normalizeMessage({ type: 'result', is_error: false, result: 'done' }, 'native-1');
    writer.send({ kind: 'complete', exitCode: 0 });
  }), 'task', h.options, h.writer, h.context);
  assert.equal(attempts, 1);
  assert.deepEqual(h.waits, []);
});

test('warnings, child rate limits, and internally recovered failures do not retry', async () => {
  for (const event of [
    { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning' } },
    { type: 'assistant', parent_tool_use_id: 'child-1', error: 'rate_limit' },
    { type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } },
  ]) {
    const h = harness();
    await h.service.run(runtime(async (_command, _options, writer, context) => {
      context.normalizeMessage(event, 'native-1');
      context.normalizeMessage({ type: 'result', is_error: false, result: 'done' }, 'native-1');
      writer.send({ kind: 'complete', exitCode: 0 });
    }), 'task', h.options, h.writer, h.context);
    assert.deepEqual(h.waits, []);
    assert.equal(h.events.filter((message) => message.kind === 'complete').length, 1);
  }
});

test('authentication, invalid CLI options, and ordinary process crashes fail normally', async () => {
  for (const message of ['401 Unauthorized', "unknown option '--effort'", 'Claude Code process exited with code 1']) {
    const h = harness();
    await assert.rejects(h.service.run(runtime(async () => { throw new Error(message); }),
      'task', h.options, h.writer, h.context), { message });
    assert.deepEqual(h.waits, []);
  }
});

test('a quota error before the request was accepted resends the original prompt and attachments', async () => {
  const h = harness();
  const commands: string[] = [];
  const attachments: unknown[] = [];
  await h.service.run(runtime(async (command, options, writer) => {
    commands.push(command);
    attachments.push(options.images);
    if (commands.length === 1) throw Object.assign(new Error('request rejected'), { status: 429 });
    writer.send({ kind: 'complete', exitCode: 0 });
  }), 'original request', { ...h.options, images: ['image'] }, h.writer, h.context);
  assert.deepEqual(commands, ['original request', 'original request']);
  assert.deepEqual(attachments, [['image'], ['image']]);
  assert.deepEqual(h.waits, [300_000]);
});

test('Chinese gateway quota errors retry, and explicit opt-out disables the loop', async () => {
  for (const enabled of [true, false]) {
    const h = harness();
    let attempts = 0;
    await h.service.run(runtime(async (_command, _options, writer) => {
      if (++attempts === 1) writer.send({ kind: 'error', content: 'API Error: 当前5小时额度不足，请等待重置' });
      writer.send({ kind: 'complete', exitCode: attempts === 1 ? 1 : 0 });
    }), 'task', { ...h.options, autoRetryQuota: enabled }, h.writer, h.context);
    assert.equal(attempts, enabled ? 2 : 1);
  }
});

test('late background quota failures cannot replay an already completed turn', async () => {
  const h = harness();
  let attempts = 0;
  await h.service.run(runtime(async (_command, _options, writer, context) => {
    attempts++;
    writer.send({ kind: 'complete', exitCode: 0 });
    quotaFailure(context, writer);
  }), 'task', h.options, h.writer, h.context);
  assert.equal(attempts, 1);
  assert.deepEqual(h.waits, []);
});

test('disabled default keeps the unwrapped runtime contract', async () => {
  const h = harness();
  const service = createClaudeQuotaRetryService({ enabled: () => false });
  const result = await service.run(runtime(async (command, options, writer, context) => {
    assert.equal(command, 'task');
    assert.equal(options, h.options);
    assert.equal(writer, h.writer);
    assert.equal(context, h.context);
    return 'unchanged';
  }), 'task', h.options, h.writer, h.context);
  assert.equal(result, 'unchanged');
});

test('real Claude adapter resumes after a scripted SDK quota rejection and emits only final completion', async () => {
  const h = harness();
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'claude-quota-retry-'));
  const sessions = new ClaudeSessionsProvider({ getLiveRunStartTime: () => null });
  const sdkOptions: AnyRecord[] = [];
  const prompts: unknown[] = [];
  const promptReaders: Promise<void>[] = [];
  h.writer.userId = null;
  h.context.normalizeMessage = (raw, id) => sessions.normalizeMessage(raw, id);
  h.context.createQuery = ({ prompt, options }) => {
    sdkOptions.push(options);
    const rejected = sdkOptions.length === 1;
    promptReaders.push((async () => {
      for await (const message of prompt) prompts.push(message);
    })());
    return Object.assign((async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'native-1' };
      if (rejected) {
        yield {
          type: 'rate_limit_event', session_id: 'native-1',
          rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour' },
        };
        yield {
          type: 'assistant', session_id: 'native-1', error: 'rate_limit',
          message: { role: 'assistant', content: [{ type: 'text', text: "You've hit your limit · resets 5pm" }] },
        };
      }
      yield {
        type: 'result', subtype: 'success', session_id: 'native-1',
        is_error: rejected, result: rejected ? "You've hit your limit · resets 5pm" : 'done',
      };
    })(), { interrupt: async () => {} });
  };
  try {
    await h.service.run(runtime(queryClaudeSDK), 'finish task', { ...h.options, cwd }, h.writer, h.context);
    await Promise.all(promptReaders);
    assert.equal(sdkOptions.length, 2);
    assert.equal(sdkOptions[0].resume, undefined);
    assert.equal(sdkOptions[1].resume, 'native-1');
    assert.match(JSON.stringify(prompts[0]), /finish task/);
    assert.match(JSON.stringify(prompts[1]), /resume from the last unfinished step/);
    assert.deepEqual(h.waits, [300_000]);
    assert.equal(h.events.filter((message) => message.kind === 'complete').length, 1);
    assert.ok(h.events.some((message) => message.quotaRetry?.retryAt));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
