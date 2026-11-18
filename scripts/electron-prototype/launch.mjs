import electron from "electron";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => key !== "ELECTRON_RUN_AS_NODE"),
);
const child = spawn(
  electron,
  [resolve("apps/electron-prototype"), ...process.argv.slice(2)],
  {
    env: environment,
    stdio: "inherit",
  },
);
child.once("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
