/**
 * This package's version and writer stamp (effectiveness-analytics spec §4.2, D56, D66).
 * Read from package.json, which every published tarball carries, so the stamp is the
 * installed version and needs no build step to stay in step.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const CORE_VERSION: string = (require('../package.json') as { version: string }).version;
export const CORE_WRITER_STAMP = `core@${CORE_VERSION}`;
