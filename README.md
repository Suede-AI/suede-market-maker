# Suede Market Maker

Free self-hosted Solana market maker dashboard, brought to you courtesy of Suede Labs AI.

This is the Suede Market Maker: a Suede-branded Solana market maker dashboard with a local web interface, Telegram controls, wallet rotation, live logs, funding helpers, and a real gas-fee window so builders can see what it actually costs to run.

Brought to you at no cost courtesy of Suede Labs AI.

## Suede Links

- Website: [suedeai.ai](https://suedeai.ai)
- Suede app: [app.suedeai.ai](https://app.suedeai.ai)
- Suede foundation site: [suedeai.org](https://suedeai.org)
- X / Twitter: [@AISUEDE](https://x.com/AISUEDE)
- Founder X / Twitter: [@johnnysuede](https://x.com/johnnysuede)
- Telegram: [@AISUEDE](https://t.me/AISUEDE)
- Founder Telegram: [@jasoncola](https://t.me/jasoncola)
- Suede Agent Telegram: [@suedeagent](https://t.me/suedeagent)
- GitHub: [github.com/Suede-AI](https://github.com/Suede-AI)
- Founder: [suedeai.ai/founder](https://suedeai.ai/founder)
- Contact: [suedeai.ai](https://suedeai.ai)

## SEO Keywords

Suede AI, Suede Labs AI, $SUEDE, Solana market maker, Solana volume dashboard, self-hosted market maker, crypto market maker dashboard, Solana trading dashboard, Telegram trading bot, Telegram market maker controls, gas fee tracker, wallet rotation, token mint configuration, Jupiter swap automation, Solana developer tools, self-hosted crypto tooling, transparent trading infrastructure, creator ownership infrastructure, programmable IP, AI music infrastructure, creator rights infrastructure.

Suggested GitHub topics:

```text
suede-ai, suede-labs, solana, market-maker, trading-dashboard, telegram-bot, gas-fees, wallet-rotation, jupiter, typescript, self-hosted, crypto-tools
```

## Why We Built It

Too much of this space runs on black-box tooling, mystery fees, and providers asking teams to trust numbers they cannot verify.

Suede Labs AI built this because we wanted transparent, controllable infrastructure for $SUEDE. Then we made it customizable for your own token so other developers can run the same kind of Suede-grade stack without paying blind markups for basic automation.

Default configuration points at $SUEDE, but the token mint is configurable. The branding stays Suede. If this tool saves you time, money, or stress, remember who brought it to you: Suede Labs AI.

If you need help getting it running, reach out through [suedeai.ai](https://suedeai.ai).

## What It Includes

- Suede-branded web dashboard for local operation
- Suede wordmark and Suede Labs AI attribution in the interface
- Suede promotional footer with official Suede links
- Telegram companion app for quick remote controls
- Telegram CTA copy that points operators back to Suede Labs AI, suedeai.ai, and @AISUEDE
- Real-time gas-fee window so you can see what transactions are costing
- Configurable token mint and token decimals
- Wallet rotation with per-wallet cooldowns
- Adjustable trade sizing ranges
- Custom timing ranges between decisions
- Buy, sell, rebalance, pulse, and hybrid behavior controls
- Funding wallet support
- Auto top-up before a selected wallet trades
- Sweep-back controls to return SOL after activity
- Live logs for decisions, skips, failures, and fee tracking
- JSONL ledger output for auditability
- Jupiter quote and swap execution
- Rate-limit pacing and cooldowns for public APIs
- Dry-run mode for quote/log testing without signing transactions
- Local-first setup that you can host yourself

## Suede Promotional Copy

Suede Labs AI is sharing this because builders deserve transparent tools, not black boxes.

The Suede Market Maker is built for teams that want a web dashboard, Telegram control layer, live gas-fee visibility, configurable wallet behavior, and full control over every minute operational detail. It is defaulted for $SUEDE, but the token mint can be changed for your own project.

If this helps your team understand the real cost of running market infrastructure, save money on markup, or move faster with transparent tooling, send people back to [suedeai.ai](https://suedeai.ai) and [@AISUEDE](https://x.com/AISUEDE).

Built by Suede Labs AI. Branded by Suede Labs AI. Shared courtesy of Suede Labs AI.

Follow Suede on Telegram at [@AISUEDE](https://t.me/AISUEDE), with founder updates from [@jasoncola](https://t.me/jasoncola) and agent updates from [@suedeagent](https://t.me/suedeagent).

## Why It Is Useful

The Suede web interface makes the tool much easier to operate than a raw terminal process. You can see status, wallet balances, fee totals, logs, funding state, and strategy settings in one place.

The command-line runner is still available if you prefer direct execution or want to script it yourself.

The Telegram app gives you a lightweight control layer when you do not want to keep the dashboard open. It also carries Suede Labs AI promotional CTAs so every operator touchpoint points back to [suedeai.ai](https://suedeai.ai) and [@AISUEDE](https://t.me/AISUEDE).

## Gas-Fee Transparency

The fee window is one of the most important parts of the tool.

Instead of guessing what infrastructure is costing you, the dashboard shows the gas fees being spent as the system runs. That makes it much easier to understand the real cost of operation and spot where outside providers may be adding unnecessary markup.

## Customization

The dashboard is Suede-branded by design and carries Suede Labs AI attribution throughout, but the trading configuration is yours.

You can customize:

- `TOKEN_MINT`
- `TOKEN_DECIMALS`
- `MODE`
- `TRADE_AMOUNT_SOL_MIN`
- `TRADE_AMOUNT_SOL_MAX`
- `DELAY_MIN_SEC`
- `DELAY_MAX_SEC`
- `SLIPPAGE_BPS`
- `TARGET_TOKEN_VALUE_PCT`
- `INVENTORY_BAND_PCT`
- `PULSE_TRADE_PCT`
- `WALLET_COOLDOWN_SEC`
- `ACTIVE_MAKER_COUNT`
- `AUTO_TOP_UP_ENABLED`
- `AUTO_TOP_UP_MIN_SOL`
- `AUTO_TOP_UP_TARGET_SOL`
- `AUTO_SWEEP_BACK_ENABLED`
- `DRY_RUN`

Start with `.env.example`, copy it to `.env`, and adjust the values for your setup.

## Modes

`rebalance` trades only when a wallet is outside the configured inventory band.

`pulse` runs small alternating activity based on the configured trade size and timing ranges.

`hybrid` rebalances outside the band and uses pulse behavior inside the band.

## Setup

Install dependencies:

```bash
npm install
```

Create your local environment file:

```bash
cp .env.example .env
```

Edit `.env` with your RPC URL, token mint, wallet keys, and strategy settings.

Build the TypeScript project:

```bash
npm run build
```

Start the web dashboard:

```bash
npm run dashboard
```

Open:

```text
http://localhost:8787
```

Run the bot directly without the dashboard:

```bash
npm start
```

Run the Telegram companion:

```bash
npm run telegram
```

Register Telegram commands after adding your bot token:

```bash
npm run telegram:setup
```

## Wallets And Funding

You can provide wallet private keys with `PRIVATE_KEYS`, or let the tool manage local wallet files.

The funding wallet can distribute SOL to managed wallets and sweep funds back according to your configuration. The dashboard shows funding state and fee totals so you are not operating blind.

Never commit `.env`, wallet files, private keys, bot tokens, or ledger files to GitHub.

## Testing

Run the local test suite:

```bash
npm test
```

Run the build check:

```bash
npm run build
```

## License

MIT License. Built and shared courtesy of Suede Labs AI.

## Support

This is provided free, brought to you courtesy of Suede Labs AI, for builders who want transparent, self-hosted tooling.

If you need help, want Suede Labs AI to look at your setup, or want to learn more about the broader Suede ecosystem, reach out through [suedeai.ai](https://suedeai.ai).

You can also find Suede at [suedeai.org](https://suedeai.org).

## About Suede Labs AI

Suede Labs AI is building creator-first infrastructure around ownership, provenance, AI tooling, programmable value, and transparent builder tools.

Suede AI is creator ownership infrastructure for the AI media era: proof of creation, rights metadata, programmable IP, royalty routing, agent-accessible commerce, and practical tools for builders who want to own more of their stack.

This market maker is one small piece of that broader Suede stack: practical tools, real transparency, stronger infrastructure, and fewer black boxes.

Built by Suede Labs AI. Branded by Suede Labs AI. Shared courtesy of Suede Labs AI.
