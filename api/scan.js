const BASE = "https://api.bybit.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bybit(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${BASE}${path}?${qs.toString()}`;

  const r = await fetch(url, {
    headers: { Accept: "application/json" },
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(`Bybit HTTP ${r.status}: ${text.slice(0, 200)}`);
  }

  const data = JSON.parse(text);

  if (data.retCode !== 0) {
    throw new Error(`Bybit retCode ${data.retCode}: ${data.retMsg}`);
  }

  return data.result;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function pct(now, old) {
  now = num(now);
  old = num(old);

  if (now === null || old === null || old === 0) return null;

  return ((now / old) - 1) * 100;
}

function round(v, d = 2) {
  if (v === null || !Number.isFinite(v)) return null;
  return Number(v.toFixed(d));
}

function avg(arr) {
  const valid = arr.filter((x) => Number.isFinite(x));
  if (!valid.length) return null;

  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

// Bybit 返回通常为 newest -> oldest
function oiMetrics(list = []) {
  if (!list.length) return {};

  const rows = [...list]
    .map((x) => ({
      ts: Number(x.timestamp),
      oi: num(x.singleOpenInterest),
    }))
    .filter((x) => x.oi !== null)
    .sort((a, b) => b.ts - a.ts);

  if (rows.length < 2) return {};

  const current = rows[0].oi;

  const change = (bars) => {
    if (rows.length <= bars) return null;
    return pct(current, rows[bars].oi);
  };

  // 最近连续 15m OI 变化
  const steps = [];

  for (let i = Math.min(4, rows.length - 1); i >= 1; i--) {
    const older = rows[i].oi;
    const newer = rows[i - 1].oi;

    steps.push(round(pct(newer, older), 2));
  }

  return {
    singleOpenInterest: current,
    oi15mPct: round(change(1), 2),
    oi30mPct: round(change(2), 2),
    oi1hPct: round(change(4), 2),
    oi15mSteps: steps,
  };
}

function klineMetrics(list = []) {
  if (!list.length) return {};

  const rows = [...list]
    .map((x) => ({
      ts: Number(x[0]),
      open: num(x[1]),
      high: num(x[2]),
      low: num(x[3]),
      close: num(x[4]),
      volume: num(x[5]),
      turnover: num(x[6]),
    }))
    .sort((a, b) => b.ts - a.ts);

  if (!rows.length) return {};

  const current = rows[0].close;

  const priceChange = (bars) => {
    if (rows.length <= bars) return null;
    return pct(current, rows[bars].open);
  };

  const recentVol = rows
    .slice(0, 3)
    .map((x) => x.volume)
    .filter(Number.isFinite);

  const baselineVol = rows
    .slice(3, 15)
    .map((x) => x.volume)
    .filter(Number.isFinite);

  const recentAvg = avg(recentVol);
  const baselineAvg = avg(baselineVol);

  let volumeRatio = null;

  if (
    recentAvg !== null &&
    baselineAvg !== null &&
    baselineAvg > 0
  ) {
    volumeRatio = recentAvg / baselineAvg;
  }

  return {
    price5mPct: round(priceChange(1), 2),
    price15mPct: round(priceChange(3), 2),
    price1hPct: round(priceChange(12), 2),
    volume15mRatio: round(volumeRatio, 2),
  };
}

function classify(x) {
  const oi1h = x.oi1hPct ?? -999;
  const oi15 = x.oi15mPct ?? -999;
  const p1h = x.price1hPct ?? 999;
  const funding = x.fundingRate ?? 0;
  const vol = x.volume15mRatio ?? 0;

  const steps = (x.oi15mSteps || []).filter(
    (v) => Number.isFinite(v)
  );

  const positiveSteps =
    steps.filter((v) => v > 0).length;

  // 强启动候选
  if (
    oi1h >= 5 &&
    p1h > -3 &&
    p1h <= 8 &&
    vol >= 1.3
  ) {
    return "STRONG";
  }

  // 连续堆仓，尚未满足 1H +5%
  if (
    oi15 >= 0.7 &&
    positiveSteps >= 3 &&
    p1h > -4 &&
    p1h <= 6
  ) {
    return "PRE_WATCH";
  }

  // 极端负 funding + OI 建仓
  if (
    funding <= -0.001 &&
    oi15 > 0 &&
    p1h <= 8
  ) {
    return "SQUEEZE_WATCH";
  }

  return null;
}

function score(x) {
  let s = 0;

  const oi1h = x.oi1hPct ?? 0;
  const oi15 = x.oi15mPct ?? 0;
  const funding = x.fundingRate ?? 0;
  const vol = x.volume15mRatio ?? 1;
  const p1h = x.price1hPct ?? 0;

  s += Math.max(0, Math.min(oi1h, 15)) * 3;
  s += Math.max(0, Math.min(oi15, 6)) * 4;

  if (funding < 0) {
    s += Math.min(Math.abs(funding) * 10000, 20);
  }

  if (vol > 1) {
    s += Math.min((vol - 1) * 8, 15);
  }

  // 已经暴涨则降分
  if (p1h > 8) s -= 20;
  if (p1h > 15) s -= 30;

  return round(s, 1);
}

export default async function handler(req, res) {
  try {
    const started = Date.now();

    // ① 所有 USDT 永续 ticker
    const tickerResult = await bybit(
      "/v5/market/tickers",
      { category: "linear" }
    );

    const tickers = tickerResult.list || [];

    // ② 获取合约资料
    let instruments = [];
    let cursor = "";

    do {
      const params = {
        category: "linear",
        limit: "1000",
      };

      if (cursor) params.cursor = cursor;

      const result = await bybit(
        "/v5/market/instruments-info",
        params
      );

      instruments.push(...(result.list || []));
      cursor = result.nextPageCursor || "";

    } while (cursor);

    const allowed = new Set(
      instruments
        .filter(
          (x) =>
            x.status === "Trading" &&
            x.contractType === "LinearPerpetual" &&
            x.quoteCoin === "USDT"
        )
        .map((x) => x.symbol)
    );

    // ③ 第一层廉价过滤
    const universe = tickers
      .filter((x) => allowed.has(x.symbol))
      .map((x) => {
        const last = num(x.lastPrice);
        const prev = num(x.prevPrice1h);

        return {
          symbol: x.symbol,
          price: last,
          price1hTickerPct: pct(last, prev),
          price24hPct:
            num(x.price24hPcnt) !== null
              ? num(x.price24hPcnt) * 100
              : null,

          turnover24h: num(x.turnover24h),
          volume24h: num(x.volume24h),

          fundingRate: num(x.fundingRate),

          // 只使用单边 OI
          singleOpenInterest:
            num(x.singleOpenInterest),
        };
      })
      .filter((x) => {
        if (x.price === null) return false;

        // 排除极端已拉升标的
        if (
          x.price1hTickerPct !== null &&
          x.price1hTickerPct > 12
        ) {
          return false;
        }

        // 太冷门的先不要
        if (
          x.turnover24h !== null &&
          x.turnover24h < 500000
        ) {
          return false;
        }

        return true;
      });

    // 优先检查：
    // 负 funding + 1H 有波动 + 成交额较高
    universe.sort((a, b) => {
      const fa =
        a.fundingRate < 0
          ? Math.abs(a.fundingRate) * 100000
          : 0;

      const fb =
        b.fundingRate < 0
          ? Math.abs(b.fundingRate) * 100000
          : 0;

      const pa = Math.abs(a.price1hTickerPct || 0);
      const pb = Math.abs(b.price1hTickerPct || 0);

      return (fb + pb) - (fa + pa);
    });

    // Hobby 先限制 60 个，验证稳定性
    const shortlist = universe.slice(0, 60);

    const results = [];

    // ④ 分批请求，避免瞬间打爆 API
    for (let i = 0; i < shortlist.length; i += 5) {
      const batch = shortlist.slice(i, i + 5);

      const data = await Promise.all(
        batch.map(async (ticker) => {
          try {
            const [oi, kline] = await Promise.all([
              bybit(
                "/v5/market/open-interest",
                {
                  category: "linear",
                  symbol: ticker.symbol,
                  intervalTime: "15min",
                  limit: "8",
                }
              ),

              bybit(
                "/v5/market/kline",
                {
                  category: "linear",
                  symbol: ticker.symbol,
                  interval: "5",
                  limit: "20",
                }
              ),
            ]);

            const oiData =
              oiMetrics(oi.list || []);

            const kData =
              klineMetrics(kline.list || []);

            const row = {
              symbol: ticker.symbol,
              price: ticker.price,

              price5mPct:
                kData.price5mPct,

              price15mPct:
                kData.price15mPct,

              price1hPct:
                kData.price1hPct,

              price24hPct:
                round(ticker.price24hPct, 2),

              singleOpenInterest:
                oiData.singleOpenInterest,

              oi15mPct:
                oiData.oi15mPct,

              oi30mPct:
                oiData.oi30mPct,

              oi1hPct:
                oiData.oi1hPct,

              oi15mSteps:
                oiData.oi15mSteps,

              fundingRate:
                ticker.fundingRate,

              fundingPct:
                ticker.fundingRate !== null
                  ? round(
                      ticker.fundingRate * 100,
                      4
                    )
                  : null,

              volume15mRatio:
                kData.volume15mRatio,

              turnover24h:
                ticker.turnover24h,
            };

            row.signal = classify(row);

            if (!row.signal) return null;

            row.score = score(row);

            return row;

          } catch (e) {
            return null;
          }
        })
      );

      results.push(...data.filter(Boolean));

      await sleep(80);
    }

    results.sort(
      (a, b) => (b.score || 0) - (a.score || 0)
    );

    return res.status(200).json({
      status: "ok",

      source: "Bybit Official API",

      market:
        "Bybit USDT Linear Perpetual",

      oiDefinition:
        "singleOpenInterest",

      scannedAt:
        new Date().toISOString(),

      durationMs:
        Date.now() - started,

      universeCount:
        universe.length,

      deepScannedCount:
        shortlist.length,

      candidateCount:
        results.length,

      candidates:
        results.slice(0, 20),
    });

  } catch (e) {
    return res.status(500).json({
      status: "error",
      message: e.message,
    });
  }
}
