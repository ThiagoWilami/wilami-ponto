// Devolve o IP público e o navegador de quem está assinando (prova da assinatura eletrônica).
// Não guarda nada: só responde ao próprio visitante.
module.exports = function handler(req, res) {
  const xff = String(req.headers["x-forwarded-for"] || "");
  const ip = (xff.split(",")[0] || req.headers["x-real-ip"] || (req.socket && req.socket.remoteAddress) || "").trim();
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ip, ua: String(req.headers["user-agent"] || "").slice(0, 300), em: new Date().toISOString() });
};
