// Entrypoint: a trend-following momentum bot for btc-race-24h-20261123-0511.
//
// The bot speaks agent-fun/bars-replay/v1 through the kit's SDK shim
// (vendor/makefun-bars.ts): hello once, then one batch per bar, then done.
// Each batch carries the bar that just closed, the fills of the orders sent
// on the previous batch, and the account. The strategy (strategy.ts) decides
// from the closes alone; this file only translates its signals into orders.
//
// Order sizing: a buy spends all cash on hand (one asset, one position, the
// weight cap is 100% of equity); a sell empties the whole position. Both use
// a 100 bps max-slippage bound measured from the latest close, wide enough
// that ordinary fills are never rejected, tight enough that a wild gap open
// cannot fill at a ruinous price. No order is ever sent on a warm-up batch,
// on a batch with no CBBTC bar, or before the strategy has enough history.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';
import { MomentumStrategy } from './strategy.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

const strategy = new MomentumStrategy();

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  if (state.warmingUp) return [];
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined) return [];

  const close = Number(bar.c);
  const position = state.positions.get(SYMBOL);
  const holding = position !== undefined && position.qty > 0n;

  const signal = strategy.onClose(close, holding);

  if (signal.action === 'buy' && !holding) {
    const spend = state.cash;
    if (spend <= 0n) return [];
    const room = state.weightRoom(SYMBOL);
    const notional = spend < room ? spend : room;
    if (notional <= 0n) return [];
    return [
      {
        side: 'buy',
        symbol: SYMBOL,
        notional_quote_units: notional,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  if (signal.action === 'sell' && holding) {
    return [
      {
        side: 'sell',
        symbol: SYMBOL,
        qty: position.qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
      },
    ];
  }

  return [];
}

await runBars({ onBatch });
