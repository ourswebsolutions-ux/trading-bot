# AI strategy prompting (Phase 5)

Strategies are created by writing a prompt in plain language. The flow is:

1. **The AI interprets the prompt.** Anthropic Claude or OpenAI turns it into a proposed rule set. The provider is chosen in Settings → AI assistant and can be switched per prompt.
2. **The client confirms.** The client reviews the rules and confirms them.
3. **The deterministic engine validates and executes.** It applies its own risk limits to every order.

An AI response can never place a trade on its own.

## Creating a strategy

Go to Strategies → **New strategy from prompt**. For example:

> Trade BTC when the 15-minute trend is bullish and RSI crosses above 30. Use 2% of my allocated trading capital per trade, set stop-loss at 1.5%, take-profit at 3%, and stop opening new trades after a daily loss of $20.

- **Mapping.** The model maps everything that is explicit:
  - BTCUSD on 15m candles
  - RSI(14) crossing above 30
  - 2% of capital per trade
  - 1.5% stop-loss and 3% take-profit
  - a $20 daily loss limit
- **Questions instead of guesses.** The model is instructed to ask about anything vague or missing rather than choose a value. Here it asks how "trend is bullish" should be defined, how much capital is allocated, and the maximum number of trades per day.
- **Answering and revising.** Answer the questions in the box below the conversation. You can also edit the prompt and choose **Regenerate from prompt**, which starts a fresh interpretation and discards earlier answers.
- **The review panel.** It shows:
  - what cannot be implemented, and why
  - what is unclear
  - what is still required
  - a plain-language explanation of how TradePilot will execute the rules, written by TradePilot from the rules and not by the AI
  - the rules themselves, the validation result, and the AI's own summary, labelled as AI output
- **Saving.** **Confirm and save** stays disabled until the rules are complete and valid, the prompt has not changed since it was interpreted, and the confirmation box is ticked. Saved strategies start **disabled**.
- **Advanced editor.** This is optional and secondary: it opens the interpreted rules in the manual builder.

## What TradePilot checks itself (independent of the AI)

- **Strict schema.**
  - The model must return JSON matching a strict schema (OpenAI strict mode, Anthropic structured outputs).
  - Malformed output is rejected.
  - The JSON is only ever mapped onto the rule model. Nothing from it is executed: no code, SQL, scripts or instructions.
- **Required elements.** These must be present:
  - instrument, timeframe and direction
  - entry rules for each traded side
  - stop-loss and position size
  - a daily loss limit (% or $) and a maximum number of trades per day

  TradePilot checks these itself. A model that claims it is "ready" while something is missing is not trusted.
- **Validation.** Before saving, enabling and every automated decision, TradePilot checks:
  - indicators exist, with parameters in range
  - the instrument is listed in your Delta Exchange region, so market data is available
  - the timeframe is supported
  - there are no contradictions:
    - impossible ranges
    - exits identical to entries
    - identical long and short rules
    - one stop-out costing more than the daily loss limit
    - a daily loss limit as large as the allocated capital
- **Cross-checks against your own words.**
  - If you mention one timeframe and the rules use another, saving is blocked until the mismatch is resolved.
  - Several timeframes, unavailable timeframes or durations, and unsupported concepts are listed under *Cannot be implemented*. TradePilot never substitutes a look-alike rule. Unsupported concepts include:
    - MACD, VWAP, stochastic, Ichimoku and volume
    - trailing stops
    - martingale, averaging down and pyramiding
    - grids and hedging
    - news and sentiment
    - leverage
    - pips
- **Risk limits enforced outside the AI.**
  - The Python engine re-checks the strategy and account limits on every candle (exposure, open positions, account daily loss, maximum order notional).
  - The desktop app re-checks again before sending an order.

## Strategy model

