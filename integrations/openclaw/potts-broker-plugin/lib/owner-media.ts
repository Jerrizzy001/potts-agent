/**
 * Owner-only media delivery tools: potts_send_voice and potts_send_file.
 *
 * The only destination is the owner's own Telegram chat (owner id from the plugin's secret
 * reference); there is no recipient parameter. Delivery goes through the gateway's own
 * `openclaw message send`, so it is the same Telegram adapter as every other reply.
 * One call = one real delivery; the result says whether Telegram accepted it.
 */
import { execFile } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, statSync } from 'node:fs';
import { basename } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PluginConfig, SecretsProvider } from './config.ts';
import { deliveryReceiptAccepted, nativeDeliveryReceipt } from './delivery-receipt.ts';

export interface RunResult { code: number; stdout: string; stderr: string }
export type Runner = (cmd: string, args: string[], timeoutMs: number) => Promise<RunResult>;

const defaultRunner: Runner = (cmd, args, timeoutMs) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
  });
});

const MAX_FILE_BYTES = 45 * 1024 * 1024;
const BLOCKED_PATH = /(\/\.ssh\/|\/Keychains\/|\/\.openclaw\/(openclaw\.json|credentials|identity|devices)|\/Potts\/(policy\.json|potts\.db|accounts\.json))/;

interface ToolResult { content: { type: 'text'; text: string }[]; details: unknown }
const result = (text: string, details: unknown): ToolResult => ({ content: [{ type: 'text', text }], details });

