const BASE = "https://api.bybit.com";

const sleep = (ms) =>
  new Promise((resolve) => setTimeout(resolve, ms));


// ============================================================
// BYBIT
// ============================================================

async function bybit(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${BASE}${path}?${qs.toString()}`;

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Bybit-OI-Radar/3.0",
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status}: ${text.slice(0, 160)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Non JSON: ${text.slice(0, 160)}`
    );
  }

  if (data.retCode !== 0) {
    throw new Error(
      `${data.retCode}: ${data.retMsg}`
    );
  }

  return data.result;
}


// ============================================================
// HELPERS
// ============================================================

function num(value) {
  const n = Number(value);

  return Number.isFinite(n)
    ? n
    : null;
}


function pct(now, old) {
  now = num(now);
  old = num(old);

  if (
    now === null ||
    old === null ||
    old === 0
  ) {
    return null;
  }

  return ((now / old) - 1) * 100;
}


function round(value, decimals = 2) {
  if (
    value === null ||
    !Number.isFinite(value)
  ) {
    return null;
  }

  return Number(
    value.toFixed(decimals)
  );
}


function avg(values) {
  const valid =
    values.filter(Number.isFinite);

  if (!valid.length) {
    return null;
  }

  return (
    valid.reduce(
      (sum, value) => sum + value,
      0
    ) / valid.length
  );
}


// ============================================================
// OI PARSER
//
// IMPORTANT:
//
// Bybit App 当前 OI 口径 = singleOpenInterest
//
// 不使用 openInterest。
// ============================================================

function parseOI(list = []) {
  const rows =
    [...list]
      .map((item) => ({
        ts: Number(item.timestamp),

        oi: num(
          item.singleOpenInterest
        ),
      }))

      .filter(
        (item) =>
          Number.isFinite(item.ts) &&
          item.oi !== null
      )

      .sort(
        (a, b) =>
          b.ts - a.ts
      );


  if (rows.length < 5) {
    return null;
  }


  const current =
    rows[0].oi;


  const change = (bars) => {
    if (
      rows.length <= bars
    ) {
      return null;
    }

    return pct(
      current,
      rows[bars].oi
    );
  };


  // ----------------------------------------------------------
  // 最近四个 15M OI step
  //
  // oldest -> newest
  //
  // 例如：
  //
  // [0.2, 0.4, 0.8, 1.3]
  //
  // 表示 OI 连续加速建立。
  // ----------------------------------------------------------

  const steps = [];


  for (
    let i = 4;
    i >= 1;
    i--
  ) {

    steps.push(
      round(
        pct(
          rows[i - 1].oi,
          rows[i].oi
        ),
        2
      )
    );
  }


  const positiveSteps =
    steps.filter(
      (value) =>
        value !== null &&
        value > 0
    ).length;


  const negativeSteps =
    steps.filter(
      (value) =>
        value !== null &&
        value < 0
    ).length;


  return {

    current,

    oi15mPct:
      round(
        change(1),
        2
      ),

    oi30mPct:
      round(
        change(2),
        2
      ),

    oi1hPct:
      round(
        change(4),
        2
      ),

    steps,

    positiveSteps,

    negativeSteps,
  };
}


// ============================================================
// KLINE PARSER
// ============================================================

