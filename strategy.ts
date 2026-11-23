// Trend-following momentum strategy for the CBBTC/USDC 1-minute replay.
//
// The idea, in one line: catch the day's main uptrend early, hold it all
// day, and let a breakeven stop — not a nervous exit — protect the trade.
// This bot never buys a dip and never chases a falling market: with no
// uptrend it sits in cash and scores exactly zero on that stretch, which
// beats bleeding money into a downtrend.
//
// Entry (all four must hold on the same bar):
//   1. The fast EMA of closes is above the slow EMA by at least
//      MIN_TREND_BPS — the trend is real, not a one-bar wiggle.
//   2. The close breaks above the highest close of the previous
//      BREAKOUT_BARS bars — the move is making new ground, not merely
//      drifting up inside an old range.
//   3. Regime: the slow EMA itself is rising — it sits at least
//      MIN_SLOPE_BPS above where it was SLOPE_BARS bars ago. Plain
//      breakouts are mostly noise (on the dev windows, only ~37% are
//      followed by any further gain); requiring the slow average to be
//      climbing keeps the bot out of dead-cat bounces inside a falling
//      market. The lookback is deliberately short (30 bars): a longer one
//      lags so much the bot only enters near the end of a rally.
//   4. Enough history exists (more than SLOPE_BARS closes), the batch is
//      not a warm-up batch, and COOLDOWN_BARS have passed since the last
//      exit (no immediate re-entry into the same chop).
// The buy spends all available cash: one asset, one position, no reason to
// hold back once the signal has passed every filter.
//
// Exit (either one triggers a full sell):
//   1. Breakeven stop: once the position's peak gain reaches
//      BE_TRIGGER_BPS above the entry close, the stop moves to the entry
//      close plus BE_LOCK_BPS. If the rally rolls over, the trade exits
//      near flat instead of giving the whole move back. This is the exit
//      that does most of the work: it turns losing trades into ~breakeven
//      ones while letting winners run untouched.
//   2. Trailing stop: the close falls TRAIL_BPS below the highest close
//      seen since the position opened. Deliberately wide (250 bps): the
//      rallies worth riding pull back 100+ bps on the way up, and a tight
//      stop sells every one of them. The trailing stop is the backstop for
//      a trade that never went far enough to arm the breakeven stop.
//
// Deliberately NOT used: an exit on the fast EMA crossing back below the
// slow EMA. It was tested and removed: in a rising market the fast average
// dips below the slow one on every pullback, so the cross exit sells the
// bottom of each dip and the bot re-buys higher — the single most
// expensive mistake in backtesting. The breakeven and trailing stops exit
// on price, which is what actually pays.
//
// Costs: a full-size round trip pays roughly 26 bps in fees, slippage and
// price impact, so the filters above exist to keep the bot out of flat chop
// (median 1-minute move on the dev windows is ~2.5-2.8 bps) and in only
// when a move large enough to pay for itself is already under way.
//
// Determinism: every decision is a pure function of the closes seen so far.
// No clock, no randomness, no environment. The two graded runs therefore
// produce identical action logs.

export interface MomentumParams {
  /** Span of the fast EMA, in bars. */
  fastLen: number;
  /** Span of the slow EMA, in bars. */
  slowLen: number;
  /** Lookback for the breakout high, in bars (excluding the current bar). */
  breakoutBars: number;
  /** Fast EMA must clear the slow EMA by at least this many bps to enter. */
  minTrendBps: number;
  /** Sell when the close drops this many bps below the peak since entry. */
  trailBps: number;
  /** Lookback for the slow-EMA regime slope, in bars. */
  slopeBars: number;
  /** Slow EMA must have risen by at least this many bps over slopeBars. */
  minSlopeBps: number;
  /** Peak gain (bps over the entry close) that arms the breakeven stop. */
  beTriggerBps: number;
  /** Once armed, sell if the close falls to entry close + this many bps. */
  beLockBps: number;
  /** Bars to wait after an exit before the next entry is allowed. */
  cooldownBars: number;
}

export const DEFAULT_PARAMS: MomentumParams = {
  fastLen: 8,
  slowLen: 32,
  breakoutBars: 24,
  minTrendBps: 8,
  trailBps: 250,
  slopeBars: 30,
  minSlopeBps: 10,
  beTriggerBps: 50,
  beLockBps: 15,
  cooldownBars: 60,
};

/** What the strategy wants to do on this bar. */
export type Signal =
  | { action: 'buy' }
  | { action: 'sell' }
  | { action: 'hold' };