export function createOwnerMediaTools(cfg: PluginConfig, secrets: SecretsProvider, opts: { run?: Runner; openclawCli?: string; sleep?: (ms: number) => Promise<void>; outbox?: string; deliverMedia?: (path: string, caption?: string) => Promise<unknown> } = {}) {
  const run = opts.run ?? defaultRunner;
  const cli = opts.openclawCli ?? join(homedir(), '.openclaw', 'bin', 'openclaw');
  const sayBin = join(cfg.pottsHome, 'bin', 'potts-say');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const outbox = opts.outbox ?? join(homedir(), '.openclaw', 'workspace', 'outbox');
  /** OpenClaw only sends local media from allowed roots; stage everything into the workspace outbox. */
  function stage(path: string): string {
    if (path.startsWith(outbox + '/')) return path;
    mkdirSync(outbox, { recursive: true });
    const dest = join(outbox, `${Date.now()}-${basename(path).replace(/[^A-Za-z0-9._-]/g, '_')}`);
    copyFileSync(path, dest);
    return dest;
  }

  async function deliver(path: string, caption: string | undefined): Promise<ToolResult> {
    path = stage(path);
    const s = await secrets.get();
    if (!s) return result('Not sent: the owner chat is not configured.', { ok: false, sent: false });
    if (opts.deliverMedia) {
      try {
        const receipt = nativeDeliveryReceipt(await opts.deliverMedia(path, caption?.slice(0, 900)));
        if (!receipt) throw new Error('The messaging service returned no confirmed acceptance');
        return result('Submitted to the owner through the configured messaging channel. Do not resend.', { ok: true, sent: true, path });
      } catch (e) {
        return result(`Delivery was not confirmed: ${(e as Error).message.slice(0, 300)}. Do not retry blindly.`, { ok: false, sent: false, uncertain: true });
      }
    }
    const args = ['message', 'send', '--channel', cfg.deliveryChannel ?? 'telegram', '--target', cfg.deliveryTarget ?? s.ownerId, '--media', path, '--json'];
    if (caption) args.push('-m', caption.slice(0, 900));
    const r = await run(cli, args, 120_000);
    const ok = r.code === 0 && deliveryReceiptAccepted(r.stdout, cfg.deliveryChannel ?? 'telegram', cfg.deliveryTarget ?? s.ownerId);
    return ok
      ? result('Delivered to the owner\'s chat. Do not send it again, and do not paste the path; a short casual line is enough.', { ok: true, sent: true, path })
      : result('Delivery was not confirmed. It may already have arrived; do not resend automatically.', { ok: false, sent: false, uncertain: true });
  }

  return [
    {
      name: 'potts_send_screenshot',
      description: 'Take a screenshot and send it to the owner as a picture in one call. With url: opens the page in your browser first. source "browser" (default) captures the browser tab; source "screen" captures the whole Mac screen (add recordSeconds for a short screen-recording video). Use this whenever he asks for a screenshot or picture of a page; the browser tool alone does NOT send anything.',
      parameters: { type: 'object', additionalProperties: false, properties: {
        url: { type: 'string', maxLength: 2048, description: 'Page to open first (https://...). Omit to capture the current tab.' },
        source: { enum: ['browser', 'screen'] },
        fullPage: { type: 'boolean', description: 'Capture the whole scrollable page (browser only).' },
        recordSeconds: { type: 'number', minimum: 2, maximum: 60, description: 'With source "screen": record a screen VIDEO for this many seconds instead of a picture.' },
        caption: { type: 'string', maxLength: 900 },
      } },
      async execute(_id: string, p: Record<string, unknown>): Promise<ToolResult> {
        const caption = typeof p.caption === 'string' ? p.caption : undefined;
        if (p.source === 'screen' && typeof p.recordSeconds === 'number') {
          const secs = Math.max(2, Math.min(60, Math.floor(p.recordSeconds)));
          const out = join(tmpdir(), `potts-screen-${Date.now()}.mov`);
          const r = await run('/usr/sbin/screencapture', ['-x', '-v', '-V', String(secs), out], (secs + 30) * 1000);
          if (r.code !== 0 || !existsSync(out)) return result('Not sent: macOS blocked the screen recording (Screen Recording permission). Tell the owner.', { ok: false, sent: false });
          return deliver(out, caption);
        }
        if (p.source === 'screen') {
          const out = join(tmpdir(), `potts-screen-${Date.now()}.png`);
          const r = await run('/usr/sbin/screencapture', ['-x', out], 30_000);
          if (r.code !== 0 || !existsSync(out)) return result('Not sent: macOS blocked the screen capture (Screen Recording permission). Tell the owner; offer a browser screenshot instead.', { ok: false, sent: false });
          return deliver(out, caption);
        }
        if (typeof p.url === 'string' && p.url.trim()) {
          const url = p.url.trim();
          if (!/^https?:\/\//i.test(url)) return result('Not sent: url must start with http:// or https://.', { ok: false, sent: false });
          const nav = await run(cli, ['browser', 'navigate', url], 60_000);
          if (nav.code !== 0) { const open = await run(cli, ['browser', 'open', url], 60_000); if (open.code !== 0) return result(`Not sent: could not open ${url}.`, { ok: false, sent: false }); }
          await sleep(2500);
        }
        const shot = await run(cli, ['browser', 'screenshot', ...(p.fullPage === true ? ['--full-page'] : [])], 90_000);
        const path = (shot.stdout.trim().split('\n').at(-1) ?? '').replace(/^~(?=\/)/, homedir());
        if (shot.code !== 0 || !path.startsWith('/') || !existsSync(path)) return result(`Not sent: screenshot failed (${(shot.stderr || shot.stdout).trim().slice(0, 200)}).`, { ok: false, sent: false });
        return deliver(path, caption);
      },
    },
    {
      name: 'potts_send_voice',
      description: 'Speak text in Potts\'s own voice and send the audio to the owner through his configured messaging channel. One call renders and delivers. Only goes to the owner.',
      parameters: { type: 'object', additionalProperties: false, required: ['text'], properties: { text: { type: 'string', minLength: 1, maxLength: 1500, description: 'What to say, casual and short.' } } },
      async execute(_id: string, p: Record<string, unknown>): Promise<ToolResult> {
        const text = typeof p.text === 'string' ? p.text.trim() : '';
        if (!text || text.length > 1500) return result('Not sent: text must be 1–1500 characters.', { ok: false, sent: false });
        if (!existsSync(sayBin)) return result('Not sent: the voice helper is not installed.', { ok: false, sent: false });
        const r = await run(sayBin, [text], 180_000);
        let path = r.stdout.trim().split('\n').at(-1) ?? '';
        if (r.code !== 0 || !path.endsWith('.ogg') || !existsSync(path)) return result(`Not sent: voice rendering failed (${r.stderr.trim().slice(0, 200)}).`, { ok: false, sent: false });
        if (cfg.deliveryChannel === 'imessage') {
          mkdirSync(outbox, { recursive: true, mode: 0o700 });
          const converted = join(mkdtempSync(join(outbox, 'voice-')), 'Potts.m4a');
          const conversion = await run('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-loglevel', 'error', '-i', path, '-c:a', 'aac', '-b:a', '96k', '-ac', '1', converted], 60_000);
          if (conversion.code !== 0 || !existsSync(converted)) return result('Not sent: iMessage audio conversion failed.', { ok: false, sent: false });
          path = converted;
        }
        return deliver(path, undefined);
      },
    },
    {
      name: 'potts_send_file',
      description: 'Send an existing file on this Mac (document, image, audio, video) to the owner through his configured messaging channel. Only goes to the owner. Give the absolute path; optional short caption.',
      parameters: { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string', minLength: 2, maxLength: 1024 }, caption: { type: 'string', maxLength: 900 } } },
      async execute(_id: string, p: Record<string, unknown>): Promise<ToolResult> {
        const raw = typeof p.path === 'string' ? p.path.trim().replace(/^~(?=\/)/, homedir()) : '';
        if (!raw.startsWith('/')) return result('Not sent: give an absolute file path.', { ok: false, sent: false });
        if (!existsSync(raw)) return result(`Not sent: no file at ${raw}.`, { ok: false, sent: false });
        const real = realpathSync(raw);
        const st = statSync(real);
        if (!st.isFile()) return result('Not sent: that path is not a file.', { ok: false, sent: false });
        if (st.size > MAX_FILE_BYTES) return result('Not sent: file is over 45 MB (Telegram bot limit is 50 MB).', { ok: false, sent: false });
        if (BLOCKED_PATH.test(real)) return result('Not sent: that file holds credentials or Potts\'s own config.', { ok: false, sent: false });
        return deliver(real, typeof p.caption === 'string' ? p.caption : undefined);
      },
    },
  ];
}

export const OWNER_MEDIA_TOOL_NAMES = ['potts_send_screenshot', 'potts_send_voice', 'potts_send_file'] as const;
