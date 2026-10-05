// Leitura automática de documentos (RG, CNH, CPF, CTPS, comprovantes, cartão CNPJ…) com o Claude.
// Recebe UM documento (imagem ou PDF em base64) e devolve os campos encontrados para pré-preencher o cadastro.
//
// Quem pode chamar:
//   - o candidato com um CONVITE válido (link de cadastro gerado no painel), ou
//   - um usuário logado no painel.
//
// Variável de ambiente (Vercel → Settings → Environment Variables):
//   ANTHROPIC_API_KEY   chave da API do Claude (console.anthropic.com)
const sdk = require("@anthropic-ai/sdk");
const { usuarioDoToken, lerDocFirestore, lerCorpo } = require("./_lib/firebase");

const Anthropic = sdk.default || sdk;
const MODEL = "claude-opus-5-5";
const TIPOS_MIDIA = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
const MAX_B64 = 4 * 1024 * 1024; // ~3 MB de arquivo (limite de corpo da Vercel é 4,5 MB)

const TIPOS_DOC = ["rg", "cnh", "cpf", "ctps", "titulo_eleitor", "reservista", "comprovante_residencia", "certidao_nascimento_casamento",
  "pis", "cartao_sus", "diploma", "historico_escolar", "cartao_cnpj", "contrato_social", "ccmei", "comprovante_bancario", "outro"];
const CAMPOS = {
  nome: "Nome completo da pessoa titular do documento",
  cpf: "CPF no formato 000.000.000-00",
  rg: "Número do RG",
  rgOrgao: "Órgão emissor e UF do RG (ex.: SSP/SP)",
  nascimento: "Data de nascimento AAAA-MM-DD",
  sexo: "M ou F, se constar",
  mae: "Nome da mãe (filiação)",
  pai: "Nome do pai (filiação)",
  naturalidade: "Cidade/UF de nascimento",
  cep: "CEP no formato 00000-000",
  logradouro: "Rua/avenida do endereço",
  numero: "Número do endereço",
  complemento: "Complemento do endereço",
  bairro: "Bairro",
  cidade: "Cidade do endereço",
  uf: "UF do endereço (2 letras)",
  pis: "Número do PIS/PASEP/NIS",
  ctpsNumero: "Número da CTPS",
  ctpsSerie: "Série da CTPS",
  tituloEleitor: "Número do título de eleitor",
  tituloZona: "Zona eleitoral",
  tituloSecao: "Seção eleitoral",
  reservista: "Número do certificado de reservista",
  cnhNumero: "Número de registro da CNH",
  cnhCategoria: "Categoria da CNH",
  cnhValidade: "Validade da CNH AAAA-MM-DD",
  razaoSocial: "Razão social da empresa",
  nomeFantasia: "Nome fantasia (título do estabelecimento)",
  cnpj: "CNPJ no formato 00.000.000/0000-00",
  aberturaCnpj: "Data de abertura da empresa AAAA-MM-DD",
  atividade: "Atividade econômica principal (descrição do CNAE)",
  banco: "Nome do banco",
  agencia: "Agência bancária",
  conta: "Número da conta com dígito",
  pix: "Chave Pix, se constar",
  email: "E-mail, se constar",
  telefone: "Telefone, se constar",
};
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["tipoDocumento", "legivel", "observacao", "campos"],
  properties: {
    tipoDocumento: { type: "string", enum: TIPOS_DOC },
    legivel: { type: "boolean" },
    observacao: { type: ["string", "null"] },
    campos: {
      type: "object",
      additionalProperties: false,
      required: Object.keys(CAMPOS),
      properties: Object.fromEntries(Object.entries(CAMPOS).map(([k, d]) => [k, { type: ["string", "null"], description: d }])),
    },
  },
};
const INSTRUCOES = `Você lê documentos brasileiros enviados por um candidato para preencher o cadastro de admissão de uma empresa.
Identifique o tipo do documento e extraia apenas o que está escrito e legível nele. Para qualquer campo que não apareça no documento, ou que você não consiga ler com segurança, responda null — nunca deduza nem invente valores.
Datas sempre no formato AAAA-MM-DD. CPF como 000.000.000-00, CNPJ como 00.000.000/0000-00, CEP como 00000-000. Nomes como aparecem no documento.
Em "legivel", diga se a imagem permite ler o documento. Em "observacao", explique em uma frase curta, em português, qualquer problema (foto cortada, borrada, documento vencido) ou null se estiver tudo certo.`;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(501).json({ erro: "Leitura automática ainda não configurada no servidor (ANTHROPIC_API_KEY na Vercel).", configurado: false });
    }
    const b = await lerCorpo(req);

    // Autorização: usuário logado no painel OU convite válido
    const usuario = await usuarioDoToken(req);
    if (!usuario) {
      const token = String(b.convite || "");
      const tenant = String(b.tenant || "");
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(token) || (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant))) {
        return res.status(401).json({ erro: "Convite inválido." });
      }
      const conv = await lerDocFirestore((tenant ? `tenants/${tenant}/` : "") + `convites/${token}`);
      if (!conv || conv.status !== "aberto" || (conv.expira && Number(conv.expira) < Date.now())) {
        return res.status(403).json({ erro: "Este link de cadastro expirou ou já foi usado. Peça um novo link à empresa." });
      }
    }

    const mime = String(b.mime || "");
    const dados = String(b.base64 || "").replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
    if (!TIPOS_MIDIA.includes(mime)) return res.status(400).json({ erro: "Envie uma imagem (JPG, PNG, WEBP) ou um PDF." });
    if (!dados || dados.length > MAX_B64) return res.status(413).json({ erro: "Arquivo grande demais para leitura automática (máx. ~3 MB)." });

    const anexo = mime === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: dados } }
      : { type: "image", source: { type: "base64", media_type: mime, data: dados } };
    const dica = b.esperado ? `O candidato enviou este arquivo como: ${String(b.esperado).slice(0, 80)}.` : "";

    const client = new Anthropic();
    const resposta = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: { type: "json_schema", schema: SCHEMA } },
      system: INSTRUCOES,
      messages: [{ role: "user", content: [anexo, { type: "text", text: (dica + " Extraia os dados deste documento.").trim() }] }],
    });

    if (resposta.stop_reason === "refusal") {
      return res.status(422).json({ erro: "Não foi possível ler este documento automaticamente. Preencha os dados manualmente." });
    }
    const texto = (resposta.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    let resultado;
    try { resultado = JSON.parse(texto); } catch (e) {
      return res.status(502).json({ erro: "A leitura automática não retornou um resultado válido. Tente novamente." });
    }
    return res.status(200).json(resultado);
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) return res.status(429).json({ erro: "Muitas leituras ao mesmo tempo. Tente de novo em instantes." });
    if (e instanceof Anthropic.AuthenticationError) return res.status(502).json({ erro: "Chave da API do Claude inválida no servidor." });
    if (e instanceof Anthropic.APIError) return res.status(502).json({ erro: "Falha na leitura automática (" + (e.status || "erro") + "). Tente novamente." });
    return res.status(e.status || 500).json({ erro: e.message || "Erro inesperado." });
  }
};
