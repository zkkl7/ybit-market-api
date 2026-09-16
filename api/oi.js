export default async function handler(req, res) {
  try {
    const {
      symbol,
      intervalTime = "15min",
      limit = "20"
    } = req.query;

    if (!symbol) {
      return res.status(400).json({
        error: "symbol is required"
      });
    }

    const params = new URLSearchParams({
      category: "linear",
      symbol: symbol.toUpperCase(),
      intervalTime,
      limit
    });

    const url =
      "https://api.bybit.com/v5/market/open-interest?" +
      params.toString();

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0"
      }
    });

    const raw = await response.text();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", "application/json");

    try {
      const data = JSON.parse(raw);

      return res.status(response.status).json({
        proxyStatus: "ok",
        bybitStatus: response.status,
        data
      });

    } catch {
      return res.status(502).json({
        proxyStatus: "bybit_non_json_response",
        bybitStatus: response.status,
        contentType: response.headers.get("content-type"),
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
