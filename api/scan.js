const BASE = "https://api.bybit.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function bybit(path, params = {}) {
  const qs = new URLSearchParams(params);
  const url = `${BASE}${path}?${qs.toString()}`;

  const r = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Bybit-Market-Scanner/1.0",
    },
  });

  const text = await r.text();

  if (!r.ok) {
    throw new Error(
      `Bybit HTTP ${r.status}: ${text.slice(0, 200)}`
    );
  }

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `Bybit returned non-JSON: ${text.slice(0, 200)}`
    );
  }

  if (data.retCode !== 0) {
    throw new Error(
      `Bybit retCode ${data.retCode}: ${data.retMsg}`
    );
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

  if (
    now === null ||
    old === null ||
    old === 0
  ) {
    return null;
  }

  return ((now / old) - 1) * 100;
}

function round(v, d = 2) {
  if (
    v === null ||
    !Number.isFinite(v)
  ) {
    return null;
  }

  return Number(v.toFixed(d));
}

function avg(arr) {
  const valid = arr.filter(
    (x) => Number.isFinite(x)
  );

  if (!valid.length) return null;

  return (
    valid.reduce((a, b) => a + b, 0) /
    valid.length
  );
}


// ============================================================
// OI 分析
// ============================================================

function oiMetrics(list = []) {
  if (!list.length) return {};

  // Bybit 数据可能 newest -> oldest
  // 这里强制按时间倒序
  const rows = [...list]
    .map((x) => ({
      ts: Number(x.timestamp),

      // 关键：
      // 永远只使用 Bybit 单边 OI
      oi: num(x.singleOpenInterest),
    }))
    .filter(
      (x) =>
        Number.isFinite(x.ts) &&
        x.oi !== null
    )
    .sort((a, b) => b.ts - a.ts);

  if (rows.length < 2) {
    return {};
  }

  const current = rows[0].oi;

  const change = (bars) => {
    if (rows.length <= bars) {
      return null;
    }

    return pct(
      current,
      rows[bars].oi
    );
  };


  // 最近四个 15M OI 独立变化
  //
  // 返回格式：
  //
  // oldest -> newest
  //
  // 例如：
  // [0.3, 0.5, 0.8, 1.2]
  //
  // 代表 OI 连续加速建立

  const steps = [];

  for (
    let i = Math.min(
      4,
      rows.length - 1
    );
    i >= 1;
    i--
  ) {
    const older = rows[i].oi;
    const newer = rows[i - 1].oi;

    steps.push(
      round(
        pct(newer, older),
        2
      )
    );
  }

  return {
    singleOpenInterest:
      current,

    oi15mPct:
      round(change(1), 2),

    oi30mPct:
      round(change(2), 2),

    oi1hPct:
      round(change(4), 2),

    oi15mSteps:
      steps,
  };
}


// ============================================================
// K线 / 成交量分析
// ============================================================

