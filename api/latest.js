export default function handler(req, res) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");

  res.status(200).json({
    status: "ok",
    test: "chatgpt-direct-access",
    updatedAt: new Date().toISOString()
  });
}
