/**
 * Which plain plugin this copy of the mod ships in. scripts/build-plugins.mjs rewrites this file in each
 * plugin; this source copy holds the browser plugin's values, which the tests use.
 */
export const PLUGIN: string = 'plain';
/** `native` (desktop, mobile): `open` starts a new flow, so the pane starts over, as the server's transcript does. */
export const ENGINE: 'browser' | 'native' = 'browser';
