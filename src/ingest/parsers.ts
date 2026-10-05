import { registerGreenlightParser } from '../greenlight/parser.js';
import { registerChaseParser } from '../chase/parser.js';

/** Every parser that ships enabled. Experimental receipt parsers are opt-in (see src/receipts). */
export function registerAllParsers() {
  registerGreenlightParser();
  registerChaseParser();
}
