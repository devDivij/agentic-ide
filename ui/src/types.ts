/**
 * The UI's single import point for wire types. Type-only re-export from the
 * project's shared wire contract — erased at build time, so no server code is ever
 * bundled into the browser.
 */
export type * from '../../shared/types.ts';
