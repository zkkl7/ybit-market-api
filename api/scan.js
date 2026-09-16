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
      "User-Agent": "Bybit-OI-Radar/3.1",
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
// OI PARSER — V3.1
//
// Bybit App 当前 OI 口径：
// singleOpenInterest
//
// 新增：
// 15M / 30M / 1H / 2H
// buildQuality
// consecutivePositive
// latestStep
// maxPositiveStep
// spikeRatio
// isOiSpike
// ============================================================

function parseOI(list = []) {
  const rows = [...list]
    .map((item) => ({
      ts: Number(item.timestamp),
      oi: num(item.singleOpenInterest),
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


  // current + 8 * 15M = 2H
  if (rows.length < 9) {
    return null;
  }


  const current =
    rows[0].oi;


  const change = (bars) => {
    if (rows.length <= bars) {
      return null;
    }

    return pct(
      current,
      rows[bars].oi
    );
  };


  // ==========================================================
  // 最近4个15M OI step
  //
  // oldest -> newest
  // ==========================================================

  const steps = [];

  for (let i = 4; i >= 1; i--) {
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


  const validSteps =
    steps.filter(Number.isFinite);


  const positiveSteps =
    validSteps.filter(
      (value) => value > 0
    ).length;


  const negativeSteps =
    validSteps.filter(
      (value) => value < 0
    ).length;


  // ==========================================================
  // LATEST STEP
  // ==========================================================

  const latestStep =
    validSteps.length
      ? validSteps[validSteps.length - 1]
      : null;


  const priorSteps =
    validSteps.slice(0, -1);


  const priorPositiveSteps =
    priorSteps.filter(
      (value) => value > 0
    ).length;


  // ==========================================================
  // CONSECUTIVE POSITIVE
  //
  // 从最新15M向前数连续正增长
  // ==========================================================

  let consecutivePositive = 0;

  for (
    let i = validSteps.length - 1;
    i >= 0;
    i--
  ) {
    if (validSteps[i] > 0) {
      consecutivePositive++;
    } else {
      break;
    }
  }


  // ==========================================================
  // CONSECUTIVE NEGATIVE
  // ==========================================================

  let consecutiveNegative = 0;

  for (
    let i = validSteps.length - 1;
    i >= 0;
    i--
  ) {
    if (validSteps[i] < 0) {
      consecutiveNegative++;
    } else {
      break;
    }
  }


  // ==========================================================
  // MAX POSITIVE STEP
  // ==========================================================

  const positiveValues =
    validSteps.filter(
      (value) => value > 0
    );


  const maxPositiveStep =
    positiveValues.length
      ? Math.max(...positiveValues)
      : 0;


  // ==========================================================
  // BUILD QUALITY
  //
  // 0 - 100
  //
  // 奖励 OI 连续性，
  // 而不是单纯奖励单根幅度。
  // ==========================================================

  let buildQuality = 0;


  buildQuality +=
    positiveSteps * 15;


  buildQuality +=
    consecutivePositive * 10;


  if (priorPositiveSteps >= 2) {
    buildQuality += 10;
  }


  if (positiveSteps === 4) {
    buildQuality += 10;
  }


  buildQuality =
    Math.min(
      buildQuality,
      100
    );


  // ==========================================================
  // OI SPIKE
  //
  // 典型：
  //
  // -0.48
  // -0.30
  // -0.02
  // +19.26
  //
  // 最新一根贡献绝大部分1H OI增长，
  // 前面没有连续建仓。
  // ==========================================================

  const oi1h =
    change(4);


  let spikeRatio = null;

  let isOiSpike = false;


  if (
    latestStep !== null &&
    latestStep >= 3 &&
    oi1h !== null &&
    oi1h > 0
  ) {

    spikeRatio =
      latestStep /
      oi1h;


    if (
      spikeRatio >= 0.75 &&
      priorPositiveSteps <= 1
    ) {
      isOiSpike = true;
    }
  }


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


    oi2hPct:
      round(
        change(8),
        2
      ),


    steps,


    positiveSteps,

    negativeSteps,

    priorPositiveSteps,

    consecutivePositive,

    consecutiveNegative,

    latestStep:
      round(
        latestStep,
        2
      ),

    maxPositiveStep:
      round(
        maxPositiveStep,
        2
      ),

    buildQuality,

    spikeRatio:
      spikeRatio !== null
        ? round(
            spikeRatio,
            2
          )
        : null,

    isOiSpike,
  };
}


// ============================================================
// KLINE PARSER
// ============================================================

function parseKline(list = []) {
  const rows = [...list]
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


  if (rows.length < 13) {
    return null;
  }


  const current =
    rows[0].close;


  const change = (bars) => {
    if (rows.length <= bars) {
      return null;
    }

    return pct(
      current,
      rows[bars].open
    );
  };


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
// 只负责第一层 OI 异常发现。
// Funding 不负责决定谁进入。
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


  score +=
    (x.positiveSteps || 0) * 2;


  if (oi15 >= 1) {
    score += 5;
  }


  if (oi15 >= 2) {
    score += 8;
  }


  if (oi15 >= 4) {
    score += 12;
  }


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
// V3.1 STATE MACHINE
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
// 特殊状态：
//
// OI_SPIKE
// COOLING
// OI_WATCH
// ============================================================

function classify(x) {

  const oi15 =
    x.oi15mPct ?? 0;

  const oi30 =
    x.oi30mPct ?? 0;

  const oi1h =
    x.oi1hPct ?? 0;

  const oi2h =
    x.oi2hPct ?? 0;


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


  const consecutiveNegative =
    x.consecutiveNegative ?? 0;


  const buildQuality =
    x.buildQuality ?? 0;


  // ==========================================================
  // 1. EXTENDED
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
  // 2. UNWINDING
  //
  // 必须是真正持续撤仓。
  // ==========================================================

  const hardUnwind =
    oi15 <= -1 &&
    oi30 <= -1;


  const persistentUnwind =
    consecutiveNegative >= 2 &&
    oi15 <= -0.5 &&
    oi30 < 0;


  const fullUnwind =
    oi15 < 0 &&
    oi30 < 0 &&
    oi1h < 0 &&
    negativeSteps >= 2;


  const longUnwind =
    oi30 < 0 &&
    oi1h < 0 &&
    oi2h < 0 &&
    negativeSteps >= 2;


  if (
    hardUnwind ||
    persistentUnwind ||
    fullUnwind ||
    longUnwind
  ) {
    return "UNWINDING";
  }


  // ==========================================================
  // 3. COOLING
  //
  // 中周期仍有明显 OI，
  // 最新15M轻微回吐。
  // ==========================================================

  if (
    oi15 < 0 &&
    oi15 > -1 &&
    (
      oi30 >= 2 ||
      oi1h >= 3 ||
      oi2h >= 5
    )
  ) {
    return "COOLING";
  }


  // ==========================================================
  // 4. OI SPIKE
  //
  // 最新一根突然出现巨大 OI，
  // 但此前没有连续建仓。
  //
  // 不直接视为干净的 ACCUMULATING。
  // ==========================================================

  if (
    x.isOiSpike === true &&
    p1h < 8
  ) {
    return "OI_SPIKE";
  }


  // ==========================================================
  // 5. TRIGGERING
  //
  // 必须：
  //
  // OI建立
  // + 有一定连续性
  // + 价格转强
  // + 成交量确认
  // ==========================================================

  const oiEstablished =
    oi15 >= 0.3 &&
    (
      oi30 >= 1 ||
      oi1h >= 2 ||
      positiveSteps >= 3
    );


  const qualityConfirmed =
    buildQuality >= 40;


  const priceTrigger =
    p5 >= 0.25 &&
    p15 > 0;


  const volumeTrigger =
    volume >= 1.2;


  if (
    oiEstablished &&
    qualityConfirmed &&
    priceTrigger &&
    volumeTrigger &&
    p1h < 8
  ) {
    return "TRIGGERING";
  }


  // ==========================================================
  // 6. SQUEEZE READY
  //
  // 负 Funding
  // + OI持续建立
  // + 价格尚未释放
  // ==========================================================

  const squeezeOI =
    (
      oi15 >= 0.5 ||
      oi30 >= 2 ||
      oi1h >= 3
    ) &&
    positiveSteps >= 2 &&
    buildQuality >= 40;


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
  // 7. ACCUMULATING
  //
  // OI先动，
  // 价格尚未明显释放。
  // ==========================================================

  const sustainedBuild =
    positiveSteps >= 3 &&
    oi1h >= 0.5 &&
    buildQuality >= 50;


  const acceleratedBuild =
    oi15 >= 0.5 &&
    oi30 >= 1 &&
    buildQuality >= 40;


  const strongHourlyBuild =
    oi1h >= 3 &&
    oi15 >= 0 &&
    buildQuality >= 40;


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
  // 8. OI WATCH
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
// TRIGGER STATE
//
// signal = 中周期结构
// trigger = 当前5M是否点火
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


  const buildQuality =
    x.buildQuality ?? 0;


  // ==========================================================
  // SPIKE 不能因为价格刚好上涨
  // 就直接获得 ACTIVE。
  // ==========================================================

  if (
    x.isOiSpike === true
  ) {

    if (
      p5 >= 0.3 &&
      p15 > 0 &&
      volume >= 1.5
    ) {
      return "SPIKE_ACTIVE";
    }

    return "SPIKE_WAIT";
  }


  // ==========================================================
  // ACTIVE
  // ==========================================================

  if (
    oi15 > 0 &&
    buildQuality >= 40 &&
    p5 >= 0.3 &&
    p15 > 0 &&
    volume >= 1.5
  ) {
    return "ACTIVE";
  }


  // ==========================================================
  // EARLY
  // ==========================================================

  if (
    oi15 > 0 &&
    buildQuality >= 40 &&
    p5 > 0.15 &&
    p15 >= 0 &&
    volume >= 1.1
  ) {
    return "EARLY";
  }


  // ==========================================================
  // LOADING
  //
  // OI建立，
  // 价格尚未启动。
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
  // VOLUME ONLY
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
// FINAL SCORE — V3.1
//
// 重点：
//
// 1. OI幅度
// 2. OI连续性
// 3. Funding
// 4. Volume
// 5. Price位置
//
// 单根 OI SPIKE 不再轻易霸榜。
// ============================================================

function finalScore(x) {

  let score = 0;


  const oi15 =
    x.oi15mPct ?? 0;


  const oi30 =
    x.oi30mPct ?? 0;


  const oi1h =
    x.oi1hPct ?? 0;


  const oi2h =
    x.oi2hPct ?? 0;


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


  const buildQuality =
    x.buildQuality ?? 0;


  // ==========================================================
  // OI MAGNITUDE
  //
  // 全部封顶。
  // ==========================================================

  score += Math.min(
    Math.max(oi15, 0) * 3,
    12
  );


  score += Math.min(
    Math.max(oi30, 0) * 1.8,
    14
  );


  score += Math.min(
    Math.max(oi1h, 0) * 2,
    20
  );


  // 2H 只给少量背景分
  score += Math.min(
    Math.max(oi2h, 0) * 0.5,
    8
  );


  // ==========================================================
  // BUILD QUALITY
  //
  // 阶梯建仓成为核心加分项。
  // ==========================================================

  score += Math.min(
    buildQuality * 0.18,
    18
  );


  if (
    x.consecutivePositive >= 3
  ) {
    score += 5;
  }


  if (
    x.consecutivePositive === 4
  ) {
    score += 4;
  }


  // ==========================================================
  // FUNDING
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
    score += 4;
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


  if (
    x.trigger === "SPIKE_ACTIVE"
  ) {
    score += 3;
  }


  // ==========================================================
  // STATE
  // ==========================================================

  if (
    x.signal === "ACCUMULATING"
  ) {
    score += 14;
  }


  if (
    x.signal === "SQUEEZE_READY"
  ) {
    score += 20;
  }


  if (
    x.signal === "TRIGGERING"
  ) {
    score += 22;
  }


  if (
    x.signal === "OI_SPIKE"
  ) {
    score -= 15;
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
  // OI已经动
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


            tickerSingleOI:
              num(
                item.singleOpenInterest
              ),
          })
        )

        .filter(
          (item) =>
            item.price !== null &&
            item.turnover24h !== null &&
            item.turnover24h >=
              500000
        );


    // ========================================================
    // 4. FULL MARKET OI SCAN
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

                      // ======================================
                      // V3.1:
                      //
                      // 需要至少9根才能计算2H。
                      // 拉12根留余量。
                      // ======================================

                      limit:
                        "12",
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


                  singleOpenInterest:
                    oi.current,


                  oi15mPct:
                    oi.oi15mPct,


                  oi30mPct:
                    oi.oi30mPct,


                  oi1hPct:
                    oi.oi1hPct,


                  oi2hPct:
                    oi.oi2hPct,


                  oi15mSteps:
                    oi.steps,


                  positiveSteps:
                    oi.positiveSteps,


                  negativeSteps:
                    oi.negativeSteps,


                  priorPositiveSteps:
                    oi.priorPositiveSteps,


                  consecutivePositive:
                    oi.consecutivePositive,


                  consecutiveNegative:
                    oi.consecutiveNegative,


                  latestOiStep:
                    oi.latestStep,


                  maxPositiveOiStep:
                    oi.maxPositiveStep,


                  buildQuality:
                    oi.buildQuality,


                  spikeRatio:
                    oi.spikeRatio,


                  isOiSpike:
                    oi.isOiSpike,
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
    // 5. OI DISCOVERY
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


            if (
              oi1h >= 2
            ) {
              return true;
            }


            if (
              oi30 >= 1
            ) {
              return true;
            }


            if (
              oi15 >= 0.5
            ) {
              return true;
            }


            if (
              item.positiveSteps >=
                3 &&
              oi1h > 0.5
            ) {
              return true;
            }


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


                  volume15mRatio:
                    kline.volume15mRatio,


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


                item.signal =
                  classify(
                    item
                  );


                item.trigger =
                  triggerState(
                    item
                  );


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
    // 8. OI SPIKES
    // ========================================================

    const spikes =
      finalRows

        .filter(
          (item) =>
            item.signal ===
              "OI_SPIKE"
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
    // 9. COOLING
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
    // 10. UNWINDING
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
    // 11. EXTENDED
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
    // OUTPUT
    // ========================================================

    return res
      .status(200)
      .json({

        status:
          "ok",


        version:
          "OI-RADAR-V3.1",


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


          spikeCount:
            spikes.length,


          coolingCount:
            cooling.length,


          unwindCount:
            unwind.length,


          extendedCount:
            extended.length,


          oiErrors,


          klineErrors,


          errorSamples,
        },


        // ====================================================
        // 主要候选
        // ====================================================

        candidates:
          actionable.slice(
            0,
            20
          ),


        // ====================================================
        // 单根 OI 异常爆发
        // ====================================================

        oiSpikes:
          spikes.slice(
            0,
            10
          ),


        // ====================================================
        // 建仓后冷却
        // ====================================================

        cooling:
          cooling.slice(
            0,
            10
          ),


        // ====================================================
        // 持续撤仓
        // ====================================================

        oiUnwind:
          unwind.slice(
            0,
            10
          ),


        // ====================================================
        // 已经明显释放
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
          "OI-RADAR-V3.1",


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
