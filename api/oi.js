export default async function handler(req, res) {
  try {
    const {
      symbol,
      intervalTime = "15min",
      limit = "20",
      startTime,
      endTime
    } = req.query;

    if (!symbol) {
      return res.status(400).json({
        error: "symbol is required",
        example: "/api/oi?symbol=TUTUSDT&intervalTime=15min&limit=20"
      });
    }

    const params = new URLSearchParams({
      category: "linear",
      symbol: symbol.toUpperCase(),
      intervalTime,
      limit
    });

    if (startTime) params.set("startTime", startTime);
    if (endTime) params.set("endTime", endTime);

    const url =
      "https://api.bybit.com/v5/market/open-interest?" +
      params.toString();

    const response = await fetch(url, {
      headers: {
        Accept: "application/json"
      }
    });

    const data = await response.json();

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "s-maxage=5, stale-while-revalidate=10");

    return res.status(response.status).json(data);

  } catch (error) {
    return res.status(500).json({
      error: "Failed to fetch Bybit data",
      message: error.message
    });
  }
}
