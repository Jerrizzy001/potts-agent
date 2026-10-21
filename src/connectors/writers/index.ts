/** WP-7 message writers: entry module. Production wiring uses registerMessageWriters() only. */
export * from './writer-payload.ts';
export * from './writer-guard.ts';
export * from './writer-support.ts';
export * from './writer-preview.ts';
export * from './writer-router.ts';
export { createGmailWriter, GMAIL_SEND_SCOPE, GMAIL_LOOKUP_SCOPE, type WriterExecutor, type GmailWriterOptions } from '../gmail/writer.ts';
export { buildMime, parseMime } from '../gmail/writer-mime.ts';
export { createOutlookWriter, GRAPH_SEND_SCOPES, GRAPH_LOOKUP_SCOPES, type OutlookWriterOptions } from '../outlook/writer.ts';
export { createImessageWriter, IMESSAGE_SEND_SCRIPT, type ImessageWriterOptions, type OsascriptRunner } from '../imessage/writer.ts';
