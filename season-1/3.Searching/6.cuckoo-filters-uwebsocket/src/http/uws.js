// uWebSockets.js v20.71.0 ships an ESM wrapper that imports a file the package does not contain, so `import uWS from 'uWebSockets.js'`
// fails. Its CommonJS entry works, so load that one through createRequire. Every file imports uWS from here.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export default require('uWebSockets.js');
