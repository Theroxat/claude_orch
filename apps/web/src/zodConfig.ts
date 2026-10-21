import { z } from 'zod';

// The CSP forbids 'unsafe-eval'. zod 4 probes `new Function` to JIT its parsers, which logs a CSP
// violation on every load. This module is imported first by main.tsx, before any schema is used.
// (@orch/shared flips the same switch when it is evaluated: schemas are built at that moment.)
z.config({ jitless: true });
