# Wilami Ponto & RH

Ponto digital, escala e RH para restaurantes. O app é um único `index.html` (React + Tailwind + Firebase/Firestore) publicado na Vercel. A pasta `api/` tem uma função serverless para a assinatura eletrônica.

**Build:** a Vercel roda `npm run build` (`scripts/build.mjs`). Ele gera `dist/index.html` com o JSX já compilado e o CSS do Tailwind estático, então o navegador não precisa mais baixar o Babel nem gerar CSS ao vivo. O `index.html` da raiz continua sendo o código-fonte e também abre direto no navegador, sem build.

## Módulos

- **Operação:** painel, escala por unidade, ponto ao vivo, ajustes de ponto.
- **Pessoas:** colaboradores CLT, freelancers, **prestadores PJ** (não batem ponto) e equipe.
- **Documentos:**
  - **Arquivos & pastas:** uma pasta por pessoa (CLT, freela e PJ), com pastas padrão e pastas personalizadas.
  - **Holerites:** você sobe os PDFs da contabilidade, seja um por colaborador ou um único PDF com todos. O sistema separa as páginas pelo CPF ou pelo nome, você confere e publica no app de cada colaborador.
  - **Dossiê:** além das abas que já existiam, ganhou a aba "Pastas & holerites".
- **App "Meus documentos"** (`#meus-docs`): o colaborador ou PJ entra com CPF/CNPJ + PIN e vê os holerites e contratos liberados. O RH gera o PIN em *Arquivos & pastas → Liberar acesso*.

## Assinatura eletrônica (DocuSign)

Para enviar um PDF para assinatura, abra a pasta da pessoa (por exemplo, *Contrato de prestação de serviço* do PJ) e clique em **Assinar**. O documento vai para a pessoa e para os signatários padrão da empresa (*Configurações → Assinatura eletrônica*). Todos assinam o mesmo envelope. Clique em ↻ para atualizar o status. Quando todos tiverem assinado, a via assinada é salva automaticamente na mesma pasta.

### Configuração (uma vez)

1. No DocuSign (*Admin → Apps and Keys*), crie um app e anote o **Integration Key**, o **User ID** e o **API Account ID**. Em *Authentication*, gere um par de chaves RSA.
2. Na Vercel (*Settings → Environment Variables*), crie estas variáveis:

   | Variável | Valor |
   |---|---|
   | `DOCUSIGN_INTEGRATION_KEY` | Integration Key |
   | `DOCUSIGN_USER_ID` | User ID (GUID) do usuário remetente |
   | `DOCUSIGN_ACCOUNT_ID` | API Account ID (opcional) |
   | `DOCUSIGN_PRIVATE_KEY` | chave privada RSA (PEM) |
   | `DOCUSIGN_ENV` | `demo` para testes ou `production` |
   | `DOCUSIGN_REDIRECT_URI` | opcional; um Redirect URI cadastrado no app (usado no link de consentimento) |

3. Faça um novo deploy e use **Configurações → Testar conexão com o DocuSign**. Na primeira vez, o DocuSign pede o consentimento do app; o link aparece na tela.

Só usuários logados no painel conseguem chamar `/api/docusign`, porque o servidor valida o token do Firebase.

Sem o DocuSign configurado, ainda dá para marcar um documento como "assinado manualmente" e subir a via assinada na pasta.

## Banco de dados (Firestore)

Novas coleções. No cliente principal elas ficam na raiz; nos demais clientes, em `tenants/{id}/...`:

- `arquivos`: metadados de cada arquivo (pasta, dono, holerite, competência, status de assinatura).
- `arquivos_partes`: conteúdo do arquivo em base64, fatiado em partes de ~525 KB. Cada arquivo aceita até 12 MB.
- `acessosColab`: hash SHA-256 do PIN de cada colaborador (o PIN em si não é guardado).

Se as regras do Firestore liberam coleção por coleção, inclua essas três com as mesmas permissões de `atestados`/`ajustes`.

> **Atenção:** o app do colaborador funciona sem login do Firebase, como o quiosque de ponto. Por isso a proteção dos holerites depende do CPF + PIN dentro do app. Para blindar no nível do banco, o próximo passo é criar regras do Firestore que exijam autenticação para ler `arquivos` e `arquivos_partes`, com o colaborador autenticado por Firebase Auth.
