#!/usr/bin/env node
// Potts WP-0 redaction helper. No dependencies.
//
// Replaces secret-ish values with `<redacted:sha256:XXXXXXXXXXXX>` (first 12 hex
// chars of SHA-256 of the original value) so that a change is detectable across
// captures without the value itself being stored or printed.
//
// Usage:
//   node redact.mjs json  [FILE|-]   # JSON document -> redacted, key-sorted JSON
//   node redact.mjs env   [FILE|-]   # KEY=value / export KEY=value lines
//   node redact.mjs text  [FILE|-]   # free text: redacts known token shapes only
//   node redact.mjs selftest         # built-in checks, exit 1 on failure
//
// Plists: convert first (`plutil -convert json -o - X.plist | node redact.mjs json`).

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const SECRET_KEY =
  /(token|secret|passw|passphrase|cookie|credential|api[-_]?key|apikey|private[-_]?key|bearer|authorization|auth[-_]?header|session[-_]?key|signing|client[-_]?secret|webhook[-_]?url|dsn|salt|nonce|otp|pin$)/i;
// Keys that look secret-ish but in practice hold numeric limits / modes / paths.
const SAFE_KEY = /^(maxTokens|contextTokens|tokenizer|tokenFile|tokenPath|passwordFile|authMode|mode|kind|type|source|provider)$/i;
const SECRET_VALUE = [
  /^sk-[A-Za-z0-9_-]{16,}/, // OpenAI/Anthropic style
  /^sk-ant-/,
  /^(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/,
  /^github_pat_/,
  /^xox[abprs]-/,
  /^AIza[0-9A-Za-z_-]{20,}/,
  /^ya29\./,
  /^eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, // JWT
  /^\d{6,12}:[A-Za-z0-9_-]{30,}$/, // Telegram bot token
  /^hf_[A-Za-z0-9]{20,}/,
  /^(AC|SK)[0-9a-f]{32}$/, // Twilio SIDs
  /^-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function tag(value) {
  const h = createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
  return `<redacted:sha256:${h}>`;
}

function looksLikePath(v) {
  return /^(\/|~\/|\.\/)/.test(v) && !/\s/.test(v);
}

function isDottedIdentifier(v) {
  return /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+$/.test(v);
}

export function valueLooksSecret(v) {
  if (typeof v !== 'string') return false;
  if (SECRET_VALUE.some((re) => re.test(v))) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i.test(v)) return true; // creds in URL
  if (/[?&](token|key|secret|sig|signature|access_token|code)=[^&\s]{8,}/i.test(v)) return true;
  return false;
}

export function keyLooksSecret(key, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  if (SAFE_KEY.test(key)) return false;
  if (typeof value === 'string' && /^(env|keychain|file|exec|op):[^\s]+$/i.test(value)) return false; // secret *references*
  if (key === 'key' || /(^|[-_])key$|Key$/.test(key)) {
    // LM Studio style {"key":"llm.load.contextLength","value":...} is a field name.
    if (typeof value === 'string' && isDottedIdentifier(value)) return false;
    if (typeof value === 'number') return false;
    return true;
  }
  if (!SECRET_KEY.test(key)) return false;
  if (typeof value === 'number') return false;
  if (looksLikePath(value)) return false; // e.g. tokenFile paths are not secrets
  if (value === '' || /^(true|false|none|off|on|token|password|env|keychain|file)$/i.test(value)) return false;
  if (/^(env|keychain|file|exec|op):/i.test(value)) return false; // secret *references*
  return true;
}

export function redactJson(node, parentKey = '') {
  if (Array.isArray(node)) return node.map((v) => redactJson(v, parentKey));
  if (node && typeof node === 'object') {
    const out = {};
    for (const k of Object.keys(node).sort()) {
      const v = node[k];
      if (keyLooksSecret(k, v) || valueLooksSecret(v)) out[k] = tag(v);
      else out[k] = redactJson(v, k);
    }
    return out;
  }
  if (valueLooksSecret(node)) return tag(node);
  return node;
}

export function redactEnv(text) {
  return text
    .split('\n')
    .map((line) => {
      const m = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!m) return redactText(line);
      const [, pre, name, raw] = m;
      const val = raw.replace(/^(['"])(.*)\1$/, '$2');
      if (SECRET_KEY.test(name) || /(^|_)KEY$/.test(name) || valueLooksSecret(val)) {
        return `${pre}${name}=${tag(val)}`;
      }
      return line;
    })
    .join('\n');
}

export function redactText(text) {
  return text.replace(/[^\s"'=,;]+/g, (tok) => (valueLooksSecret(tok) ? tag(tok) : tok));
}

function readInput(file) {
  return readFileSync(!file || file === '-' ? 0 : file, 'utf8');
}

function selftest() {
  const input = {
    gateway: { auth: { mode: 'token', token: 'abcdef' + '0123456789' + 'abcdef' }, port: 18789 },
    channels: { telegram: { tokenFile: '/x/credentials/telegram-bot-token', botToken: '123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' } },
    providers: { lm: { apiKey: 'lm-studio', baseUrl: 'http://127.0.0.1:1234/v1' } },
    fields: [{ key: 'llm.load.contextLength', value: 32768 }],
    maxTokens: 4096,
    ref: { apiKey: 'keychain:potts/gmail' },
    url: 'https://u:p4ssw0rd@example.com/x',
    other: 'sk-ant-api03-zzzzzzzzzzzzzzzzzzzzzzzz',
  };
  const out = redactJson(input);
  const s = JSON.stringify(out);
  const checks = [
    [!s.includes('abcdef0123456789abcdef'), 'gateway token redacted'],
    [!s.includes('AAAAAAAAAAAAAAAA'), 'bot token redacted'],
    [!s.includes('lm-studio'), 'apiKey redacted'],
    [s.includes('/x/credentials/telegram-bot-token'), 'tokenFile path kept'],
    [s.includes('llm.load.contextLength') && s.includes('32768'), 'LM Studio field names kept'],
    [out.maxTokens === 4096, 'numeric maxTokens kept'],
    [out.ref.apiKey === 'keychain:potts/gmail', 'secret reference kept'],
    [!s.includes('p4ssw0rd'), 'URL credentials redacted'],
    [!s.includes('sk-ant-api03'), 'value-shaped secret redacted'],
    [out.gateway.auth.mode === 'token', 'auth mode kept'],
    [tag('x') === tag('x') && tag('x') !== tag('y'), 'tag is deterministic'],
  ];
  const env = redactEnv('export PATH=/usr/bin\nexport OPENAI_API_KEY=' + 'sk-' + '1234567890'.repeat(3) + '\nFOO_TOKEN="abc"\n');
  checks.push([env.includes('PATH=/usr/bin'), 'env PATH kept']);
  checks.push([!env.includes('sk-1234') && !env.includes('"abc"'), 'env secrets redacted']);
  let ok = true;
  for (const [pass, name] of checks) {
    console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}`);
    if (!pass) ok = false;
  }
  process.exit(ok ? 0 : 1);
}

const [mode, file] = process.argv.slice(2);
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('redact.mjs')) {
  switch (mode) {
    case 'json': {
      const raw = readInput(file);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Not valid JSON (e.g. CLI banner + JSON). Fall back to text redaction.
        process.stdout.write(redactText(raw));
        break;
      }
      process.stdout.write(JSON.stringify(redactJson(parsed), null, 2) + '\n');
      break;
    }
    case 'env':
      process.stdout.write(redactEnv(readInput(file)));
      break;
    case 'text':
      process.stdout.write(redactText(readInput(file)));
      break;
    case 'selftest':
      selftest();
      break;
    default:
      console.error('usage: redact.mjs json|env|text [FILE|-] | selftest');
      process.exit(2);
  }
}
