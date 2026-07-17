# Robustti WhatsApp Seguro

Gerenciador de contatos e fila para a API oficial WhatsApp Cloud API, com Supabase e Cloudflare. Projetado para operar dentro dos planos gratuitos de infraestrutura e impedir cobranças acidentais quando `ZERO_COST_MODE=true`.

## O que está incluído

- Dashboard responsivo com autenticação Supabase.
- Contatos com consentimento obrigatório.
- Fila transacional com `FOR UPDATE SKIP LOCKED`, limite diário e prevenção de duplicidade.
- Cloudflare Worker acionado a cada minuto.
- Webhook oficial para abrir a janela de 24 horas e registrar entrega/leitura/falha.
- RLS em todas as tabelas acessíveis pelo frontend.
- Segredos exclusivamente no Worker.

## Limite real do custo zero

Cloudflare Workers e Supabase podem operar a R$ 0 dentro das franquias gratuitas. O modo padrão envia somente texto dentro da janela de atendimento iniciada pelo cliente. Campanhas proativas e templates de marketing não fazem parte do modo gratuito e podem ser cobrados pela Meta.

## Instalação resumida

1. Crie um projeto gratuito no Supabase e execute `supabase/schema.sql` no SQL Editor.
2. Em Authentication, crie seu usuário administrador.
3. Insira sua configuração vinculando o Phone Number ID ao administrador:

```sql
insert into public.configuracoes(user_id, phone_number_id, limite_diario, modo_custo_zero)
select id, 'SEU_PHONE_NUMBER_ID', 50, true from auth.users where email='SEU_EMAIL';
```

4. Edite `dashboard/config.js` e preencha a URL/chave `anon`.
5. No Cloudflare Pages, publique a pasta `dashboard` sem comando de build.
6. Na pasta `worker`, execute `npm install` e `npx wrangler login`.
7. Cadastre cada segredo listado em `.env.example`:

```bash
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
npx wrangler secret put WA_ACCESS_TOKEN
npx wrangler secret put WA_PHONE_NUMBER_ID
npx wrangler secret put WA_VERIFY_TOKEN
npx wrangler secret put WA_GRAPH_VERSION
npx wrangler secret put INTERNAL_API_TOKEN
```

8. Execute `npm run deploy`. Na Meta, cadastre `https://SEU-WORKER.workers.dev/webhook/whatsapp` e o mesmo `WA_VERIFY_TOKEN`.
9. Assine o evento `messages`. Envie uma mensagem do seu celular para o número comercial; isso abre a janela gratuita para o teste.

## Teste local

Crie `worker/.dev.vars` com os valores de `.env.example`, depois:

```bash
cd worker
npm install
npm run check
npm run dev
```

## Operação segura

O contato precisa iniciar ou responder a conversa. O webhook abre uma janela de 24 horas. A mensagem é colocada na fila pelo dashboard e o cron envia no próximo minuto. Se a janela expirou, a fila recebe `bloqueado_custo` e nenhuma chamada de envio é feita à Meta.

As palavras `SAIR`, `PARAR`, `CANCELAR` e `REMOVER` descadastram automaticamente o contato e cancelam seus envios pendentes.

## Documentação oficial

- [WhatsApp Cloud API](https://developers.facebook.com/docs/whatsapp/cloud-api/)
- [Preços do WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/pricing/)
- [Cloudflare Workers](https://developers.cloudflare.com/workers/)
- [Planos do Supabase](https://supabase.com/pricing)
