// Utilitários compartilhados pelas funções serverless (pasta com "_" não vira rota na Vercel).
const crypto = require("crypto");

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "twilami-ponto";
const fromB64url = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

// ---------- Verificação do login do painel (Firebase ID token, RS256) ----------
let certsCache = { at: 0, ttl: 0, certs: null };
async function certsGoogle() {
  if (certsCache.certs && Date.now() - certsCache.at < certsCache.ttl) return certsCache.certs;
  const r = await fetch("https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com");
  const certs = await r.json();
  const m = /max-age=(\d+)/.exec(r.headers.get("cache-control") || "");
  certsCache = { at: Date.now(), ttl: (m ? Number(m[1]) : 3600) * 1000, certs };
  return certs;
}
// Retorna o payload do token se válido; senão null.
async function usuarioDoToken(req) {
  const h = (req.headers && req.headers.authorization) || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  try {
    const header = JSON.parse(fromB64url(partes[0]).toString("utf8"));
    const payload = JSON.parse(fromB64url(partes[1]).toString("utf8"));
    const certs = await certsGoogle();
    const cert = certs[header.kid];
    const valido = header.alg === "RS256" && cert &&
      crypto.createVerify("RSA-SHA256").update(partes[0] + "." + partes[1]).verify(cert, fromB64url(partes[2]));
    const agora = Math.floor(Date.now() / 1000);
    if (!valido || payload.aud !== PROJECT_ID || payload.iss !== "https://securetoken.google.com/" + PROJECT_ID || !payload.sub || payload.exp < agora - 60) return null;
    return payload;
  } catch (e) { return null; }
}
async function verificarUsuario(req) {
  const u = await usuarioDoToken(req);
  if (!u) throw Object.assign(new Error("Faça login no painel para usar este recurso."), { status: 401 });
  return u;
}

// ---------- Leitura pública de um documento do Firestore (REST) ----------
// Usado para validar o convite de cadastro sem credenciais de administrador.
function valorFirestore(v) {
  if (!v || typeof v !== "object") return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return Number(v.doubleValue);
  if ("booleanValue" in v) return v.booleanValue;
  if ("nullValue" in v) return null;
  if ("mapValue" in v) { const o = {}; const f = (v.mapValue && v.mapValue.fields) || {}; for (const k in f) o[k] = valorFirestore(f[k]); return o; }
  if ("arrayValue" in v) return ((v.arrayValue && v.arrayValue.values) || []).map(valorFirestore);
  return null;
}
async function lerDocFirestore(caminho) {
  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${caminho}`;
  const r = await fetch(url);
  if (r.status === 404) return null;
  if (!r.ok) throw Object.assign(new Error("Não foi possível validar o convite."), { status: 502 });
  const j = await r.json();
  const o = {}; const f = j.fields || {}; for (const k in f) o[k] = valorFirestore(f[k]);
  return o;
}

function lerCorpo(req) {
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  return new Promise((res, rej) => {
    let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { res(d ? JSON.parse(d) : {}); } catch (e) { rej(e); } }); req.on("error", rej);
  });
}

module.exports = { PROJECT_ID, usuarioDoToken, verificarUsuario, lerDocFirestore, lerCorpo };
