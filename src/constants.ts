import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/**
 * Path to bundled starter agent definitions.
 * Use as `localDefinitions` in config for quick-start without registry access.
 */
export const STARTER_DEFINITIONS_DIR = resolve(__dirname, '../definitions/starter');
