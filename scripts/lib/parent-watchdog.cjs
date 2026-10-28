/**
 * Parent-death watchdog, injected into the runtime child via
 * NODE_OPTIONS=--require.
 *
 * A launcher that is SIGKILLed cannot run its own shutdown, so the server it
 * spawned is orphaned: it keeps the port and the PGLite data dir open, invisible
 * to everyone (a test run that times out leaves one behind forever — that is
 * exactly how 11 of them accumulated). Node has no prctl(PDEATHSIG) equivalent,
 * so this polls the parent and exits when it disappears.
 *
 * Cheap and local: one liveness check every 2s, nothing sent over the network.
 */
const parentPid = Number(process.env.BZ_PARENT_PID || 0);

if (parentPid > 0) {
  const timer = setInterval(() => {
    try {
      process.kill(parentPid, 0); // signal 0 = "does this pid exist?"
    } catch {
      // Parent is gone. Exit without a graceful flush: the parent owns the
      // shutdown path, and staying alive is the bug we are fixing.
      process.exit(0);
    }
  }, 2000);
  timer.unref();
}
