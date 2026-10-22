// Leitura da nota fiscal enviada pelo PJ (quando o PDF não tem texto, ou é foto) com o Claude.
// Devolve valor dos serviços, valor líquido, número, emissão e os CNPJs do prestador e do tomador,
// para o sistema conferir com o valor do contrato.
//
// Quem pode chamar: o PJ logado no app "Meus documentos" (CNPJ + PIN) ou um usuário logado no painel.
// Variável de ambiente: ANTHROPIC_API_KEY (a mesma da leitura dos documentos do convite).
const sdk = require("@anthropic-ai/sdk");
const { usuarioDoToken, lerCorpo, portalValido } = require("./_lib/firebase");

const Anthropic = sdk.default || sdk;
const MODEL = "claude-opus-5-5";
const TIPOS_MIDIA = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
const MAX_B64 = 4 * 1024 * 1024;

const texto = (d) => ({ type: ["string", "null"], description: d });
const numero = (d) => ({ type: ["number", "null"], description: d });
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ehNotaFiscal", "legivel", "observacao", "valorServicos", "valorLiquido", "numero", "emissao", "competencia", "cnpjPrestador", "cnpjTomador", "razaoPrestador"],
  properties: {
    ehNotaFiscal: { type: "boolean", description: "true se o arquivo é uma nota fiscal de serviço (NFS-e) ou nota fiscal" },
    legivel: { type: "boolean" },
    observacao: texto("Problema encontrado, em uma frase curta em português, ou null"),
    valorServicos: numero("Valor total/bruto dos serviços, em reais (ex.: 5000.00)"),
    valorLiquido: numero("Valor líquido da nota, em reais"),
    numero: texto("Número da nota fiscal"),
    emissao: texto("Data de emissão AAAA-MM-DD"),
    competencia: texto("Competência/mês de referência AAAA-MM, se constar"),
    cnpjPrestador: texto("CNPJ do prestador/emitente no formato 00.000.000/0000-00"),
    cnpjTomador: texto("CNPJ do tomador do serviço no formato 00.000.000/0000-00"),
    razaoPrestador: texto("Razão social do prestador"),
  },
};
const INSTRUCOES = `Você lê notas fiscais de serviço brasileiras (NFS-e) enviadas por prestadores PJ para uma empresa.
Extraia apenas o que está escrito e legível. Para qualquer campo ausente ou ilegível, responda null — nunca deduza nem invente valores.
Valores em reais como número com ponto decimal (R$ 5.000,00 → 5000.00). Datas AAAA-MM-DD. CNPJ como 00.000.000/0000-00.
Se o arquivo não for uma nota fiscal, responda ehNotaFiscal=false e explique em "observacao".`;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(501).json({ erro: "Leitura automática ainda não configurada no servidor (ANTHROPIC_API_KEY na Vercel).", configurado: false });
    }
    const b = await lerCorpo(req);
    const usuario = await usuarioDoToken(req);
    if (!usuario && !(await portalValido(String(b.tenant || ""), b.portal))) {
      return res.status(401).json({ erro: "Entre novamente no app com seu CNPJ e PIN." });
    }
    const mime = String(b.mime || "");
    const dados = String(b.base64 || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!TIPOS_MIDIA.includes(mime)) return res.status(400).json({ erro: "Envie a nota em PDF ou foto." });
    if (!dados || dados.length > MAX_B64) return res.status(413).json({ erro: "Arquivo grande demais para leitura automática (máx. ~3 MB)." });

    const anexo = mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: dados } }
      : { type: "image", source: { type: "base64", media_type: mime, data: dados } };
    const client = new Anthropic();
    const resposta = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: INSTRUCOES,
      messages: [{ role: "user", content: [anexo, { type: "text", text: "Extraia os dados desta nota fiscal." }] }],
    });
    if (resposta.stop_reason === "refusal") return res.status(422).json({ erro: "Não foi possível ler esta nota automaticamente." });
    const t = (resposta.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    let resultado;
    try { resultado = JSON.parse(t); } catch (e) { return res.status(502).json({ erro: "A leitura automática não retornou um resultado válido." }); }
    return res.status(200).json(resultado);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ erro: "Muitas leituras ao mesmo tempo. Tente de novo em instantes." });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ erro: "Falha na leitura automática (" + (e.status || "erro") + ")." });
    return res.status(e.status || 500).json({ erro: e.message || "Erro inesperado." });
  }
};
