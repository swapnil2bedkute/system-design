import { connectDatabase } from './database.js';
import { rebuildBloom } from './bloom.js';

export const bootstrap = async () => {
  await connectDatabase();
  await rebuildBloom();
};
