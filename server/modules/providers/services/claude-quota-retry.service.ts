import { setTimeout as delay } from 'node:timers/promises';

import type { IProviderRuntime } from '@/shared/interfaces.js';
import type { AnyRecord, ProviderRuntimeContext, ProviderRuntimeWriter } from '@/shared/types.js';
import { createCompleteMessage, createNormalizedMessage, readObjectRecord } from '@/shared/utils.js';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const RESET_GRACE_MS = 5000;
// Match API errors only, never ordinary assistant prose or tool output.
const QUOTA_ERROR = /rate[_ -]?limit|too many requests|\b429\b|insufficient[_ -]?quota|quota.{0,60}(?:exceed|exhaust|insufficient)|(?:usage|spending|session|weekly|five.hour|5.hour) limit|(?:hit|reached|exceeded) your limit|(?:额度|配额).{0,20}(?:不足|耗尽|用完|超|限制)|限流|no available accounts/i;

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return value.message;
  if (Array.isArray(value)) return value.map(errorText).filter(Boolean).join('\n');
  const record = readObjectRecord(value);
  if (!record) return '';
  return [record.type, record.code, record.status, record.message, record.error, record.text]
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join(' ');
}

function isQuotaError(value: unknown): boolean {
  const record = readObjectRecord(value);
  return Number(record?.status ?? record?.statusCode) === 429 || QUOTA_ERROR.test(errorText(value));
}

function epochMilliseconds(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value < 1e12 ? value * 1000 : value;
}

const defaultDependencies = {
  enabled: () => /^(1|true)$/i.test(process.env.CLOUDCLI_QUOTA_RETRY ?? ''),
  intervalMs: () => {
    const value = Number(process.env.CLOUDCLI_QUOTA_RETRY_INTERVAL_MS);
    return Number.isFinite(value) && value >= 1000
      ? Math.min(value, 60 * 60 * 1000)
      : DEFAULT_INTERVAL_MS;
  },
  now: () => Date.now(),
  wait: async (milliseconds: number, signal: AbortSignal) => {
    await delay(milliseconds, undefined, { signal, ref: false });
  },
};

/**
 * Used by provider-runtime.service and its tests to keep Claude quota failures
 * in the same active run until capacity recovers or the user stops it. Waiting
 * is server-owned; a websocket disconnect does not cancel it. No timers or
 * user prompts are written into provider configuration.
 */