function klineMetrics(list = []) {
  if (!list.length) {
    return {};
  }

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
    .filter(
      (x) =>
        Number.isFinite(x.ts) &&
        x.close !== null
    )
    .sort(
      (a, b) => b.ts - a.ts
    );

  if (!rows.length) {
    return {};
  }

  const current =
    rows[0].close;


  const priceChange = (bars) => {
    if (rows.length <= bars) {
      return null;
    }

    return pct(
      current,
      rows[bars].open
    );
  };


  // 最近 15M 平均成交量
  const recentVol =
    rows
      .slice(0, 3)
      .map((x) => x.volume)
      .filter(Number.isFinite);


  // 前面约 1 小时作为基准
  const baselineVol =
    rows
      .slice(3, 15)
      .map((x) => x.volume)
      .filter(Number.isFinite);


  const recentAvg =
    avg(recentVol);

  const baselineAvg =
    avg(baselineVol);


  let volumeRatio = null;

  if (
    recentAvg !== null &&
    baselineAvg !== null &&
    baselineAvg > 0
  ) {
    volumeRatio =
      recentAvg /
      baselineAvg;
  }


  return {
    price5mPct:
      round(
        priceChange(1),
        2
      ),

    price15mPct:
      round(
        priceChange(3),
        2
      ),

    price1hPct:
      round(
        priceChange(12),
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
// 信号分类
// ============================================================

function classify(x) {
  const oi1h =
    x.oi1hPct ?? -999;

  const oi15 =
    x.oi15mPct ?? -999;

  const p1h =
    x.price1hPct ?? 999;

  const funding =
    x.fundingRate ?? 0;

  const vol =
    x.volume15mRatio ?? 0;


  const steps =
    (x.oi15mSteps || [])
      .filter(
        (v) =>
          Number.isFinite(v)
      );


  const positiveSteps =
    steps.filter(
      (v) => v > 0
    ).length;


  // ----------------------------------------------------------
  // STRONG
  //
  // OI 已明显建立
  // 价格尚未严重爆发
  // 成交量开始放大
  // ----------------------------------------------------------

  if (
    oi1h >= 5 &&
    p1h > -3 &&
    p1h <= 8 &&
    vol >= 1.3
  ) {
    return "STRONG";
  }


  // ----------------------------------------------------------
  // PRE_WATCH
  //
  // 1H OI 还没达到 +5%
  // 但 15M 出现持续建立
  // ----------------------------------------------------------

  if (
    oi15 >= 0.7 &&
    positiveSteps >= 3 &&
    p1h > -4 &&
    p1h <= 6
  ) {
    return "PRE_WATCH";
  }


  // ----------------------------------------------------------
  // SQUEEZE_WATCH
  //
  // Funding 明显负值
  // 同时 OI 正在增加
  // ----------------------------------------------------------

  if (
    funding <= -0.001 &&
    oi15 > 0 &&
    p1h <= 8
  ) {
    return "SQUEEZE_WATCH";
  }


  return null;
}


// ============================================================
// 排名分数
// ============================================================

function score(x) {
  let s = 0;

  const oi1h =
    x.oi1hPct ?? 0;

  const oi15 =
    x.oi15mPct ?? 0;

  const funding =
    x.fundingRate ?? 0;

  const vol =
    x.volume15mRatio ?? 1;

  const p1h =
    x.price1hPct ?? 0;


  // OI 是核心
  s +=
    Math.max(
      0,
      Math.min(
        oi1h,
        15
      )
    ) * 3;


  s +=
    Math.max(
      0,
      Math.min(
        oi15,
        6
      )
    ) * 4;


  // 负 Funding 加分
  if (funding < 0) {
    s += Math.min(
      Math.abs(funding) *
        10000,
      20
    );
  }


  // 成交量启动
  if (vol > 1) {
    s += Math.min(
      (vol - 1) * 8,
      15
    );
  }


  // 已经明显拉升则降分
  if (p1h > 8) {
    s -= 20;
  }

  if (p1h > 15) {
    s -= 30;
  }


  return round(
    s,
    1
  );
}


// ============================================================
// 主扫描
// ============================================================

export default async function handler(
  req,
  res
) {
  const started =
    Date.now();

  let requestErrors = 0;

  const errorSamples = [];


  try {

    // ========================================================
    // ① 获取 Bybit 全部 Linear ticker
    // ========================================================

    const tickerResult =
      await bybit(
        "/v5/market/tickers",
        {
          category:
            "linear",
        }
      );


    const tickers =
      tickerResult.list || [];


    // ========================================================
    // ② 获取全部合约资料
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
    // ③ 建立 USDT 永续白名单
    // ========================================================

    const allowed =
      new Set(
        instruments

          .filter(
            (x) =>
              x.status ===
                "Trading" &&

              x.contractType ===
                "LinearPerpetual" &&

              x.quoteCoin ===
                "USDT"
          )

          .map(
            (x) =>
              x.symbol
          )
      );


    // ========================================================
    // ④ 第一层：
    // Ticker 廉价过滤
    // ========================================================

    const universe =
      tickers

        .filter(
          (x) =>
            allowed.has(
              x.symbol
            )
        )

        .map(
          (x) => {

            const last =
              num(
                x.lastPrice
              );


            const prev =
              num(
                x.prevPrice1h
              );


            return {
              symbol:
                x.symbol,

              price:
                last,


              price1hTickerPct:
                pct(
                  last,
                  prev
                ),


              price24hPct:
                num(
                  x.price24hPcnt
                ) !== null

                  ? num(
                      x.price24hPcnt
                    ) * 100

                  : null,


              turnover24h:
                num(
                  x.turnover24h
                ),


              volume24h:
                num(
                  x.volume24h
                ),


              fundingRate:
                num(
                  x.fundingRate
                ),


              // ==============================================
              // 关键：
              // 只采用 Bybit 单边 OI
              // ==============================================

              singleOpenInterest:
                num(
                  x.singleOpenInterest
                ),
            };
          }
        )


        .filter(
          (x) => {

            if (
              x.price === null
            ) {
              return false;
            }


            // 已经爆拉的币先排除
            if (
              x.price1hTickerPct !== null &&
              x.price1hTickerPct > 12
            ) {
              return false;
            }


            // 排除极低流动性
            if (
              x.turnover24h !== null &&
              x.turnover24h <
                500000
            ) {
              return false;
            }


            return true;
          }
        );


    // ========================================================
    // ⑤ 排序初筛
    //
    // Funding异常
    // +
    // 价格开始波动
    // +
    // 成交额
    //
    // 只是决定谁先进入深扫
    // 不代表交易方向
    // ========================================================

    universe.sort(
      (a, b) => {

        const fa =
          a.fundingRate < 0

            ? Math.abs(
                a.fundingRate
              ) * 100000

            : 0;


        const fb =
          b.fundingRate < 0

            ? Math.abs(
                b.fundingRate
              ) * 100000

            : 0;


        const pa =
          Math.abs(
            a.price1hTickerPct ||
              0
          );


        const pb =
          Math.abs(
            b.price1hTickerPct ||
              0
          );


        return (
          fb +
          pb -
          fa -
          pa
        );
      }
    );


    // ========================================================
    // V2 测试：
    //
    // 从 60 提高到 150
    // ========================================================

    const shortlist =
      universe.slice(
        0,
        150
      );


    const results = [];


    // ========================================================
    // ⑥ 深度扫描
    //
    // 每批 10 个币
    //
    // 每个币：
    // 1次 OI
    // 1次 Kline
    // ========================================================

    for (
      let i = 0;
      i < shortlist.length;
      i += 10
    ) {

      const batch =
        shortlist.slice(
          i,
          i + 10
        );


      const data =
        await Promise.all(

          batch.map(
            async (
              ticker
            ) => {

              try {

                const [
                  oi,
                  kline,
                ] =
                  await Promise.all([


                    // ========================================
                    // 15M OI
                    // ========================================

                    bybit(
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
                    ),


                    // ========================================
                    // 5M K线
                    // ========================================

                    bybit(
                      "/v5/market/kline",
                      {
                        category:
                          "linear",

                        symbol:
                          ticker.symbol,

                        interval:
                          "5",

                        limit:
                          "20",
                      }
                    ),

                  ]);


                const oiData =
                  oiMetrics(
                    oi.list ||
                      []
                  );


                const kData =
                  klineMetrics(
                    kline.list ||
                      []
                  );


                const row = {

                  symbol:
                    ticker.symbol,


                  price:
                    ticker.price,


                  // ========================================
                  // PRICE
                  // ========================================

                  price5mPct:
                    kData.price5mPct,


                  price15mPct:
                    kData.price15mPct,


                  price1hPct:
                    kData.price1hPct,


                  price24hPct:
                    round(
                      ticker.price24hPct,
                      2
                    ),


                  // ========================================
                  // OI
                  // ========================================

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


                  // ========================================
                  // FUNDING
                  // ========================================

                  fundingRate:
                    ticker.fundingRate,


                  fundingPct:
                    ticker.fundingRate !==
                    null

                      ? round(
                          ticker.fundingRate *
                            100,
                          4
                        )

                      : null,


                  // ========================================
                  // VOLUME
                  // ========================================

                  volume15mRatio:
                    kData.volume15mRatio,


                  turnover24h:
                    ticker.turnover24h,
                };


                // ==========================================
                // 分类
                // ==========================================

                row.signal =
                  classify(row);


                if (
                  !row.signal
                ) {
                  return null;
                }


                // ==========================================
                // 评分
                // ==========================================

                row.score =
                  score(row);


                return row;

              } catch (e) {

                requestErrors++;


                if (
                  errorSamples.length <
                  10
                ) {
                  errorSamples.push({
                    symbol:
                      ticker.symbol,

                    error:
                      e.message,
                  });
                }


                return null;
              }
            }
          )
        );


      results.push(
        ...data.filter(
          Boolean
        )
      );


      // 每批之间稍微休息
      await sleep(100);
    }


    // ========================================================
    // ⑦ 排名
    // ========================================================

    results.sort(
      (a, b) =>
        (b.score || 0) -
        (a.score || 0)
    );


    // ========================================================
    // ⑧ 输出
    // ========================================================

    return res
      .status(200)
      .json({

        status:
          "ok",


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


        // Bybit 可扫描市场
        universeCount:
          universe.length,


        // 本轮实际深扫
        deepScannedCount:
          shortlist.length,


        // 请求失败数量
        requestErrors,


        // 如果发生错误
        // 给出最多10个样本
        errorSamples,


        // 符合信号的币
        candidateCount:
          results.length,


        // 最多返回前20
        candidates:
          results.slice(
            0,
            20
          ),
      });


  } catch (e) {

    return res
      .status(500)
      .json({

        status:
          "error",

        message:
          e.message,

        durationMs:
          Date.now() -
          started,

        requestErrors,

        errorSamples,
      });
  }
}
