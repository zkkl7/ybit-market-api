const BASE = "https://api.bybit.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bybit(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${BASE}${path}?${qs.toString()}`;

  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Bybit-OI-Radar/2.0",
    },
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(`HTTP ${r.status}: ${text.slice(0, 160)}`);
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non JSON: ${text.slice(0, 160)}`);
  }

  if (data.retCode !== 0) {
    throw new Error(`${data.retCode}: ${data.retMsg}`);
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
  const a = arr.filter(Number.isFinite);
  if (!a.length) return null;
  return a.reduce((x, y) => x + y, 0) / a.length;
}


// ============================================================
// OI
// ============================================================

function parseOI(list = []) {
  const rows = [...list]
    .map((x) => ({
      ts: Number(x.timestamp),

      // ======================================================
      // 永远只读取 Bybit 单边 OI
      // ======================================================
      oi: num(x.singleOpenInterest),
    }))
    .filter((x) => Number.isFinite(x.ts) && x.oi !== null)
    .sort((a, b) => b.ts - a.ts);

  if (rows.length < 5) return null;

  const current = rows[0].oi;

  const change = (bars) => {
    if (rows.length <= bars) return null;
    return pct(current, rows[bars].oi);
  };

  // oldest -> newest
  const steps = [];

  for (let i = 4; i >= 1; i--) {
    steps.push(
      round(
        pct(rows[i - 1].oi, rows[i].oi),
        2
      )
    );
  }

  const positiveSteps =
    steps.filter((x) => x !== null && x > 0).length;

  const negativeSteps =
    steps.filter((x) => x !== null && x < 0).length;

  return {
    current,

    oi15mPct: round(change(1), 2),
    oi30mPct: round(change(2), 2),
    oi1hPct: round(change(4), 2),

    steps,

    positiveSteps,
    negativeSteps,
  };
}


// ============================================================
// KLINE
// ============================================================

function parseKline(list = []) {
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
    .filter((x) => Number.isFinite(x.ts) && x.close !== null)
    .sort((a, b) => b.ts - a.ts);

  if (rows.length < 13) return null;

  const current = rows[0].close;

  const change = (bars) => {
    if (rows.length <= bars) return null;

    return pct(
      current,
      rows[bars].open
    );
  };

  const recent3 =
    rows
      .slice(0, 3)
      .map((x) => x.volume)
      .filter(Number.isFinite);

  const previous12 =
    rows
      .slice(3, 15)
      .map((x) => x.volume)
      .filter(Number.isFinite);

  const recentAvg = avg(recent3);
  const baselineAvg = avg(previous12);

  let volumeRatio = null;

  if (
    recentAvg !== null &&
    baselineAvg !== null &&
    baselineAvg > 0
  ) {
    volumeRatio = recentAvg / baselineAvg;
  }

  return {
    price5mPct: round(change(1), 2),
    price15mPct: round(change(3), 2),
    price1hPct: round(change(12), 2),

    volume15mRatio: round(volumeRatio, 2),
  };
}


// ============================================================
// OI 第一层发现评分
//
// 注意：
// Funding 不参与决定是否能进入发现层。
// ============================================================

function discoveryScore(x) {
  let score = 0;

  const oi15 = x.oi15mPct ?? 0;
  const oi30 = x.oi30mPct ?? 0;
  const oi1h = x.oi1hPct ?? 0;

  score += Math.max(oi15, 0) * 5;
  score += Math.max(oi30, 0) * 3;
  score += Math.max(oi1h, 0) * 4;

  // 连续建仓
  score += x.positiveSteps * 2;

  // 最新15M突然加速
  if (oi15 >= 1) score += 5;
  if (oi15 >= 2) score += 8;
  if (oi15 >= 4) score += 12;

  // 1H显著异常
  if (oi1h >= 3) score += 8;
  if (oi1h >= 5) score += 12;
  if (oi1h >= 8) score += 18;

  return round(score, 2);
}


// ============================================================
// 市场状态
// ============================================================

function classify(x) {
  const oi15 = x.oi15mPct ?? 0;
  const oi30 = x.oi30mPct ?? 0;
  const oi1h = x.oi1hPct ?? 0;

  const p5 = x.price5mPct ?? 0;
  const p15 = x.price15mPct ?? 0;
  const p1h = x.price1hPct ?? 0;

  const vol = x.volume15mRatio ?? 0;
  const funding = x.fundingRate ?? 0;

  const positiveSteps = x.positiveSteps ?? 0;
  const negativeSteps = x.negativeSteps ?? 0;


  // ==========================================================
  // 1. 已经爆拉
  // ==========================================================

  if (p1h >= 12) {
    return "OVEREXTENDED";
  }


  // ==========================================================
  // 2. OI 正在撤退
  //
  // 过去1H可能仍然是正值，
  // 但最近15M已经明显下降。
  //
  // TUT 第一波之后这种结构就应该被降级。
  // ==========================================================

  if (
    oi15 <= -0.7 ||
    (
      negativeSteps >= 2 &&
      oi15 < 0
    )
  ) {
    return "OI_UNWIND";
  }


  // ==========================================================
  // 3. 强 OI 启动
  // ==========================================================

  if (
    oi1h >= 5 &&
    oi15 > 0 &&
    p1h > -4 &&
    p1h <= 8 &&
    vol >= 1.2
  ) {
    return "STRONG";
  }


  // ==========================================================
  // 4. 二次蓄仓 / 重建
  //
  // 旧行情不能机械过滤。
  // 只要出现新的独立 OI 建仓，
  // 就重新进入观察。
  // ==========================================================

  if (
    oi30 >= 1.5 &&
    oi15 >= 0.5 &&
    positiveSteps >= 3 &&
    p1h <= 6
  ) {
    return "REBUILD";
  }


  // ==========================================================
  // 5. PRE WATCH
  //
  // 连续小幅建立 OI，
  // 即使1H没有达到 +5%。
  // ==========================================================

  if (
    oi15 >= 0.5 &&
    positiveSteps >= 3 &&
    p1h > -4 &&
    p1h <= 6
  ) {
    return "PRE_WATCH";
  }


  // ==========================================================
  // 6. SQUEEZE WATCH
  //
  // 极端负 Funding + OI 正增长
  // ==========================================================

  if (
    funding <= -0.001 &&
    oi15 > 0 &&
    p1h <= 8
  ) {
    return "SQUEEZE_WATCH";
  }


  // ==========================================================
  // 7. 普通 OI 异常
  // ==========================================================

  if (
    oi1h >= 3 ||
    oi15 >= 1
  ) {
    return "OI_WATCH";
  }


  return null;
}


// ============================================================
// 5M Trigger
// ============================================================

function triggerState(x) {
  const p5 = x.price5mPct ?? 0;
  const p15 = x.price15mPct ?? 0;
  const oi15 = x.oi15mPct ?? 0;
  const vol = x.volume15mRatio ?? 0;

  // 开始放量 + 价格开始转强
  if (
    oi15 > 0 &&
    p5 > 0.3 &&
    p15 > 0 &&
    vol >= 1.5
  ) {
    return "TRIGGERING";
  }

  // OI已经建，但价格还没动
  if (
    oi15 > 0 &&
    Math.abs(p5) <= 0.5 &&
    vol < 1.5
  ) {
    return "WAITING";
  }

  // 有量，但方向还没确认
  if (
    oi15 > 0 &&
    vol >= 1.5
  ) {
    return "ACTIVE";
  }

  return "NONE";
}


// ============================================================
// 最终评分
// ============================================================

function finalScore(x) {
  let s = x.discoveryScore || 0;

  const funding = x.fundingRate ?? 0;
  const volume = x.volume15mRatio ?? 1;
  const p1h = x.price1hPct ?? 0;

  // Funding只是加权
  if (funding < 0) {
    s += Math.min(
      Math.abs(funding) * 10000,
      20
    );
  }

  // 量能
  if (volume > 1) {
    s += Math.min(
      (volume - 1) * 8,
      15
    );
  }

  // 5M trigger
  if (x.trigger === "TRIGGERING") s += 15;
  if (x.trigger === "ACTIVE") s += 8;

  // 连续建仓
  if (x.positiveSteps >= 3) s += 5;
  if (x.positiveSteps === 4) s += 5;

  // 已经涨太多，降低早期价值
  if (p1h > 5) s -= 8;
  if (p1h > 8) s -= 15;
  if (p1h > 12) s -= 30;

  // OI撤退重罚
  if (x.signal === "OI_UNWIND") {
    s -= 40;
  }

  return round(s, 1);
}


// ============================================================
// MAIN
// ============================================================

export default async function handler(req, res) {
  const started = Date.now();

  let oiErrors = 0;
  let klineErrors = 0;

  const errorSamples = [];

  try {

    // ========================================================
    // ① TICKERS
    // ========================================================

    const tickerResult = await bybit(
      "/v5/market/tickers",
      {
        category: "linear",
      }
    );

    const tickers = tickerResult.list || [];


    // ========================================================
    // ② INSTRUMENTS
    // ========================================================

    let instruments = [];
    let cursor = "";

    do {
      const params = {
        category: "linear",
        limit: "1000",
      };

      if (cursor) {
        params.cursor = cursor;
      }

      const result = await bybit(
        "/v5/market/instruments-info",
        params
      );

      instruments.push(...(result.list || []));

      cursor = result.nextPageCursor || "";

    } while (cursor);


    // ========================================================
    // ③ 只保留 Bybit USDT Linear Perpetual
    // ========================================================

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


    const universe = tickers
      .filter((x) => allowed.has(x.symbol))
      .map((x) => ({
        symbol: x.symbol,

        price: num(x.lastPrice),

        price24hPct:
          num(x.price24hPcnt) !== null
            ? num(x.price24hPcnt) * 100
            : null,

        turnover24h:
          num(x.turnover24h),

        fundingRate:
          num(x.fundingRate),

        tickerSingleOI:
          num(x.singleOpenInterest),
      }))
      .filter(
        (x) =>
          x.price !== null &&
          x.turnover24h !== null &&
          x.turnover24h >= 500000
      );


    // ========================================================
    // ④ DISCOVERY
    //
    // 全市场查 OI
    //
    // 这里不看 Funding 排名。
    // ========================================================

    const oiRows = [];

    for (let i = 0; i < universe.length; i += 15) {

      const batch = universe.slice(i, i + 15);

      const data = await Promise.all(
        batch.map(async (ticker) => {

          try {

            const result = await bybit(
              "/v5/market/open-interest",
              {
                category: "linear",
                symbol: ticker.symbol,
                intervalTime: "15min",
                limit: "8",
              }
            );

            const oi = parseOI(result.list || []);

            if (!oi) return null;

            const row = {
              ...ticker,

              singleOpenInterest:
                oi.current,

              oi15mPct:
                oi.oi15mPct,

              oi30mPct:
                oi.oi30mPct,

              oi1hPct:
                oi.oi1hPct,

              oi15mSteps:
                oi.steps,

              positiveSteps:
                oi.positiveSteps,

              negativeSteps:
                oi.negativeSteps,
            };

            row.discoveryScore =
              discoveryScore(row);

            return row;

          } catch (e) {

            oiErrors++;

            if (errorSamples.length < 10) {
              errorSamples.push({
                stage: "OI",
                symbol: ticker.symbol,
                error: e.message,
              });
            }

            return null;
          }
        })
      );

      oiRows.push(...data.filter(Boolean));

      await sleep(80);
    }


    // ========================================================
    // ⑤ OI 异常发现
    //
    // 不机械要求1H >= 5%
    // ========================================================

    const oiCandidates = oiRows
      .filter((x) => {

        const oi15 = x.oi15mPct ?? 0;
        const oi30 = x.oi30mPct ?? 0;
        const oi1h = x.oi1hPct ?? 0;

        const funding = x.fundingRate ?? 0;

        // 明显 OI 异常
        if (oi1h >= 2) return true;

        if (oi30 >= 1) return true;

        if (oi15 >= 0.5) return true;

        // 连续小幅建仓
        if (
          x.positiveSteps >= 3 &&
          oi1h > 0.5
        ) {
          return true;
        }

        // 极端负 Funding + OI 正增长
        if (
          funding <= -0.001 &&
          oi15 > 0
        ) {
          return true;
        }

        return false;
      })
      .sort(
        (a, b) =>
          (b.discoveryScore || 0) -
          (a.discoveryScore || 0)
      );


    // ========================================================
    // ⑥ KLINE 深度确认
    //
    // 最多检查 OI 异常最高的80个
    // ========================================================

    const deepList =
      oiCandidates.slice(0, 80);

    const finalRows = [];


    for (let i = 0; i < deepList.length; i += 10) {

      const batch = deepList.slice(i, i + 10);

      const data = await Promise.all(
        batch.map(async (row) => {

          try {

            const result = await bybit(
              "/v5/market/kline",
              {
                category: "linear",
                symbol: row.symbol,
                interval: "5",
                limit: "20",
              }
            );

            const k =
              parseKline(result.list || []);

            if (!k) return null;

            const x = {
              ...row,

              price5mPct:
                k.price5mPct,

              price15mPct:
                k.price15mPct,

              price1hPct:
                k.price1hPct,

              volume15mRatio:
                k.volume15mRatio,

              fundingPct:
                row.fundingRate !== null
                  ? round(row.fundingRate * 100, 4)
                  : null,

              price24hPct:
                round(row.price24hPct, 2),
            };


            x.signal =
              classify(x);


            x.trigger =
              triggerState(x);


            x.score =
              finalScore(x);


            return x;

          } catch (e) {

            klineErrors++;

            if (errorSamples.length < 10) {
              errorSamples.push({
                stage: "KLINE",
                symbol: row.symbol,
                error: e.message,
              });
            }

            return null;
          }
        })
      );

      finalRows.push(...data.filter(Boolean));

      await sleep(80);
    }


    // ========================================================
    // ⑦ 排除明显无效状态
    //
    // 但 diagnostics 仍然保留统计
    // ========================================================

    const actionable = finalRows
      .filter(
        (x) =>
          x.signal &&
          x.signal !== "OVEREXTENDED" &&
          x.signal !== "OI_UNWIND"
      )
      .sort(
        (a, b) =>
          (b.score || 0) -
          (a.score || 0)
      );


    const unwind = finalRows
      .filter(
        (x) =>
          x.signal === "OI_UNWIND"
      )
      .sort(
        (a, b) =>
          (b.discoveryScore || 0) -
          (a.discoveryScore || 0)
      );


    // ========================================================
    // ⑧ OUTPUT
    // ========================================================

    return res.status(200).json({

      status: "ok",

      version: "OI-RADAR-V2",

      source:
        "Bybit Official API",

      market:
        "Bybit USDT Linear Perpetual",

      oiDefinition:
        "singleOpenInterest",

      scannedAt:
        new Date().toISOString(),

      durationMs:
        Date.now() - started,


      diagnostics: {

        universeCount:
          universe.length,

        oiScannedCount:
          oiRows.length,

        oiCandidateCount:
          oiCandidates.length,

        klineDeepScannedCount:
          deepList.length,

        oiErrors,

        klineErrors,

        errorSamples,
      },


      // ==============================================
      // 最值得看的前20
      // ==============================================

      candidates:
        actionable.slice(0, 20),


      // ==============================================
      // OI正在撤退
      //
      // 用于验证 TUT 这类第一波结束结构
      // ==============================================

      oiUnwind:
        unwind.slice(0, 10),

    });

  } catch (e) {

    return res.status(500).json({

      status: "error",

      version: "OI-RADAR-V2",

      message:
        e.message,

      durationMs:
        Date.now() - started,

      diagnostics: {
        oiErrors,
        klineErrors,
        errorSamples,
      },
    });
  }
}