function parseKline(list = []) {
  const rows =
    [...list]
      .map((item) => ({
        ts: Number(item[0]),
        open: num(item[1]),
        high: num(item[2]),
        low: num(item[3]),
        close: num(item[4]),
        volume: num(item[5]),
        turnover: num(item[6]),
      }))

      .filter(
        (item) =>
          Number.isFinite(item.ts) &&
          item.close !== null
      )

      .sort(
        (a, b) =>
          b.ts - a.ts
      );


  if (
    rows.length < 13
  ) {
    return null;
  }


  const current =
    rows[0].close;


  const change = (bars) => {
    if (
      rows.length <= bars
    ) {
      return null;
    }

    return pct(
      current,
      rows[bars].open
    );
  };


  // 最近 15M 平均成交量
  const recentVolume =
    rows
      .slice(0, 3)
      .map(
        (item) =>
          item.volume
      )
      .filter(
        Number.isFinite
      );


  // 前约 1H 作为基准
  const baselineVolume =
    rows
      .slice(3, 15)
      .map(
        (item) =>
          item.volume
      )
      .filter(
        Number.isFinite
      );


  const recentAverage =
    avg(recentVolume);


  const baselineAverage =
    avg(baselineVolume);


  let volumeRatio = null;


  if (
    recentAverage !== null &&
    baselineAverage !== null &&
    baselineAverage > 0
  ) {

    volumeRatio =
      recentAverage /
      baselineAverage;
  }


  return {

    price5mPct:
      round(
        change(1),
        2
      ),

    price15mPct:
      round(
        change(3),
        2
      ),

    price1hPct:
      round(
        change(12),
        2
      ),

    volume15mRatio:
      round(
        volumeRatio,
        2
      ),
  };
}


// ============================================================
// DISCOVERY SCORE
//
// 第一层只负责发现 OI 异常。
//
// Funding 不决定谁能进入扫描。
// ============================================================

function discoveryScore(x) {
  let score = 0;


  const oi15 =
    x.oi15mPct ?? 0;

  const oi30 =
    x.oi30mPct ?? 0;

  const oi1h =
    x.oi1hPct ?? 0;


  score +=
    Math.max(
      oi15,
      0
    ) * 5;


  score +=
    Math.max(
      oi30,
      0
    ) * 3;


  score +=
    Math.max(
      oi1h,
      0
    ) * 4;


  // 连续建仓
  score +=
    (x.positiveSteps || 0) * 2;


  // 最新15M突然加速
  if (oi15 >= 1) {
    score += 5;
  }

  if (oi15 >= 2) {
    score += 8;
  }

  if (oi15 >= 4) {
    score += 12;
  }


  // 1H OI异常
  if (oi1h >= 3) {
    score += 8;
  }

  if (oi1h >= 5) {
    score += 12;
  }

  if (oi1h >= 8) {
    score += 18;
  }


  return round(
    score,
    2
  );
}


// ============================================================
// V3 STATE MACHINE
//
// 生命周期：
//
// ACCUMULATING
//      ↓
// SQUEEZE_READY
//      ↓
// TRIGGERING
//      ↓
// EXTENDED
//      ↓
// UNWINDING
//
// 另外：
//
// COOLING
// OI_WATCH
//
// 用于处理中间状态。
// ============================================================

