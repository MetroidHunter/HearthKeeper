import { registerGreenlightParser } from '../greenlight/parser.js';
import { registerChaseParser } from '../chase/parser.js';
import { registerReceiptParsers } from '../receipts/parsers.js';

/** Every parser that ships enabled. Experimental receipt parsers are opt-in (see src/receipts). */
export function registerAllParsers(opts: { experimental?: boolean } = {}) {
  registerGreenlightParser();
  registerChaseParser();
  if (opts.experimental ?? process.env.HK_EXPERIMENTAL_PARSERS === '1') registerReceiptParsers(); // guesses until real samples are captured
}
