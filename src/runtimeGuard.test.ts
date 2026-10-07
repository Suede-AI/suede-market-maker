import assert from "assert";
import {
  describeRuntime,
  findExternalBotProcess,
  scanExternalBotProcess,
} from "./runtimeGuard";

const processList = [
  "29588 node dist/index.js",
  "50391 /usr/local/bin/node /Users/jasoncolapietro/code/suede-market-maker/dist/index.js",
  "51000 /usr/local/bin/node /Users/jasoncolapietro/code/suede-market-maker/node_modules/ts-node/dist/bin.js src/index.ts",
  '60000 /bin/zsh -lc echo "node dist/index.js"',
  "50196 /usr/local/bin/node dist/dashboard.js",
].join("\n");

assert.deepStrictEqual(findExternalBotProcess(processList), {
  pid: 29588,
  command: "node dist/index.js",
});

assert.deepStrictEqual(findExternalBotProcess(processList, [29588]), {
  pid: 50391,
  command: "/usr/local/bin/node /Users/jasoncolapietro/code/suede-market-maker/dist/index.js",
});

assert.strictEqual(
  findExternalBotProcess(processList, [29588, 50391, 51000]),
  null,
  "shell text and the dashboard process must not be mistaken for a bot loop"
);

assert.deepStrictEqual(findExternalBotProcess(processList, [29588, 50391]), {
  pid: 51000,
  command: "/usr/local/bin/node /Users/jasoncolapietro/code/suede-market-maker/node_modules/ts-node/dist/bin.js src/index.ts",
});

assert.deepStrictEqual(
  scanExternalBotProcess([], () => processList),
  {
    bot: {
      pid: 29588,
      command: "node dist/index.js",
    },
    reliable: true,
  },
  "a successful process scan should report the external bot"
);

assert.deepStrictEqual(
  scanExternalBotProcess([], () => {
    throw new Error("ps unavailable");
  }),
  { bot: null, reliable: false },
  "a failed process scan must be distinguishable from a clean scan"
);

const externalBot = {
  pid: 29588,
  command: "node dist/index.js",
};

assert.deepStrictEqual(describeRuntime(null, externalBot), {
  running: true,
  managedRunning: false,
  externalRunning: true,
  duplicateRunning: false,
  runtimeSource: "external",
  pid: 29588,
  externalPid: 29588,
});

assert.deepStrictEqual(describeRuntime(50391, externalBot), {
  running: true,
  managedRunning: true,
  externalRunning: true,
  duplicateRunning: true,
  runtimeSource: "multiple",
  pid: 50391,
  externalPid: 29588,
});

assert.deepStrictEqual(describeRuntime(null, null), {
  running: false,
  managedRunning: false,
  externalRunning: false,
  duplicateRunning: false,
  runtimeSource: "none",
  pid: null,
  externalPid: null,
});