function classify(x) {

  const oi15 =
    x.oi15mPct ?? 0;

  const oi30 =
    x.oi30mPct ?? 0;

  const oi1h =
    x.oi1hPct ?? 0;


  const p5 =
    x.price5mPct ?? 0;

  const p15 =
    x.price15mPct ?? 0;

  const p1h =
    x.price1hPct ?? 0;


  const volume =
    x.volume15mRatio ?? 0;


  const funding =
    x.fundingRate ?? 0;


  const positiveSteps =
    x.positiveSteps ?? 0;


  const negativeSteps =
    x.negativeSteps ?? 0;


  // ==========================================================
  // EXTENDED
  //
  // 已经明显释放。
  //
  // 我们找的是早期，
  // 所以这种状态不再作为主要候选。
  // ==========================================================

  if (
    p1h >= 12 ||
    (
      p1h >= 8 &&
      p15 >= 3
    )
  ) {

    return "EXTENDED";
  }


  // ==========================================================
  // UNWINDING
  //
  // 真正持续撤仓。
  //
  // 不能因为一根 -0.1% / -0.2%
  // 就直接判定撤仓。
  // ==========================================================

  const hardUnwind =
    oi15 <= -1.0 &&
    oi30 <= -1.0;


  const persistentUnwind =
    negativeSteps >= 3 &&
    oi15 <= -0.5 &&
    oi30 < 0;


  const fullUnwind =
    oi15 < 0 &&
    oi30 < 0 &&
    oi1h < 0 &&
    negativeSteps >= 2;


  if (
    hardUnwind ||
    persistentUnwind ||
    fullUnwind
  ) {

    return "UNWINDING";
  }


  // ==========================================================
  // COOLING
  //
  // 中周期 OI 仍然很强，
  // 但最新15M轻微回吐。
  //
  // 例如：
  //
  // 15M -0.18%
  // 30M +12%
  // 1H  +12%
  //
  // 这种不能判 UNWINDING。
  // ==========================================================

  if (
    oi15 < 0 &&
    oi15 > -1.0 &&
    (
      oi30 >= 2 ||
      oi1h >= 3
    )
  ) {

    return "COOLING";
  }


  // ==========================================================
  // TRIGGERING
  //
  // OI 已经建立
  // +
  // 价格开始动
  // +
  // 成交量开始放大
  //
  // Funding 不作为必要条件。
  // ==========================================================

  const oiEstablished =
    oi15 >= 0.3 &&
    (
      oi30 >= 1 ||
      oi1h >= 2 ||
      positiveSteps >= 3
    );


  const priceTrigger =
    p5 >= 0.25 &&
    p15 > 0;


  const volumeTrigger =
    volume >= 1.2;


  if (
    oiEstablished &&
    priceTrigger &&
    volumeTrigger &&
    p1h < 8
  ) {

    return "TRIGGERING";
  }


  // ==========================================================
  // SQUEEZE_READY
  //
  // OI 已经建立
  // +
  // Funding 明显负
  // +
  // 价格尚未释放
  //
  // 这是我们非常关注的状态。
  // ==========================================================

  const squeezeOI =
    (
      oi15 >= 0.5 ||
      oi30 >= 2 ||
      oi1h >= 3
    ) &&
    positiveSteps >= 2;


  const priceNotReleased =
    p1h > -5 &&
    p1h <= 5;


  if (
    squeezeOI &&
    funding <= -0.0005 &&
    priceNotReleased
  ) {

    return "SQUEEZE_READY";
  }


  // ==========================================================
  // ACCUMULATING
  //
  // OI先动，价格还没明显动。
  //
  // 不机械要求 1H OI >= 5%。
  //
  // 连续15M建仓也可以进入。
  // ==========================================================

  const sustainedBuild =
    positiveSteps >= 3 &&
    oi1h >= 0.5;


  const acceleratedBuild =
    oi15 >= 0.5 &&
    oi30 >= 1;


  const strongHourlyBuild =
    oi1h >= 3 &&
    oi15 >= 0;


  if (
    (
      sustainedBuild ||
      acceleratedBuild ||
      strongHourlyBuild
    ) &&
    p1h > -5 &&
    p1h <= 5
  ) {

    return "ACCUMULATING";
  }


  // ==========================================================
  // OI_WATCH
  //
  // 有异常，
  // 但尚未形成足够完整的启动结构。
  // ==========================================================

  if (
    oi1h >= 2 ||
    oi30 >= 1 ||
    oi15 >= 0.5
  ) {

    return "OI_WATCH";
  }


  return null;
}


// ============================================================
// 5M TRIGGER DETAIL
//
// signal：中周期状态
//
// trigger：当前短周期是否正在点火
// ============================================================

