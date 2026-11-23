# Trendline — a trend-following momentum bot for make.fun's BTC race

[![make.fun · btc-race-24h-20261123-0511](https://make.fun/badge/btc-race-24h-20261123-0511.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)
[![rank](https://make.fun/badge/btc-race-24h-20261123-0511/budi2499arfo2/btc-race-24h-20261123-0511/rank.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511/leaderboard)
[![reward](https://make.fun/badge/btc-race-24h-20261123-0511/budi2499arfo2/btc-race-24h-20261123-0511/reward.svg)](https://make.fun/bounty/btc-race-24h-20261123-0511)

A bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by
minute, in make.fun's `btc-race-24h-20261123-0511` replay. It starts with
1,000 USDC of paper money and is ranked by net PnL over a live 24-hour
race window.

## Strategy

Trend-following momentum — the opposite of buying dips. The bot enters
only when all four hold on the same bar:

1. The fast EMA (8 bars) of closes is above the slow EMA (32 bars) by at
   least 8 bps — the uptrend is real.
2. The close breaks above the highest close of the previous 24 bars — the
   move is making new ground.
3. Regime: the slow EMA itself is rising — at least 10 bps above where it
   was 30 bars ago. Plain breakouts are mostly noise; this keeps the bot
   out of dead-cat bounces inside a falling market.
4. Enough history exists, the batch is not a warm-up batch, and 60 bars
   have passed since the last exit.

It holds the position while the trend runs and exits in full when either
the breakeven stop fires (once the peak gain reaches 50 bps above the
entry close, the stop moves to entry + 15 bps, so a rolled-over rally
exits near flat) or the trailing stop fires (close 250 bps below the peak
since entry — deliberately wide, so real rallies are not sold on their
pullbacks). With no uptrend it stays in cash. Long only, no shorts, no
leverage; fully deterministic (no clock, no randomness — every decision is
a pure function of the closes seen).

## Layout

- `main.ts` — entrypoint: speaks the `agent-fun/bars-replay/v1` protocol
  through the SDK shim and turns strategy signals into orders.
- `strategy.ts` — the momentum strategy: EMAs, breakout test, exits.
- `vendor/makefun-bars.ts` — the kit's SDK shim, copied byte for byte.

## License

MIT — see `LICENSE`.
