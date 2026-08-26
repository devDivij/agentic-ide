/**
 * The UI's single import point for wire types. Type-only re-export from the
 * server's shared contract — erased at build time, so no server code is ever
 * bundled into the browser.
 */
export type * from '../../server/src/shared/types.ts';
