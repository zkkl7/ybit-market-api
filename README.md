# ybit-market-api

`/api/scan-v42` currently serves OI Radar V4.6.1. It is a sidecar confirmation
layer: the V4.4 candidate pools, `entrySignal`, ledger membership, liquidity
rules, runner score, and historical ranking remain compatible.

V4.5 adds behavior-based confirmation without waiting a fixed number of 5m
candles. Its main candidate fields are:

- `entryStage` / `v45EntryStage`: `PROBE` or `CONFIRMED`
- `v45EntrySignal` and `v45Confirmation`
- `executionScore` (`directionConfidence` is a compatibility alias), `strictPriceReclaim`, and `nearReclaim`
- `executionTier`: `CLEAN` or `MIXED`, plus lightweight `microPersistence`
- `takerBuyVolume`, `takerSellVolume`, `buySellImbalance`
- `cvd1m`, `cvd3m`, `cvd5m`, `cvdBias`, and `orderFlowBias`
- `obiScore`, `obiTop10`, `obiTop20`, and `orderBookBias`
- `invalidationReason`, `v45RiskFlags`, and `v45DataFreshness`
- `v45RunnerPotential` and `v45RunnerReasons`

Recent public trades and a top-20 order-book snapshot are requested only for a
bounded set of existing V4.4 candidates. Either request may fail independently;
the scan then marks that source unavailable and continues with the V4.4 result.
Opposing order flow is a confirmation gate: it can lower an otherwise confirmed
setup to `PROBE`, while simultaneous opposing CVD and order flow caps V4.5
runner potential at `LOW`. `BZUSDT` is classified with TradFi commodity
perpetuals and is excluded from crypto candidate pools.

`data/v46-ledger.json` is the independent short-horizon lifecycle ledger. It
keeps one event per active symbol+direction setup, records PROBE/CONFIRMED/lost
transitions, and evaluates 15m/30m/60m MFE, MAE, +0.5/+1/+2 and time-to-profit.
