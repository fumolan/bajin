#!/usr/bin/env node
import('../dist/main.js').catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
