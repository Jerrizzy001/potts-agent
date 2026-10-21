/** Read-only iMessage reader entry point (WP-3). There is no writer here; WP-7 owns writer*. */
export * from './reader.ts';
export { decodeAttributedBody } from './reader-typedstream.ts';
