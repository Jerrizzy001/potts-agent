/**
 * Local Qwen adapter for routine delegated work (text/investigation answers).
 * Talks to the loopback OpenAI-compatible endpoint (LM Studio / llmster) and
 * refuses any non-loopback base URL, so it can never become a cloud route.
 * It has no tools: it returns text that Potts treats as a draft/claim.
 */
export interface QwenAdapterOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  maxTokens?: number;
}

export interface QwenResult {
  ok: boolean;
  text: string;
  error: string | null;
  model: string;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export function createQwenAdapter(o: QwenAdapterOptions = {}) {
  const baseUrl = o.baseUrl ?? 'http://127.0.0.1:1234/v1';
  const host = new URL(baseUrl).hostname;
  if (!LOOPBACK.has(host)) throw new Error('qwen adapter: base URL must be loopback (local model only)');
  const model = o.model ?? 'qwen/qwen3.5-9b';
  const f = o.fetch ?? fetch;
  return {
    target: 'local_qwen' as const,
    async run(briefText: string): Promise<QwenResult> {
      try {
        const res = await f(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, messages: [{ role: 'user', content: briefText }], max_tokens: o.maxTokens ?? 2048, stream: false }),
          signal: AbortSignal.timeout(o.timeoutMs ?? 300_000),
        });
        if (!res.ok) return { ok: false, text: '', error: `HTTP ${res.status}`, model };
        const j = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const text = j.choices?.[0]?.message?.content ?? '';
        return text ? { ok: true, text, error: null, model } : { ok: false, text: '', error: 'empty response', model };
      } catch (e) {
        return { ok: false, text: '', error: (e as Error).message, model };
      }
    },
  };
}