function triggerState(x) {

  const p5 =
    x.price5mPct ?? 0;


  const p15 =
    x.price15mPct ?? 0;


  const oi15 =
    x.oi15mPct ?? 0;


  const oi30 =
    x.oi30mPct ?? 0;


  const volume =
    x.volume15mRatio ?? 0;


  // ==========================================================
  // ACTIVE
  //
  // OI继续增加
  // + 5M价格明显转强
  // + 15M价格为正
  // + 成交量明显放大
  // ==========================================================

  if (
    oi15 > 0 &&
    p5 >= 0.3 &&
    p15 > 0 &&
    volume >= 1.5
  ) {

    return "ACTIVE";
  }


  // ==========================================================
  // EARLY
  //
  // 刚开始点火。
  // ==========================================================

  if (
    oi15 > 0 &&
    p5 > 0.15 &&
    p15 >= 0 &&
    volume >= 1.1
  ) {

    return "EARLY";
  }


  // ==========================================================
  // LOADING
  //
  // OI明显建立，
  // 但价格基本没动。
  //
  // 这是雷达最希望提前发现的状态之一。
  // ==========================================================

  if (
    (
      oi15 >= 0.5 ||
      oi30 >= 1
    ) &&
    Math.abs(p5) <= 0.5 &&
    volume < 1.5
  ) {

    return "LOADING";
  }


  // ==========================================================
  // VOLUME_ONLY
  //
  // 有量，
  // 但价格方向尚未确认。
  // ==========================================================

  if (
    oi15 > 0 &&
    volume >= 1.5
  ) {

    return "VOLUME_ONLY";
  }


  return "NONE";
}


// ============================================================
// FINAL SCORE
//
// Score只负责排序。
//
// State负责解释市场结构。
// ============================================================

function finalScore(x) {

  let score = 0;


  const oi15 =
    x.oi15mPct ?? 0;


  const oi30 =
    x.oi30mPct ?? 0;


  const oi1h =
    x.oi1hPct ?? 0;


  const funding =
    x.fundingRate ?? 0;


  const volume =
    x.volume15mRatio ?? 0;


  const p5 =
    x.price5mPct ?? 0;


  const p15 =
    x.price15mPct ?? 0;


  const p1h =
    x.price1hPct ?? 0;


  // ==========================================================
  // OI
  //
  // 设置上限，
  // 防止某个极端 OI 数值完全统治排行榜。
  // ==========================================================

  score += Math.min(
    Math.max(oi15, 0) * 4,
    15
  );


  score += Math.min(
    Math.max(oi30, 0) * 2,
    15
  );


  score += Math.min(
    Math.max(oi1h, 0) * 2.5,
    25
  );


  // ==========================================================
  // OI 连续性
  // ==========================================================

  if (
    x.positiveSteps >= 3
  ) {
    score += 8;
  }


  if (
    x.positiveSteps === 4
  ) {
    score += 5;
  }


  // ==========================================================
  // FUNDING
  //
  // 只作为增强项。
  // ==========================================================

  if (
    funding <= -0.0005
  ) {
    score += 5;
  }


  if (
    funding <= -0.001
  ) {
    score += 7;
  }


  if (
    funding <= -0.003
  ) {
    score += 5;
  }


  // ==========================================================
  // VOLUME
  // ==========================================================

  if (
    volume >= 1.1
  ) {
    score += 4;
  }


  if (
    volume >= 1.5
  ) {
    score += 6;
  }


  if (
    volume >= 2
  ) {
    score += 5;
  }


  // ==========================================================
  // TRIGGER
  // ==========================================================

  if (
    x.trigger === "EARLY"
  ) {
    score += 8;
  }


  if (
    x.trigger === "ACTIVE"
  ) {
    score += 15;
  }


  if (
    x.trigger === "LOADING"
  ) {
    score += 5;
  }


  // ==========================================================
  // STATE
  // ==========================================================

  if (
    x.signal === "ACCUMULATING"
  ) {
    score += 12;
  }


  if (
    x.signal === "SQUEEZE_READY"
  ) {
    score += 18;
  }


  if (
    x.signal === "TRIGGERING"
  ) {
    score += 22;
  }


  if (
    x.signal === "COOLING"
  ) {
    score -= 8;
  }


  if (
    x.signal === "EXTENDED"
  ) {
    score -= 30;
  }


  if (
    x.signal === "UNWINDING"
  ) {
    score -= 45;
  }


  // ==========================================================
  // EARLY PRICE POSITION
  //
  // 奖励：
  //
  // OI先动
  // 价格还没明显动
  // ==========================================================

  if (
    p1h >= -1 &&
    p1h <= 3
  ) {
    score += 8;
  }


  if (
    p15 >= 0 &&
    p15 <= 1.5
  ) {
    score += 4;
  }


  if (
    p5 > 0 &&
    p5 <= 0.8
  ) {
    score += 3;
  }


  // ==========================================================
  // PRICE ALREADY MOVED
  // ==========================================================

  if (
    p1h > 5
  ) {
    score -= 8;
  }


  if (
    p1h > 8
  ) {
    score -= 15;
  }


  if (
    p1h > 12
  ) {
    score -= 30;
  }


  return round(
    score,
    1
  );
}