export class MomentumStrategy {
  readonly params: MomentumParams;
  /** Closes seen so far, oldest first, as plain numbers (raw price units). */
  #closes: number[] = [];
  /** Slow EMA after each bar, oldest first (for the regime slope). */
  #slowHist: number[] = [];
  #fastEma: number | null = null;
  #slowEma: number | null = null;
  /** Highest close since the current position opened; null while flat. */
  #peakSinceEntry: number | null = null;
  /** Close of the bar on which the current position's buy was decided. */
  #entryClose: number | null = null;
  /** Bar index (count of closes seen) of the last exit; -Infinity if none. */
  #lastExitBar = -Infinity;

  constructor(params: MomentumParams = DEFAULT_PARAMS) {
    this.params = params;
  }

  /** Number of bars fed so far. */
  get barsSeen(): number {
    return this.#closes.length;
  }

  get fastEma(): number | null {
    return this.#fastEma;
  }

  get slowEma(): number | null {
    return this.#slowEma;
  }

  /**
   * Feed one bar's close and decide. `holding` says whether the account
   * currently holds the asset (from the batch's account, not from our own
   * memory of orders, so a rejected order can never confuse the state).
   */
  onClose(close: number, holding: boolean): Signal {
    this.#closes.push(close);
    const { fastLen, slowLen } = this.params;
    const fastK = 2 / (fastLen + 1);
    const slowK = 2 / (slowLen + 1);
    this.#fastEma =
      this.#fastEma === null ? close : close * fastK + this.#fastEma * (1 - fastK);
    this.#slowEma =
      this.#slowEma === null ? close : close * slowK + this.#slowEma * (1 - slowK);
    this.#slowHist.push(this.#slowEma);

    if (!holding) {
      this.#peakSinceEntry = null;
      this.#entryClose = null;
      const signal = this.#entrySignal(close);
      if (signal.action === 'buy') this.#entryClose = close;
      return signal;
    }

    // In a position: maintain the running peak, then check the exits.
    if (this.#peakSinceEntry === null || close > this.#peakSinceEntry) {
      this.#peakSinceEntry = close;
    }
    const signal = this.#exitSignal(close);
    if (signal.action === 'sell') this.#lastExitBar = this.#closes.length;
    return signal;
  }

  #entrySignal(close: number): Signal {
    const {
      slowLen,
      breakoutBars,
      minTrendBps,
      slopeBars,
      minSlopeBps,
      cooldownBars,
    } = this.params;
    if (this.#closes.length <= Math.max(slowLen, slopeBars)) return { action: 'hold' };
    if (this.#closes.length - this.#lastExitBar < cooldownBars) return { action: 'hold' };
    if (this.#fastEma === null || this.#slowEma === null) return { action: 'hold' };

    // 1. Trend: fast EMA clears slow EMA by at least minTrendBps.
    const trendBps = ((this.#fastEma - this.#slowEma) / this.#slowEma) * 10000;
    if (trendBps < minTrendBps) return { action: 'hold' };

    // 2. Breakout: close above every close of the previous breakoutBars bars.
    const start = this.#closes.length - 1 - breakoutBars;
    let prevHigh = -Infinity;
    for (let i = start; i < this.#closes.length - 1; i++) {
      const c = this.#closes[i]!;
      if (c > prevHigh) prevHigh = c;
    }
    if (!(close > prevHigh)) return { action: 'hold' };

    // 3. Regime: the slow EMA itself is climbing over the last slopeBars bars.
    const oldSlow = this.#slowHist[this.#slowHist.length - 1 - slopeBars]!;
    const slopeBps = ((this.#slowEma - oldSlow) / oldSlow) * 10000;
    if (slopeBps < minSlopeBps) return { action: 'hold' };

    return { action: 'buy' };
  }

  #exitSignal(close: number): Signal {
    const { trailBps, beTriggerBps, beLockBps } = this.params;

    // 1. Breakeven stop: armed once the peak gain clears beTriggerBps,
    // then exits if the close falls back to entry close + beLockBps.
    if (this.#peakSinceEntry !== null && this.#entryClose !== null) {
      const peakGainBps =
        ((this.#peakSinceEntry - this.#entryClose) / this.#entryClose) * 10000;
      if (
        peakGainBps >= beTriggerBps &&
        close <= this.#entryClose * (1 + beLockBps / 10000)
      ) {
        return { action: 'sell' };
      }
    }

    // 2. Trailing stop: close TRAIL_BPS below the peak since entry.
    if (this.#peakSinceEntry !== null) {
      const givebackBps =
        ((this.#peakSinceEntry - close) / this.#peakSinceEntry) * 10000;
      if (givebackBps >= trailBps) return { action: 'sell' };
    }
    return { action: 'hold' };
  }
}