export function createClaudeQuotaRetryService(overrides: Partial<typeof defaultDependencies> = {}) {
  const dependencies = { ...defaultDependencies, ...overrides };
  // Each session owns its cancellation controller, including while no CLI is
  // alive. Identity checks keep a finishing old run from removing its successor.
  const active = new Map<string, AbortController>();

  return {
    async run(
      runtime: IProviderRuntime,
      command: string,
      options: AnyRecord,
      writer: ProviderRuntimeWriter,
      context: ProviderRuntimeContext,
    ): Promise<unknown> {
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : '';
      // Direct API calls without a stable session cannot safely resume work.
      if (!dependencies.enabled() || options.autoRetryQuota === false || !sessionId) {
        return runtime.run(command, options, writer, context);
      }

      const controller = new AbortController();
      active.get(sessionId)?.abort();
      active.set(sessionId, controller);
      let providerSessionId = context.resolveProviderSessionId(sessionId);
      let retryCount = 0;
      let originalRequestRecorded = false;

      const status = (text: string, retryAt?: number) => writer.send(createNormalizedMessage({
        provider: 'claude', sessionId, kind: 'status', text, canInterrupt: true,
        quotaRetry: { attempt: retryCount, retryAt: retryAt ? new Date(retryAt).toISOString() : null },
      }));

      try {
        while (!controller.signal.aborted) {
          let quotaFailure = false;
          let resetsAt: number | null = null;
          let terminalForwarded = false;
          let result: unknown;
          let thrown: unknown;
          let didThrow = false;

          const attemptContext: ProviderRuntimeContext = {
            ...context,
            resolveProviderSessionId: (id) => id === sessionId
              ? (providerSessionId ?? context.resolveProviderSessionId(id))
              : context.resolveProviderSessionId(id),
            normalizeMessage(raw, id) {
              const event = readObjectRecord(raw);
              // Ignore quota signals from subagents: restarting the main turn
              // because a child failed can repeat already completed actions.
              if (event && !event.parent_tool_use_id && !terminalForwarded) {
                if (event.type === 'rate_limit_event') {
                  const info = readObjectRecord(event.rate_limit_info);
                  if (info?.status === 'rejected') {
                    quotaFailure = true;
                    resetsAt = epochMilliseconds(info.resetsAt);
                  }
                } else if (event.type === 'assistant' && (event.error || event.isApiErrorMessage)) {
                  quotaFailure = isQuotaError(event.error)
                    || isQuotaError(errorText(event.message?.content));
                  originalRequestRecorded = true;
                } else if (event.type === 'user') {
                  originalRequestRecorded = true;
                } else if (event.type === 'assistant' && !event.error) {
                  // A real assistant response proves the SDK recovered from a
                  // transient quota event internally. Never retry that success.
                  quotaFailure = false;
                  originalRequestRecorded = true;
                } else if (event.type === 'result') {
                  if (event.is_error) {
                    const details = errorText(event.errors) || errorText(event.result);
                    quotaFailure = Number(event.api_error_status) === 429
                      || isQuotaError(details) || (!details && quotaFailure);
                  } else {
                    quotaFailure = false;
                  }
                }
              }
              return context.normalizeMessage(raw, id);
            },
          };

          // Preserve the writer's class methods and private-field receiver.
          // Only terminal delivery and native session capture need interception.
          const attemptWriter = new Proxy(writer, {
            get(target, property) {
              if (property === 'setSessionId') return (id: string) => {
                providerSessionId = id;
                target.setSessionId?.(id);
              };
              if (property === 'send') return (data: unknown) => {
                const message = readObjectRecord(data);
                if (controller.signal.aborted) return;
                if (message?.kind === 'session_created') {
                  const nativeId = message.newSessionId ?? message.sessionId;
                  if (typeof nativeId === 'string') providerSessionId = nativeId;
                }
                if (message?.kind === 'error' && !terminalForwarded && isQuotaError(message.content)) {
                  quotaFailure = true;
                }
                if (message?.kind === 'complete') {
                  if (quotaFailure && !message.aborted && !terminalForwarded) return;
                  terminalForwarded = true;
                }
                target.send(data);
              };
              const value = Reflect.get(target, property, target);
              return typeof value === 'function' ? value.bind(target) : value;
            },
          });

          // Once the original request is in the transcript, resume with a
          // small continuation rather than appending it (and attachments)
          // repeatedly throughout a five-hour outage.
          const resuming = retryCount > 0 && Boolean(providerSessionId) && originalRequestRecorded;
          const attemptCommand = resuming
            ? 'Continue the original interrupted task in this conversation. The API quota was exhausted. Check the existing work and resume from the last unfinished step; do not repeat completed actions.'
            : command;
          const attemptOptions = retryCount > 0
            ? { ...options, resumeAnchorId: undefined, resumeFromScratch: false,
              ...(resuming ? { attachments: [], images: [], files: [] } : {}) }
            : options;

          try {
            result = await runtime.run(attemptCommand, attemptOptions, attemptWriter, attemptContext);
          } catch (error) {
            didThrow = true;
            thrown = error;
            quotaFailure = quotaFailure || isQuotaError(error);
          }

          if (controller.signal.aborted) break;
          // Completion wins over late background errors. The registry may
          // already have admitted the user's next turn after that completion.
          if (terminalForwarded || !quotaFailure) {
            if (didThrow) throw thrown;
            return result;
          }

          retryCount += 1;
          const now = dependencies.now();
          const retryAt = resetsAt && resetsAt > now
            ? resetsAt + RESET_GRACE_MS
            : now + dependencies.intervalMs();
          const displayTime = new Date(retryAt).toLocaleTimeString('zh-CN', { hour12: false });
          status(`额度不足，等待至 ${displayTime} 自动重试（第 ${retryCount} 次，可停止）`, retryAt);
          console.info('[ClaudeQuotaRetry] Waiting for quota', {
            sessionId, attempt: retryCount, retryAt: new Date(retryAt).toISOString(),
          });
          try {
            // Slice long resets to avoid setTimeout's 32-bit overflow and to
            // tolerate wall-clock adjustments without ever spinning requests.
            while (dependencies.now() < retryAt && !controller.signal.aborted) {
              await dependencies.wait(Math.min(retryAt - dependencies.now(), 60 * 60 * 1000), controller.signal);
            }
          } catch (error) {
            if (!controller.signal.aborted) throw error;
          }
          if (!controller.signal.aborted) status(`正在重试额度（第 ${retryCount} 次）`);
        }

        // A successor owns its own terminal event. Otherwise the websocket
        // abort path and this completion are safely deduplicated by the registry.
        if (active.get(sessionId) === controller) {
          writer.send(createCompleteMessage({ provider: 'claude', sessionId, exitCode: 0, aborted: true }));
        }
        return undefined;
      } finally {
        if (active.get(sessionId) === controller) active.delete(sessionId);
      }
    },

    cancel(sessionId: string): boolean {
      const controller = active.get(sessionId);
      if (!controller) return false;
      controller.abort();
      return true;
    },
  };
}
