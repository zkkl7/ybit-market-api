const ENDPOINTS = {
  ticker: "/v5/market/tickers",
  funding: "/v5/market/funding/history",
  kline: "/v5/market/kline",
  instruments: "/v5/market/instruments-info"
};

export default async function handler(req, res) {
  try {
    const { endpoint, ...query } = req.query;

    if (!endpoint || !ENDPOINTS[endpoint]) {
      return res.status(400).json({
        error: "invalid endpoint",
        allowed: Object.keys(ENDPOINTS),
        examples: {
          ticker:
            "/api/market?endpoint=ticker&symbol=TUTUSDT",
          funding:
            "/api/market?endpoint=funding&symbol=TUTUSDT&limit=20",
          kline:
            "/api/market?endpoint=kline&symbol=TUTUSDT&interval=5&limit=50",
          instruments:
            "/api/market?endpoint=instruments&limit=1000"
        }
      });
    }

    const params = new URLSearchParams();

    params.set("category", "linear");

    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") {
        params.set(key, value);
      }
    }

    const url =
      "https://api.bybit.com" +
      ENDPOINTS[endpoint] +
      "?" +
      params.toString();

    const response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });

    const raw = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Cache-Control",
      "s-maxage=5, stale-while-revalidate=10"
    );

    try {
      const data = JSON.parse(raw);

      return res.status(response.status).json({
        proxyStatus: "ok",
        bybitStatus: response.status,
        endpoint,
        data
      });
    } catch {
      return res.status(502).json({
        proxyStatus: "bybit_non_json_response",
        bybitStatus: response.status,
        endpoint,
        raw: raw.slice(0, 2000)
      });
    }
  } catch (error) {
    return res.status(500).json({
      proxyStatus: "proxy_error",
      message: error.message
    });
  }
}
