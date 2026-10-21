import { z } from 'zod';

// Browsers enforce a CSP without 'unsafe-eval': zod 4 would probe `new Function` when each schema
// is built and log a violation on every page load. Schemas are built when this package is
// evaluated, so the switch has to be flipped first (index.ts imports this module before anything
// else). Servers and the agent keep the faster JIT parsers.
if (typeof document !== 'undefined') z.config({ jitless: true });
