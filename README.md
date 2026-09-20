# ybit-market-api

`/api/scan-v42` currently serves OI Radar V4.5. V4.5 is a sidecar confirmation
layer: the V4.4 candidate pools, `entrySignal`, ledger membership, liquidity
rules, runner score, and historical ranking remain compatible.

V4.5 adds behavior-based confirmation without waiting a fixed number of 5m
candles. Its main candidate fields are:

- `entryStage` / `v45EntryStage`: `PROBE` or `CONFIRMED`
- `v45EntrySignal` and `v45Confirmation`
- `priceConfirmScore`, `strictPriceReclaim`, and `directionConfidence`
- `takerBuyVolume`, `takerSellVolume`, `buySellImbalance`
- `cvd1m`, `cvd3m`, `cvd5m`, `cvdBias`, and `orderFlowBias`
- `obiScore`, `obiTop10`, `obiTop20`, and `orderBookBias`
- `invalidationReason`, `v45RiskFlags`, and `v45DataFreshness`
- `v45RunnerPotential` and `v45RunnerReasons`

Recent public trades and a top-20 order-book snapshot are requested only for a
bounded set of existing V4.4 candidates. Either request may fail independently;
the scan then marks that source unavailable and continues with the V4.4 result.
