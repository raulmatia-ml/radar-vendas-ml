# Radar de Vendas ML

Dashboard para acompanhar vendas de uma conta do Mercado Livre, executado em Cloudflare Workers.

## Recursos atuais

- autenticação OAuth com o Mercado Livre;
- renovação automática do token de acesso;
- faturamento, pedidos, unidades e ticket médio;
- comparação com o período anterior;
- filtros de 7, 15, 30 dias e período personalizado;
- evolução diária das vendas;
- ranking dos produtos vendidos;
- pedidos recentes e status de envio;
- layout responsivo para computador e celular.

## Rotas

- `/` — dashboard;
- `/connect` — inicia a conexão OAuth;
- `/oauth/callback` — recebe a autorização do Mercado Livre;
- `/status` — verifica o estado da conexão;
- `/api/account` — dados básicos da conta;
- `/api/orders` — pedidos;
- `/api/dashboard` — dados consolidados do painel.

## Configuração

1. Instale as dependências com `npm install`.
2. Copie `wrangler.toml.example` para `wrangler.toml`.
3. Informe no arquivo os IDs do namespace KV usado pelo binding `ML_TOKENS`.
4. Configure `ML_CLIENT_ID` e `ML_REDIRECT_URI` como variáveis do Worker.
5. Cadastre o segredo fora do GitHub:

   ```bash
   npx wrangler secret put ML_CLIENT_SECRET
   ```

6. Confirme que a URL de redirecionamento termina em `/oauth/callback` e é idêntica à cadastrada no Mercado Livre.

## Desenvolvimento

```bash
npm install
npm run check
npm run dev
```

## Publicação

```bash
npm run deploy
```

O código não contém tokens nem credenciais. Os tokens OAuth ficam no KV `ML_TOKENS`, e o segredo do aplicativo deve permanecer nas variáveis protegidas do Cloudflare.
