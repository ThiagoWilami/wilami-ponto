// Integração DocuSign (função serverless da Vercel) — envia contratos para assinatura,
// consulta o status e baixa a via assinada. As credenciais ficam SÓ no servidor (variáveis de ambiente).
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   DOCUSIGN_INTEGRATION_KEY  Integration Key (client id) do app no DocuSign
//   DOCUSIGN_USER_ID          User ID (GUID) do usuário que envia os envelopes
//   DOCUSIGN_ACCOUNT_ID       API Account ID (opcional; se vazio, usa a conta padrão do usuário)
//   DOCUSIGN_PRIVATE_KEY      Chave privada RSA (PEM). Pode colar com quebras de linha ou com "\n"
//   DOCUSIGN_ENV              "demo" (testes) ou "production"
//   FIREBASE_PROJECT_ID       opcional (padrão: twilami-ponto) — só usuários logados no painel podem chamar
const crypto = require("crypto");
const { verificarUsuario, lerCorpo } = require("./_lib/firebase");

const PROD = String(process.env.DOCUSIGN_ENV || "demo").toLowerCase().startsWith("prod");
const AUTH_HOST = PROD ? "account.docusign.com" : "account-d.docusign.com";

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function configurado() {
  return !!(process.env.DOCUSIGN_INTEGRATION_KEY && process.env.DOCUSIGN_USER_ID && process.env.DOCUSIGN_PRIVATE_KEY);
}
function chavePrivada() {
  return String(process.env.DOCUSIGN_PRIVATE_KEY || "").replace(/\\n/g, "\n").trim();
}
function urlConsentimento() {
  const redirect = process.env.DOCUSIGN_REDIRECT_URI || "https://www.docusign.com";
  return `https://${AUTH_HOST}/oauth/auth?response_type=code&scope=${encodeURIComponent("signature impersonation")}&client_id=${encodeURIComponent(process.env.DOCUSIGN_INTEGRATION_KEY || "")}&redirect_uri=${encodeURIComponent(redirect)}`;
}

// ---------- DocuSign: token via JWT Grant + conta ----------
let tokenCache = { token: null, exp: 0 };
let contaCache = null;
async function tokenDocusign() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 120000) return tokenCache.token;
  const agora = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(JSON.stringify({
    iss: process.env.DOCUSIGN_INTEGRATION_KEY, sub: process.env.DOCUSIGN_USER_ID, aud: AUTH_HOST,
    iat: agora, exp: agora + 3600, scope: "signature impersonation",
  }));
  const assinatura = crypto.createSign("RSA-SHA256").update(header + "." + corpo).sign(chavePrivada());
  const r = await fetch(`https://${AUTH_HOST}/oauth/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: header + "." + corpo + "." + b64url(assinatura) }).toString(),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (j.error === "consent_required") throw Object.assign(new Error("O DocuSign precisa que você autorize o app uma única vez."), { status: 412, consentUrl: urlConsentimento() });
    throw Object.assign(new Error("Falha ao autenticar no DocuSign: " + (j.error_description || j.error || r.status)), { status: 502 });
  }
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tokenCache.token;
}
async function contaDocusign(token) {
  if (contaCache) return contaCache;
  const r = await fetch(`https://${AUTH_HOST}/oauth/userinfo`, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json();
  const contas = j.accounts || [];
  const alvo = process.env.DOCUSIGN_ACCOUNT_ID;
  const c = (alvo && contas.find((a) => a.account_id === alvo)) || contas.find((a) => a.is_default) || contas[0];
  if (!c) throw Object.assign(new Error("Nenhuma conta DocuSign encontrada para este usuário."), { status: 502 });
  contaCache = { id: c.account_id, nome: c.account_name, base: c.base_uri + "/restapi/v2.1/accounts/" + c.account_id };
  return contaCache;
}
async function ds(caminho, opts) {
  const token = await tokenDocusign();
  const conta = await contaDocusign(token);
  const r = await fetch(conta.base + caminho, { ...(opts || {}), headers: { Authorization: "Bearer " + token, Accept: "application/json", ...((opts && opts.headers) || {}) } });
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw Object.assign(new Error("DocuSign: " + (j.message || j.errorCode || r.status)), { status: 502 });
  }
  return r;
}

const emailOk = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(e || "").trim());

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const acao = (req.query && req.query.acao) || new URL(req.url, "http://x").searchParams.get("acao");
  const id = (req.query && req.query.id) || new URL(req.url, "http://x").searchParams.get("id");
  try {
    await verificarUsuario(req);
    if (!configurado()) {
      return res.status(501).json({ erro: "DocuSign ainda não configurado no servidor (variáveis de ambiente na Vercel).", configurado: false });
    }

    if (acao === "status") {
      const token = await tokenDocusign();
      const conta = await contaDocusign(token);
      return res.status(200).json({ configurado: true, ambiente: PROD ? "produção" : "demo (testes)", conta: conta.nome });
    }

    if (acao === "enviar") {
      if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
      const b = await lerCorpo(req);
      const sigs = Array.isArray(b.signatarios) ? b.signatarios : [];
      if (!b.base64 || !sigs.length || sigs.some((s) => !s.nome || !emailOk(s.email))) {
        return res.status(400).json({ erro: "Informe o PDF e ao menos um signatário com nome e e-mail válidos." });
      }
      const envelope = {
        emailSubject: String(b.assunto || "Documento para assinatura").slice(0, 100),
        emailBlurb: String(b.mensagem || "").slice(0, 2000),
        documents: [{ documentBase64: b.base64, name: String(b.nome || "documento.pdf").slice(0, 100), fileExtension: "pdf", documentId: "1" }],
        recipients: {
          signers: sigs.map((s, i) => ({
            email: String(s.email).trim(), name: String(s.nome).trim(), recipientId: String(i + 1), routingOrder: "1",
            tabs: {
              signHereTabs: [{ anchorString: `/assinatura${i + 1}/`, anchorUnits: "pixels", anchorXOffset: "0", anchorYOffset: "-6", anchorIgnoreIfNotPresent: "true" }],
              dateSignedTabs: [{ anchorString: `/assinatura${i + 1}/`, anchorUnits: "pixels", anchorXOffset: "300", anchorYOffset: "0", anchorIgnoreIfNotPresent: "true" }],
            },
          })),
        },
        status: "sent",
      };
      const r = await ds("/envelopes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(envelope) });
      const j = await r.json();
      return res.status(200).json({ envelopeId: j.envelopeId, status: j.status });
    }

    if (acao === "envelope") {
      if (!id) return res.status(400).json({ erro: "Envelope não informado." });
      const e = await (await ds(`/envelopes/${encodeURIComponent(id)}`)).json();
      const rc = await (await ds(`/envelopes/${encodeURIComponent(id)}/recipients`)).json();
      const signatarios = (rc.signers || []).map((s) => ({ nome: s.name, email: s.email, status: s.status, assinadoEm: s.signedDateTime || null }));
      return res.status(200).json({ status: e.status, signatarios, concluidoEm: e.completedDateTime || null });
    }

    if (acao === "documento") {
      if (!id) return res.status(400).json({ erro: "Envelope não informado." });
      const r = await ds(`/envelopes/${encodeURIComponent(id)}/documents/combined`, { headers: { Accept: "application/pdf" } });
      const buf = Buffer.from(await r.arrayBuffer());
      return res.status(200).json({ base64: buf.toString("base64") });
    }

    return res.status(400).json({ erro: "Ação desconhecida." });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message || "Erro inesperado.", consentUrl: e.consentUrl });
  }
};
