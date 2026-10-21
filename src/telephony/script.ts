/**
 * What Potts says on an alert call. Short, generic, in Potts's own (provider
 * text-to-speech) voice, and free of personal profile data: the details stay
 * in Telegram. Only a fixed template per trigger plus a sanitized short label
 * (e.g. a site name) are spoken.
 */
import type { AlertTrigger } from './types.ts';

const TEMPLATES: Record<AlertTrigger, (label: string | null) => string> = {
  website_outage: (l) => `${l ?? 'A monitored website'} has been down for at least ten minutes.`,
  task_due: () => 'An unfinished task is due within six hours.',
  interview_invitation: () => 'You have a new job interview invitation.',
  business_opportunity: () => 'A new business enquiry or client opportunity needs your attention.',
  test: () => 'This is a test of owner alert calls.',
};

/** Labels are spoken aloud: letters, digits, spaces, dots and hyphens only, max 40 chars. */
export function sanitizeLabel(label: unknown): string | null {
  if (typeof label !== 'string') return null;
  const s = label.replace(/[^A-Za-z0-9 .-]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40);
  return s.length ? s : null;
}

export function alertMessage(trigger: AlertTrigger, label: unknown): string {
  return `Hi, this is Potts with an alert. ${TEMPLATES[trigger](sanitizeLabel(label))} Details are in Telegram. Press 1 to acknowledge.`;
}

export const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/** TwiML for the alert: the message inside a 1-digit DTMF <Gather>, said twice, then hang up. */
export function alertTwiml(say: string, gatherUrl: string, voice = 'Polly.Matthew'): string {
  const v = xmlEscape(voice);
  const s = xmlEscape(say);
  return (
    '<?xml version="1.0" encoding="UTF-8"?><Response>' +
    `<Gather input="dtmf" numDigits="1" timeout="8" actionOnEmptyResult="false" method="POST" action="${xmlEscape(gatherUrl)}">` +
    `<Say voice="${v}">${s}</Say><Pause length="1"/><Say voice="${v}">${s}</Say>` +
    '</Gather>' +
    `<Say voice="${v}">No acknowledgement received. Goodbye.</Say><Hangup/></Response>`
  );
}

export const ACK_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">Thanks. Alert acknowledged. Goodbye.</Say><Hangup/></Response>';
export const NOT_ACK_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response><Say voice="Polly.Matthew">Not acknowledged. Potts may call again. Goodbye.</Say><Hangup/></Response>';
export const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response/>';