// ============================================================
// MAIN
// ============================================================

export default async function handler(
  req,
  res
) {

  const started =
    Date.now();


  let oiErrors = 0;

  let klineErrors = 0;


  const errorSamples = [];


  try {

    // ========================================================
    // 1. TICKERS
    // ========================================================

    const tickerResult =
      await bybit(
        "/v5/market/tickers",
        {
          category: "linear",
        }
      );


    const tickers =
      tickerResult.list || [];


    // ========================================================
    // 2. INSTRUMENTS
    // ========================================================

    let instruments = [];

    let cursor = "";


    do {

      const params = {

        category:
          "linear",

        limit:
          "1000",
      };


      if (cursor) {

        params.cursor =
          cursor;
      }


      const result =
        await bybit(
          "/v5/market/instruments-info",
          params
        );


      instruments.push(
        ...(result.list || [])
      );


      cursor =
        result.nextPageCursor ||
        "";


    } while (cursor);


    // ========================================================
    // 3. BYBIT USDT LINEAR PERPETUAL ONLY
    // ========================================================

    const allowed =
      new Set(

        instruments

          .filter(
            (item) =>
              item.status ===
                "Trading" &&

              item.contractType ===
                "LinearPerpetual" &&

              item.quoteCoin ===
                "USDT"
          )

          .map(
            (item) =>
              item.symbol
          )
      );


    // ========================================================
    // MARKET UNIVERSE
    // ========================================================

    const universe =
      tickers

        .filter(
          (item) =>
            allowed.has(
              item.symbol
            )
        )

        .map(
          (item) => ({

            symbol:
              item.symbol,


            price:
              num(
                item.lastPrice
              ),


            price24hPct:
              num(
                item.price24hPcnt
              ) !== null

                ? num(
                    item.price24hPcnt
                  ) * 100

                : null,


            turnover24h:
              num(
                item.turnover24h
              ),


            fundingRate:
              num(
                item.fundingRate
              ),


            // ================================================
            // 当前 ticker 单边 OI
            // ================================================

            tickerSingleOI:
              num(
                item.singleOpenInterest
              ),
          })
        )


        // ====================================================
        // 流动性过滤
        //
        // 暂时保持 V2 的 500k USDT 24H turnover。
        // ====================================================

        .filter(
          (item) =>
            item.price !== null &&
            item.turnover24h !== null &&
            item.turnover24h >=
              500000
        );


    // ========================================================
    // 4. FULL MARKET OI DISCOVERY
    //
    // 所有 universe 全部查 OI。
    //
    // Funding 不参与决定谁能被发现。
    // ========================================================

    const oiRows = [];


    for (
      let i = 0;
      i < universe.length;
      i += 15
    ) {

      const batch =
        universe.slice(
          i,
          i + 15
        );


      const data =
        await Promise.all(

          batch.map(
            async (ticker) => {

              try {

                const result =
                  await bybit(
                    "/v5/market/open-interest",
                    {

                      category:
                        "linear",

                      symbol:
                        ticker.symbol,

                      intervalTime:
                        "15min",

                      limit:
                        "8",
                    }
                  );


                const oi =
                  parseOI(
                    result.list ||
                      []
                  );


                if (!oi) {
                  return null;
                }


                const row = {

                  ...ticker,


                  // ==========================================
                  // Bybit App calibrated single-sided OI
                  // ==========================================

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
                  discoveryScore(
                    row
                  );


                return row;


              } catch (error) {

                oiErrors++;


                if (
                  errorSamples.length <
                  10
                ) {

                  errorSamples.push({

                    stage:
                      "OI",

                    symbol:
                      ticker.symbol,

                    error:
                      error.message,
                  });
                }


                return null;
              }
            }
          )
        );


      oiRows.push(
        ...data.filter(Boolean)
      );


      await sleep(80);
    }


    // ========================================================
    // 5. OI ANOMALY DISCOVERY
    //
    // 不机械要求 1H >= 5%。
    //
    // 连续15M小幅建立也可以进入。
    // ========================================================

    const oiCandidates =
      oiRows

        .filter(
          (item) => {

            const oi15 =
              item.oi15mPct ??
              0;


            const oi30 =
              item.oi30mPct ??
              0;


            const oi1h =
              item.oi1hPct ??
              0;


            const funding =
              item.fundingRate ??
              0;


            // ================================================
            // 1H OI anomaly
            // ================================================

            if (
              oi1h >= 2
            ) {
              return true;
            }


            // ================================================
            // 30M OI anomaly
            // ================================================

            if (
              oi30 >= 1
            ) {
              return true;
            }


            // ================================================
            // 15M sudden OI build
            // ================================================

            if (
              oi15 >= 0.5
            ) {
              return true;
            }


            // ================================================
            // 连续小幅 OI build
            // ================================================

            if (
              item.positiveSteps >=
                3 &&
              oi1h > 0.5
            ) {
              return true;
            }


            // ================================================
            // 极端负 Funding
            // +
            // OI 正增长
            //
            // Funding只是辅助进入。
            // ================================================

            if (
              funding <=
                -0.001 &&
              oi15 > 0
            ) {
              return true;
            }


            return false;
          }
        )


        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // 6. KLINE DEEP SCAN
    //
    // 最多80个 OI 异常标的。
    // ========================================================

    const deepList =
      oiCandidates.slice(
        0,
        80
      );


    const finalRows = [];


    for (
      let i = 0;
      i < deepList.length;
      i += 10
    ) {

      const batch =
        deepList.slice(
          i,
          i + 10
        );


      const data =
        await Promise.all(

          batch.map(
            async (row) => {

              try {

                const result =
                  await bybit(
                    "/v5/market/kline",
                    {

                      category:
                        "linear",

                      symbol:
                        row.symbol,

                      interval:
                        "5",

                      limit:
                        "20",
                    }
                  );


                const kline =
                  parseKline(
                    result.list ||
                      []
                  );


                if (!kline) {
                  return null;
                }


                const item = {

                  ...row,


                  // ==========================================
                  // PRICE
                  // ==========================================

                  price5mPct:
                    kline.price5mPct,


                  price15mPct:
                    kline.price15mPct,


                  price1hPct:
                    kline.price1hPct,


                  price24hPct:
                    round(
                      row.price24hPct,
                      2
                    ),


                  // ==========================================
                  // VOLUME
                  // ==========================================

                  volume15mRatio:
                    kline.volume15mRatio,


                  // ==========================================
                  // FUNDING
                  // ==========================================

                  fundingPct:
                    row.fundingRate !==
                    null

                      ? round(
                          row.fundingRate *
                            100,
                          4
                        )

                      : null,
                };


                // ============================================
                // V3 STATE
                // ============================================

                item.signal =
                  classify(
                    item
                  );


                // ============================================
                // 5M TRIGGER
                // ============================================

                item.trigger =
                  triggerState(
                    item
                  );


                // ============================================
                // RANKING
                // ============================================

                item.score =
                  finalScore(
                    item
                  );


                return item;


              } catch (error) {

                klineErrors++;


                if (
                  errorSamples.length <
                  10
                ) {

                  errorSamples.push({

                    stage:
                      "KLINE",

                    symbol:
                      row.symbol,

                    error:
                      error.message,
                  });
                }


                return null;
              }
            }
          )
        );


      finalRows.push(
        ...data.filter(Boolean)
      );


      await sleep(80);
    }


    // ========================================================
    // 7. ACTIONABLE
    //
    // EXTENDED / UNWINDING 不进入主要候选。
    //
    // COOLING 暂时保留，
    // 方便我们观察二次蓄仓。
    // ========================================================

    const actionable =
      finalRows

        .filter(
          (item) =>
            item.signal &&
            item.signal !==
              "EXTENDED" &&
            item.signal !==
              "UNWINDING"
        )

        .sort(
          (a, b) =>
            (
              b.score ||
              0
            ) -
            (
              a.score ||
              0
            )
        );


    // ========================================================
    // 8. UNWINDING
    //
    // 专门监控 OI 真正撤退。
    //
    // TUT 第一波结束类型应该更容易出现在这里。
    // ========================================================

    const unwind =
      finalRows

        .filter(
          (item) =>
            item.signal ===
              "UNWINDING"
        )

        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // 9. EXTENDED
    //
    // 已经明显释放的标的单独输出，
    // 防止它们污染早期候选榜。
    // ========================================================

    const extended =
      finalRows

        .filter(
          (item) =>
            item.signal ===
              "EXTENDED"
        )

        .sort(
          (a, b) =>
            (
              b.discoveryScore ||
              0
            ) -
            (
              a.discoveryScore ||
              0
            )
        );


    // ========================================================
    // 10. COOLING
    //
    // 强 OI 建仓后出现轻微回吐。
    //
    // 用于观察是否形成二次蓄仓。
    // ========================================================

    const cooling =
      finalRows

        .filter(
          (item) =>
            item.signal ===
              "COOLING"
        )

        .sort(
          (a, b) =>
            (
              b.score ||
              0
            ) -
            (
              a.score ||
              0
            )
        );


    // ========================================================
    // OUTPUT
    // ========================================================

    return res
      .status(200)
      .json({

        status:
          "ok",


        version:
          "OI-RADAR-V3",


        source:
          "Bybit Official API",


        market:
          "Bybit USDT Linear Perpetual",


        oiDefinition:
          "singleOpenInterest",


        scannedAt:
          new Date().toISOString(),


        durationMs:
          Date.now() -
          started,


        // ====================================================
        // DIAGNOSTICS
        // ====================================================

        diagnostics: {

          universeCount:
            universe.length,


          oiScannedCount:
            oiRows.length,


          oiCandidateCount:
            oiCandidates.length,


          klineDeepScannedCount:
            deepList.length,


          actionableCount:
            actionable.length,


          unwindCount:
            unwind.length,


          extendedCount:
            extended.length,


          coolingCount:
            cooling.length,


          oiErrors,


          klineErrors,


          errorSamples,
        },


        // ====================================================
        // EARLY / ACTIONABLE CANDIDATES
        // ====================================================

        candidates:
          actionable.slice(
            0,
            20
          ),


        // ====================================================
        // OI COOLING
        // ====================================================

        cooling:
          cooling.slice(
            0,
            10
          ),


        // ====================================================
        // OI UNWINDING
        // ====================================================

        oiUnwind:
          unwind.slice(
            0,
            10
          ),


        // ====================================================
        // ALREADY EXTENDED
        // ====================================================

        extended:
          extended.slice(
            0,
            10
          ),
      });


  } catch (error) {

    return res
      .status(500)
      .json({

        status:
          "error",


        version:
          "OI-RADAR-V3",


        message:
          error.message,


        durationMs:
          Date.now() -
          started,


        diagnostics: {

          oiErrors,

          klineErrors,

          errorSamples,
        },
      });
  }
}
