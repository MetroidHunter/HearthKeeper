import { registerGreenlightParser } from '../greenlight/parser.js';
import { registerChaseParser } from '../chase/parser.js';
import { registerReceiptParsers } from '../receipts/parsers.js';
import { registerWfNoticeParser } from '../wf/notice.js';

/** Every parser that ships enabled. Receipt parsers can be switched off with HK_DISABLE_RECEIPT_PARSERS=1 (or `receipts: false`). */
export function registerAllParsers(opts: { receipts?: boolean } = {}) {
  registerGreenlightParser();
  registerChaseParser();
  registerWfNoticeParser();
  if (opts.receipts ?? process.env.HK_DISABLE_RECEIPT_PARSERS !== '1') registerReceiptParsers();
}
