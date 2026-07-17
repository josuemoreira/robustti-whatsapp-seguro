import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const config = window.APP_CONFIG;
if (!config?.SUPABASE_URL || !config?.SUPABASE_ANON_KEY) {
  document.body.innerHTML = "<main class='shell'><section class='card'><h2>Configuração pendente</h2><p>Crie dashboard/config.js usando config.example.js.</p></section></main>";
  throw new Error("config.js ausente");
}
const db = createClient(config.SUPABASE_URL, config.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
let user = null;
let contacts = [];
const toast = (text) => { $("toast").textContent = text; $("toast").classList.add("show"); setTimeout(() => $("toast").classList.remove("show"), 2800); };
const cleanPhone = (value) => value.replace(/\D/g, "");

async function load() {
  const [{ data: c }, { data: q }] = await Promise.all([
    db.from("contatos").select("id,nome,numero_whatsapp,status,janela_atendimento_ate").order("nome"),
    db.from("fila_envios").select("id,mensagem_final,agendado_para,status,contatos(nome)").order("criado_em", { ascending: false }).limit(100)
  ]);
  contacts = c || [];
  $("queueContact").innerHTML = contacts.filter(x => x.status === "ativo").map(x => `<option value="${x.id}">${escapeHtml(x.nome)} — ${x.numero_whatsapp}</option>`).join("");
  $("queueRows").innerHTML = (q || []).map(x => `<tr><td>${escapeHtml(x.contatos?.nome || "—")}</td><td>${escapeHtml(x.mensagem_final)}</td><td>${new Date(x.agendado_para).toLocaleString("pt-BR")}</td><td><span class="status ${x.status}">${x.status}</span></td></tr>`).join("");
  $("contactCount").textContent = contacts.filter(x => x.status === "ativo").length;
  $("pendingCount").textContent = (q || []).filter(x => x.status === "pendente").length;
  const today = new Date().toISOString().slice(0,10);
  $("sentCount").textContent = (q || []).filter(x => x.status === "enviado" && x.agendado_para.startsWith(today)).length;
}
function escapeHtml(value = "") { const d = document.createElement("div"); d.textContent = value; return d.innerHTML; }
function showSession(session) { user = session?.user || null; $("login").classList.toggle("hidden", !!user); $("app").classList.toggle("hidden", !user); $("logout").classList.toggle("hidden", !user); if (user) load(); }

$("loginForm").addEventListener("submit", async (event) => { event.preventDefault(); const { error } = await db.auth.signInWithPassword({ email: $("email").value, password: $("password").value }); error ? toast(error.message) : toast("Acesso liberado"); });
$("logout").addEventListener("click", () => db.auth.signOut());
$("refresh").addEventListener("click", load);
$("contactForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const phone = cleanPhone($("contactPhone").value);
  if (phone.length < 10 || phone.length > 15) return toast("Número inválido. Use DDI + DDD + número.");
  const { error } = await db.from("contatos").insert({ user_id: user.id, nome: $("contactName").value.trim(), numero_whatsapp: phone, consentimento_em: new Date().toISOString(), consentimento_origem: "Cadastro manual confirmado" });
  if (error) return toast(error.message); event.target.reset(); toast("Contato salvo"); load();
});
$("queueForm").addEventListener("submit", async (event) => {
  event.preventDefault(); const contact = contacts.find(x => x.id === $("queueContact").value); if (!contact) return;
  const finalMessage = $("message").value.trim().replaceAll("{{nome}}", contact.nome);
  const { error } = await db.from("fila_envios").insert({ user_id: user.id, contato_id: contact.id, mensagem_final: finalMessage, agendado_para: new Date().toISOString() });
  if (error) return toast(error.message); event.target.reset(); toast("Mensagem adicionada à fila"); load();
});
db.auth.onAuthStateChange((_event, session) => showSession(session));
showSession((await db.auth.getSession()).data.session);

