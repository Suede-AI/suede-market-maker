import assert from "assert";
import { marketMakerActionBlock, startMarketMaker } from "./telegram";

const externalBot = {
  bot: { pid: 29588, command: "node dist/index.js" },
  reliable: true,
};

assert.strictEqual(
  startMarketMaker(() => externalBot),
  "Market maker already running outside Telegram pid=29588"
);

assert.strictEqual(
  startMarketMaker(() => ({ bot: null, reliable: false })),
  "Safety lock: unable to verify that another market maker loop is not already running"
);

assert.strictEqual(
  marketMakerActionBlock("distributing SOL", () => externalBot),
  "Stop the market maker in tmux or its terminal before distributing SOL"
);

assert.strictEqual(
  marketMakerActionBlock("sweeping SOL", () => ({ bot: null, reliable: false })),
  "Safety lock: unable to verify that the market maker is stopped before sweeping SOL"
);

assert.strictEqual(
  marketMakerActionBlock("previewing a sweep", () => ({ bot: null, reliable: true })),
  null
);
