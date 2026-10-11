// The Rust addon (native/), built by `pnpm build:native` into native/cuckoo_native.node
import { createRequire } from 'node:module';

export const { Filter } = createRequire(import.meta.url)('../../native/cuckoo_native.node');
