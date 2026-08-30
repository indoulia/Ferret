// A minimal long-running Ferret host, used to observe graceful shutdown under
// a real signal. Prints machine-readable markers so the test asserts on
// observed behaviour rather than timing.
import { createRuntime, installSignalHandlers, createNullLogger } from '../../dist/index.js';

const released = [];

const runtime = createRuntime({
  logger: createNullLogger(),
  providers: [
    {
      id: 'test.long.running',
      kind: 'storage',
      contractVersion: 1,
      initialize: () => undefined,
      shutdown: () => {
        released.push('provider');
      },
    },
  ],
});

runtime.registerDisposable('handle', () => {
  released.push('disposable');
});

installSignalHandlers({
  shutdown: () => runtime.shutdown(),
  logger: createNullLogger(),
  graceMs: 5000,
  onExit: (code) => {
    console.log(`RELEASED ${released.join(',')}`);
    console.log(`STATE ${runtime.state}`);
    console.log(`EXIT ${code}`);
    process.exit(code);
  },
});

await runtime.initialize();
console.log('READY');

// Keep the process alive until a signal arrives.
const keepAlive = setInterval(() => {}, 1000);
runtime.signal.addEventListener('abort', () => clearInterval(keepAlive));
