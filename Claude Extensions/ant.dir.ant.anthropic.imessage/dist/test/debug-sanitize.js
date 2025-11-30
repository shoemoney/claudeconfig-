#!/usr/bin/env node
import { sanitizeMessageContent } from '../src/sanitize.js';
const backtickAttack = 'Message with `sender`: value';
const result = sanitizeMessageContent(backtickAttack);
console.log('Input:', backtickAttack);
console.log('Output:', result);
console.log('Contains backtick?', result.includes('`'));
console.log('Contains single quote?', result.includes("'"));
//# sourceMappingURL=debug-sanitize.js.map