interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  WA_ACCESS_TOKEN: string;
  WA_PHONE_NUMBER_ID: string;
  WA_VERIFY_TOKEN: string;
  WA_GRAPH_VERSION: string;
  INTERNAL_API_TOKEN: string;
  ZERO_COST_MODE?: string;
}

type QueueItem = {
  id: string;
  user_id: string;
  numero_whatsapp: string;
  mensagem_final: string;
  janela_atendimento_ate: string | null;
  limite_diario: number;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });

function required(env: Env) {
  const keys: (keyof Env)[] = [
    "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "WA_ACCESS_TOKEN",
    "WA_PHONE_NUMBER_ID", "WA_VERIFY_TOKEN", "WA_GRAPH_VERSION", "INTERNAL_API_TOKEN"
  ];
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) throw new Error(`Configuração ausente: ${missing.join(", ")}`);
}

async function supabase(env: Env, path: string, init: RequestInit = {}) {
  const response = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      "content-type": "application/json",
      prefer: "return=representation",
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${text}`);
  return body;
}

async function patchQueue(env: Env, id: string, data: Record<string, unknown>) {
  return supabase(env, `fila_envios?id=eq.${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(data)
  });
}

async function claimNext(env: Env): Promise<QueueItem | null> {
  const rows = await supabase(env, "rpc/claim_next_send", {
    method: "POST",
    body: JSON.stringify({ p_worker_id: crypto.randomUUID() })
  });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

async function sendWhatsApp(env: Env, item: QueueItem) {
  const endpoint = `https://graph.facebook.com/${env.WA_GRAPH_VERSION}/${env.WA_PHONE_NUMBER_ID}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { authorization: `Bearer ${env.WA_ACCESS_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: item.numero_whatsapp,
      type: "text",
      text: { preview_url: false, body: item.mensagem_final }
    })
  });
  const body = await response.json<Record<string, any>>();
  if (!response.ok) throw new Error(`Meta ${response.status}: ${JSON.stringify(body)}`);
  return body.messages?.[0]?.id as string | undefined;
}

async function processQueue(env: Env) {
  required(env);
  const item = await claimNext(env);
  if (!item) return { processed: false, reason: "fila_vazia" };

  const zeroCost = env.ZERO_COST_MODE !== "false";
  const windowOpen = item.janela_atendimento_ate && new Date(item.janela_atendimento_ate) > new Date();
  if (zeroCost && !windowOpen) {
    await patchQueue(env, item.id, {
      status: "bloqueado_custo",
      erro_log: "Modo Custo Zero: conversa fora da janela gratuita de atendimento.",
      processando_em: null,
      worker_id: null
    });
    return { processed: true, sent: false, reason: "bloqueado_custo" };
  }

  try {
    const messageId = await sendWhatsApp(env, item);
    await patchQueue(env, item.id, {
      status: "enviado",
      meta_message_id: messageId || null,
      enviado_em: new Date().toISOString(),
      processando_em: null
    });
    return { processed: true, sent: true, id: item.id };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await patchQueue(env, item.id, {
      status: "falhou",
      erro_log: message.slice(0, 2000),
      processando_em: null
    });
    return { processed: true, sent: false, reason: "falhou" };
  }
}

async function registerWebhook(env: Env, payload: Record<string, any>) {
  await supabase(env, "rpc/register_whatsapp_webhook", {
    method: "POST",
    body: JSON.stringify({ p_payload: payload })
  });
}

async function handleFetch(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname === "/health") return json({ ok: true, service: "robustti-whatsapp-seguro" });

  if (url.pathname === "/webhook/whatsapp" && request.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    return mode === "subscribe" && token === env.WA_VERIFY_TOKEN && challenge
      ? new Response(challenge)
      : json({ error: "verificação inválida" }, 403);
  }

  if (url.pathname === "/webhook/whatsapp" && request.method === "POST") {
    const payload = await request.json<Record<string, any>>();
    await registerWebhook(env, payload);
    return json({ received: true });
  }

  if (url.pathname === "/internal/process" && request.method === "POST") {
    if (request.headers.get("authorization") !== `Bearer ${env.INTERNAL_API_TOKEN}`)
      return json({ error: "não autorizado" }, 401);
    return json(await processQueue(env));
  }
  return json({ error: "não encontrado" }, 404);
}

export default {
  fetch: handleFetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(processQueue(env));
  }
} satisfies ExportedHandler<Env>;