| | Supported |
|---|---|
| Instruments | Delta Exchange perpetual futures listed in your region |
| Timeframes | 5m, 15m, 1h, 4h, 1d (one per strategy) |
| Indicators | SMA, EMA, RSI, ATR, highest high / lowest low of previous N candles, Bollinger bands |
| Conditions | `>`, `<`, `>=`, `<=`, crosses above / below; groups of "all" or "any" |
| Stop-loss | % of entry, price points, or ATR(14) multiple (required) |
| Take-profit | % of entry, price points, or multiple of the stop distance (optional) |
| Sizing | % of capital as position value, % of capital risked at the stop, or fixed contracts |
| Allocated capital | Optional USD amount; % sizing then uses min(allocated capital, account equity). It does **not** reserve or move funds. |
| Daily limits | Max realized loss as % of equity and/or USD (whichever is hit first), max trades per UTC day |

The daily loss limit counts **realized** losses. An open position's unrealized loss does not count until it closes; its stop-loss bounds it.

## Changing a strategy

- **Change with a prompt.** Describe the change, for example "tighten the stop-loss to 1%". The AI receives the current rules and returns the complete updated strategy. TradePilot shows a deterministic before/after table of every changed field. Confirming saves it as a new **version**.
- **Revise original prompt.** Re-interprets an edited version of the original prompt and saves the result as a new version, with the new prompt.
- **Advanced edit.** Edits rules by hand; this also creates a new version.
- **History.** Every version is kept and immutable. The strategy page shows the original prompt beside the interpreted rules, the version history (with change requests), and the activity: paper and live sessions, recent signals and events, open positions, and closed trades.

### Running strategies and versions

- An automation runs a **pinned snapshot** of the version it started with. Saving a new version never changes a running session or an open position.
- On the Trading page, a session shows *vN saved, not applied*. **Apply vN** is only allowed when the session has no open position and no unconfirmed order. A version that changes the instrument or timeframe requires stopping and starting a new automation.
- Each trade records the strategy version that produced it.
- While an automation runs, only valid versions can be saved. Disabling or deleting the strategy requires stopping the automation first.

## Backtesting and paper trading

- **Analytics → Backtest** runs the rules on Delta Exchange history in the Python engine:
  - signals on a candle's close fill at the next open, and stops and targets are checked intrabar
  - fees (default: the strategy's 5 bps per side) and slippage (default 2 bps, configurable) are applied
- **Reported metrics:**
  - net P&L, total return and buy-and-hold return
  - maximum drawdown
  - trades, win rate, profit factor and Sharpe ratio
  - fees paid, average win and average loss, largest loss
  - longest losing streak
  - days halted by the loss or trade-count limits

  Results are labelled **SIMULATED**.
- **Start paper trading.** On the strategy page, this starts a simulated automation on live market data. Paper fills include the configurable *paper slippage* risk setting. Paper sessions are labelled *Paper · simulated*.
- **No automatic escalation.** A backtest or a paper session never enables the strategy, live trading, or a live automation. Live trading still requires the separate steps in [TRADING.md](TRADING.md).

## Testing

| Suite | Command | Covers |
|---|---|---|
| Unit | `npm test -w @tradepilot/desktop` | Example prompt, ambiguous, invalid, unsupported and conflicting-risk prompts; malformed AI output; timeframe mismatch; changes to a saved strategy; versioning; migration; conversion from confirmed rules to engine decisions; unconfirmed or invalid strategies never producing an order |
| Engine | `npm run test:engine` | Slippage and fees; USD daily loss limit; allocated capital |
| End-to-end | `npm run test:e2e` | The prompt workspace with the AI provider replaced by a test stub; validation and saving are real |
| Live | `npm run test:live` | The real OpenAI and Claude calls; skipped unless `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` are set |

## Limitations

- **The AI can misread a prompt.** Everything above narrows this risk, but it cannot remove it. Review the rules, backtest, and paper trade first.
- **One instrument, one timeframe, one position at a time per strategy.** Multi-timeframe conditions (for example a 1h trend filter with 15m entries) cannot be expressed. They are flagged, not approximated.
- **TradePilot's own unsupported-concept check is a keyword list.** It complements the model's own list; it is not a full language parser.
- **No time-based exits or time-of-day filters**, and no trailing stops.
- **Real OpenAI and Anthropic calls are not verified here.** They have not been run from this machine because no API keys are configured. The request format is covered by tests with recorded response shapes. Run `npm run test:live` with your keys to verify.
