import { Worker } from "node:worker_threads";

/** Keep parent-death detection alive even if the desktop SDK blocks Node's main thread. */
export function watchParent() {
  const watchdog = new Worker(
    `const { workerData } = require('node:worker_threads');
     setInterval(() => {
       if (process.ppid !== workerData.parent) process.kill(process.pid, 'SIGKILL');
     }, 500);`,
    { eval: true, execArgv: [], workerData: { parent: process.ppid } },
  );
  watchdog.unref();
  return watchdog;
}
