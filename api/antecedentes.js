// R&S: consulta de processos judiciais públicos vinculados ao CPF do candidato (Escavador, API v2).
// Só um usuário logado no painel pode chamar. O candidato autoriza a consulta no link de cadastro.
// Devolve um resumo: processos em que o CPF aparece no polo passivo (réu, investigado, acusado…)
// de natureza criminal, e a contagem dos demais.
//
// Variável de ambiente (Vercel → Settings → Environment Variables):
//   ESCAVADOR_TOKEN   token da API do Escavador (api.escavador.com → API → Tokens)
const { verificarUsuario, lerCorpo } = require("./_lib/firebase");

const CRIMINAL = /criminal|penal|crime|inqu[eé]rito|termo circunstanciado|execu[cç][aã]o d[ae] pena|medidas? protetivas?|contraven[cç]/i;
const POLO_REU = /r[eé]u|investigad|indiciad|acusad|denunciad|autor do fato|querelad|apenad|condenad|sentenciad|flagranteado|custodiad/i;

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
    await verificarUsuario(req);
    if (!process.env.ESCAVADOR_TOKEN) return res.status(501).json({ erro: "Consulta não configurada (ESCAVADOR_TOKEN na Vercel).", configurado: false });
    const b = await lerCorpo(req);
    const cpf = String(b.cpf || "").replace(/\D/g, "");
    if (cpf.length !== 11) return res.status(400).json({ erro: "CPF inválido." });

    const url = "https://api.escavador.com/api/v2/envolvido/processos?cpf_cnpj=" + cpf;
    const r = await fetch(url, { headers: { Authorization: "Bearer " + process.env.ESCAVADOR_TOKEN, "X-Requested-With": "XMLHttpRequest" } });
    let j = null; try { j = await r.json(); } catch (e) {}
    if (r.status === 404) return res.status(200).json({ encontrado: false, total: 0, criminais: [], outros: 0 });
    if (r.status === 401) return res.status(502).json({ erro: "Token do Escavador inválido." });
    if (r.status === 402) return res.status(502).json({ erro: "Sem créditos no Escavador." });
    if (!r.ok) return res.status(502).json({ erro: "Falha na consulta ao Escavador (" + r.status + ")." });

    const itens = (j && j.items) || [];
    const criminais = [];
    for (const p of itens) {
      const fontes = p.fontes || [];
      const capa = (fontes.find((f) => f && f.capa) || {}).capa || {};
      const texto = [capa.area, capa.classe, capa.assunto, ...(capa.assuntos_normalizados || []).map((a) => a && a.nome)].filter(Boolean).join(" ");
      const tipos = fontes.flatMap((f) => (f && f.tipos_envolvido_pesquisado) || []);
      const reu = tipos.some((t) => t && (t.polo === "PASSIVO" || POLO_REU.test(String(t.tipo_normalizado || t.tipo || ""))));
      const vitima = tipos.length > 0 && tipos.every((t) => /v[ií]tima|testemunha|ofendid|advogad/i.test(String(t.tipo_normalizado || t.tipo || "")));
      if (CRIMINAL.test(texto) && reu && !vitima) {
        const f0 = fontes[0] || {};
        criminais.push({
          numero: p.numero_cnj || "", tribunal: (f0.tribunal && f0.tribunal.sigla) || f0.sigla || "", classe: capa.classe || "", assunto: capa.assunto || "",
          tipo: (tipos[0] && (tipos[0].tipo_normalizado || tipos[0].tipo)) || "", inicio: p.data_inicio || (p.ano_inicio ? String(p.ano_inicio) : ""),
          status: f0.status_predito || "",
        });
      }
    }
    const env = (j && j.envolvido_encontrado) || {};
    return res.status(200).json({ encontrado: itens.length > 0, nome: env.nome || "", total: itens.length, criminais: criminais.slice(0, 30), outros: itens.length - criminais.length, maisPaginas: !!(j && j.links && j.links.next) });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message || "Erro inesperado." });
  }
};
