// Aviso por e-mail ao Financeiro quando um PJ envia a nota fiscal pelo app "Meus documentos".
// O conteúdo e os destinatários são lidos do banco no servidor (não vêm de quem chama):
//   - a nota: ajustes/nf_<id>, enviada nos últimos 30 minutos;
//   - os e-mails: wilami/financeiroCfg (Notas fiscais PJ → E-mails do financeiro).
// Com um usuário logado no painel, { teste:true } manda um e-mail de teste.
//
// Variáveis de ambiente (Vercel → Settings → Environment Variables):
//   RESEND_API_KEY    chave da Resend (resend.com) para enviar e-mails
//   EMAIL_REMETENTE   opcional, ex.: "Wilami Ponto <notas@seudominio.com.br>" (domínio verificado na Resend)
const { usuarioDoToken, lerDocFirestore, lerCorpo } = require("./_lib/firebase");

const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const brl = (v) => "R$ " + Number(v || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const MESES = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const comp = (c) => { const m = /^(\d{4})-(\d{2})/.exec(String(c || "")); return m ? MESES[Number(m[2]) - 1] + "/" + m[1] : String(c || ""); };

async function enviar(para, assunto, html) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: process.env.EMAIL_REMETENTE || "Wilami Ponto <onboarding@resend.dev>", to: para, subject: assunto, html }),
  });
  if (!r.ok) { let j = null; try { j = await r.json(); } catch (e) {} throw Object.assign(new Error("Falha ao enviar o e-mail: " + ((j && j.message) || r.status)), { status: 502 }); }
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") return res.status(405).json({ erro: "Use POST." });
    if (!process.env.RESEND_API_KEY) return res.status(501).json({ erro: "Envio de e-mail ainda não configurado (RESEND_API_KEY na Vercel).", configurado: false });
    const b = await lerCorpo(req);
    const tenant = String(b.tenant || "");
    if (tenant && !/^[A-Za-z0-9_-]{1,64}$/.test(tenant)) return res.status(400).json({ erro: "Cliente inválido." });
    const base = tenant ? `tenants/${tenant}/` : "";

    const cfg = await lerDocFirestore(base + "wilami/financeiroCfg");
    const para = String((cfg && cfg.v && cfg.v.emails) || "").split(/[,;\s]+/).map((e) => e.trim().toLowerCase()).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)).slice(0, 10);
    if (!para.length) return res.status(409).json({ erro: "Nenhum e-mail do financeiro configurado." });
    const host = req.headers["x-forwarded-host"] || req.headers.host || "";
    const link = host ? `https://${host}/${tenant ? "?t=" + encodeURIComponent(tenant) : ""}` : "";

    if (b.teste) {
      if (!(await usuarioDoToken(req))) return res.status(401).json({ erro: "Faça login no painel." });
      await enviar(para, "Teste de aviso de notas fiscais — Wilami Ponto",
        `<p>Este é um e-mail de teste. Quando um PJ enviar a nota fiscal, o aviso chegará neste endereço.</p>${link ? `<p><a href="${esc(link)}">Abrir o painel</a></p>` : ""}`);
      return res.status(200).json({ ok: true, para: para.length });
    }

    const id = String(b.notaId || "");
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(id)) return res.status(400).json({ erro: "Nota inválida." });
    const n = await lerDocFirestore(base + "ajustes/nf_" + id);
    if (!n || n._t !== "nota_fiscal" || n._excluido) return res.status(404).json({ erro: "Nota não encontrada." });
    if (!(Date.now() - Number(n.enviadoEm || 0) < 30 * 60 * 1000)) return res.status(409).json({ erro: "Aviso fora do prazo." });

    const conf = n.confere === true ? "✅ Valor confere com o contrato"
      : n.confere === false ? `⚠️ Valor DIFERENTE do contrato (nota ${brl(n.valorNota)} × contrato ${brl(n.valorContrato)})`
      : "ℹ️ Valor não identificado automaticamente — conferir manualmente";
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#1e293b">
      <p>O prestador <b>${esc(n.pjNome)}</b> enviou a nota fiscal de <b>${esc(comp(n.competencia))}</b>.</p>
      <table style="border-collapse:collapse">
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Nº da nota</td><td>${esc(n.numero || "—")}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Valor da nota</td><td>${n.valorNota != null ? brl(n.valorNota) : "—"}</td></tr>
        <tr><td style="padding:4px 12px 4px 0;color:#64748b">Valor do contrato</td><td>${brl(n.valorContrato)}</td></tr>
      </table>
      <p>${esc(conf)}</p>
      ${link ? `<p><a href="${esc(link)}">Abrir o painel</a> → Notas fiscais PJ para ver a nota e anexar o comprovante de pagamento.</p>` : ""}
    </div>`;
    await enviar(para, `Nota fiscal recebida: ${n.pjNome || "PJ"} — ${comp(n.competencia)}`, html);
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(e.status || 500).json({ erro: e.message || "Erro inesperado." });
  }
};
