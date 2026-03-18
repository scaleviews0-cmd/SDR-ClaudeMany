require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default;
const fs = require("fs");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const SYSTEM_PROMPT = fs.readFileSync(path.join(__dirname, "system-prompt.txt"), "utf-8");
const LINK_PAGAMENTO = process.env.LINK_PAGAMENTO || "https://circle.visionairebusinesslegacy.com";
const MANYCHAT_API_TOKEN = process.env.MANYCHAT_API_TOKEN;
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 25000;

// ============================================================
// MEMORIA LOCAL - PERSISTENTE (usa volume do Railway)
// ============================================================
const MEMORY_DIR = process.env.MEMORY_PATH || "/data";
const MEMORY_FILE = path.join(MEMORY_DIR, "leads_memory.json");

// Cria o diretorio se nao existir
try { if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true }); }
catch (e) { console.warn("Usando diretorio local para memoria"); }

function loadMemory() {
  try { if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8")); }
  catch (e) { console.warn("Erro memoria:", e.message); }
  return {};
}

function saveMemory(memory) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); }
  catch (e) { console.warn("Erro salvar:", e.message); }
}

function getLeadData(userId) {
  const memory = loadMemory();
  return memory[userId] || {
    lead_nome: "", lead_nicho: "", lead_faturamento: "", lead_dor_principal: "",
    lead_desejo: "", lead_objecao: "", lead_temperatura: "frio",
    lead_empresas: "", lead_produtos_servicos: "", lead_tamanho_equipe: "",
    lead_redes_sociais: "", lead_objetivo_curto: "", lead_objetivo_longo: "",
    lead_ferramentas: "", lead_historico_amanda: "",
    lead_state: "novo", objecao_count: 0, conversation_history: [],
    fonte_entrada: "", user_name: "",
    created_at: new Date().toISOString(), last_interaction: new Date().toISOString(),
    followup_sent: false,
  };
}

function updateLeadData(userId, updates, conversationHistory, userName) {
  const memory = loadMemory();
  const existing = memory[userId] || getLeadData(userId);

  for (const [key, value] of Object.entries(updates)) {
    if (value && value !== "null" && value !== null && value !== "") {
      const acumulaveis = ["lead_empresas", "lead_produtos_servicos", "lead_redes_sociais", "lead_ferramentas"];
      if (acumulaveis.includes(key) && existing[key] && existing[key] !== "" && value !== existing[key] && !value.includes(existing[key])) {
        existing[key] = existing[key] + " | " + value;
      } else {
        existing[key] = value;
      }
    }
  }

  if (conversationHistory) existing.conversation_history = conversationHistory;
  existing.last_interaction = new Date().toISOString();
  existing.followup_sent = false;
  if (userName) existing.user_name = userName;

  memory[userId] = existing;
  saveMemory(memory);
  return existing;
}

// ============================================================
// MANYCHAT API
// ============================================================
async function sendManyChatMessage(subscriberId, text) {
  if (!MANYCHAT_API_TOKEN || !subscriberId) return false;
  try {
    const r = await fetch("https://api.manychat.com/fb/sending/sendContent", {
      method: "POST",
      headers: { "Authorization": "Bearer " + MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({
        subscriber_id: Number(subscriberId),
        data: { version: "v2", content: { type: "instagram", messages: [{ type: "text", text }] } },
      }),
    });
    if (r.ok) { console.log("[MSG ENVIADA]"); return true; }
    else { const e = await r.text().catch(() => ""); console.warn("[MSG ERRO]", r.status, e.substring(0, 200)); return false; }
  } catch (e) { console.warn("[MSG ERRO]", e.message); return false; }
}

async function addManyChatTag(subscriberId, tagName) {
  if (!MANYCHAT_API_TOKEN || !subscriberId) return;
  try {
    await fetch("https://api.manychat.com/fb/subscriber/addTagByName", {
      method: "POST",
      headers: { "Authorization": "Bearer " + MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ subscriber_id: Number(subscriberId), tag_name: tagName }),
    });
  } catch (e) { /* ok */ }
}

// ============================================================
// DELAY DE DIGITACAO (simula pessoa real lendo e digitando)
// ============================================================
function calculateTypingDelay(text) {
  const words = text.split(" ").length;
  // Base: 8 a 20 segundos (pessoa lê a mensagem, pensa, começa a digitar)
  const base = 8000 + Math.random() * 12000;
  // + 0.5s por palavra da resposta (digitando)
  const perWord = words * 500;
  // Variação aleatória adicional de 0-5s
  const randomExtra = Math.random() * 5000;
  // Total: entre 10 e 35 segundos (parece uma pessoa real)
  const total = Math.min(base + perWord + randomExtra, 35000);
  return Math.floor(total);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
// CONTEXTO PARA CLAUDE
// ============================================================
function buildMessages(history, lastMessage) {
  let msgs = [];
  if (Array.isArray(history)) msgs = [...history];
  else if (typeof history === "string" && history !== "" && history !== "[]") {
    try { msgs = JSON.parse(history); } catch (e) { msgs = []; }
  }
  if (lastMessage) msgs.push({ role: "user", content: lastMessage });
  return msgs.length > 15 ? msgs.slice(-15) : msgs;
}

function buildContext(lead) {
  const dias = lead.last_interaction ? Math.floor((Date.now() - new Date(lead.last_interaction).getTime()) / 86400000) : 0;

  let ctx = `
# MEMORIA DO LEAD

## Basico
- Estado: ${lead.lead_state || "novo"} | Nome: ${lead.lead_nome || "?"} | IG: ${lead.user_name || "?"} | Temp: ${lead.lead_temperatura || "frio"} | Objecoes: ${lead.objecao_count || 0}x | Dias sem falar: ${dias}

## Profissional
- Nicho: ${lead.lead_nicho || "?"}
- Empresas: ${lead.lead_empresas || "?"}
- Produtos: ${lead.lead_produtos_servicos || "?"}
- Faturamento: ${lead.lead_faturamento || "?"}
- Equipe: ${lead.lead_tamanho_equipe || "?"}
- Redes: ${lead.lead_redes_sociais || "?"}
- Ferramentas: ${lead.lead_ferramentas || "?"}

## Objetivos e Dores
- Dor: ${lead.lead_dor_principal || "?"} | Desejo: ${lead.lead_desejo || "?"}
- Curto prazo: ${lead.lead_objetivo_curto || "?"} | Longo prazo: ${lead.lead_objetivo_longo || "?"}
- Objecao: ${lead.lead_objecao || "nenhuma"}
- Historico Amanda: ${lead.lead_historico_amanda || "?"}

# INSTRUCOES`;

  if (dias > 3 && lead.lead_nome) {
    ctx += `\nLead voltou apos ${dias} dias. Retome naturalmente referenciando conversa anterior.`;
  }
  if (!lead.lead_state || lead.lead_state === "novo" || lead.lead_state === "saudacao") {
    ctx += "\nInicio de conversa. Seja natural e direta. VARIE a abordagem.";
  }
  if ((lead.objecao_count || 0) >= 2) {
    ctx += `\nLead com ${lead.objecao_count} objecoes. Se repetir, handoff.`;
  }
  ctx += "\nSe um campo acima tem info (nao e '?'), NUNCA pergunte sobre isso. Use para personalizar.";
  ctx += "\nResponda APENAS JSON no formato especificado.";
  return ctx;
}

function parseResponse(text) {
  let c = text.trim();
  if (c.startsWith("```json")) c = c.slice(7);
  if (c.startsWith("```")) c = c.slice(3);
  if (c.endsWith("```")) c = c.slice(0, -3);
  return JSON.parse(c.trim());
}

// ============================================================
// FOLLOW-UPS AUTOMATICOS (QUARTA + QUINTA)
// ============================================================

// Quinta-feira: Visionaire Circle (4 variacoes - 1 por semana do mes)
const QUINTA_MSGS = [
  // Semana 1 - Foco em NETWORKING
  "Essa semana tem aula ao vivo na Visionaire Circle. O mais valioso nem e so o conteudo — e estar na mesma sala que empresarios que estao escalando de verdade. Quem ta dentro, ta junto. Se quiser conhecer: circle.visionairebusinesslegacy.com",
  // Semana 2 - Foco em IMPLEMENTACAO
  "Toda semana na Visionaire Circle a gente senta pra implementar, nao pra assistir aula passivamente. E o unico lugar onde voce sai com estrategia aplicada no mesmo dia. Se fizer sentido pra voce: circle.visionairebusinesslegacy.com",
  // Semana 3 - Foco em RESULTADO
  "Mais uma semana de aula ao vivo na Visionaire Circle. Empresarios la dentro estao dobrando faturamento, montando equipe e saindo do operacional. Se voce quer esse tipo de resultado: circle.visionairebusinesslegacy.com",
  // Semana 4 - Foco em EXCLUSIVIDADE
  "A Visionaire Circle nao e pra todo mundo — e pra quem leva a serio crescer como empresario. Toda semana tem aula ao vivo, networking e implementacao real. Se voce e esse tipo de pessoa: circle.visionairebusinesslegacy.com",
];

// Quarta-feira: Aula bonus gratuita (4 variacoes - 1 por semana do mes)
const QUARTA_MSGS = [
  // Semana 1 - Foco em OPORTUNIDADE
  "Separei uma aula especial pra quem quer escalar no digital. E de graca e vale mais do que muito curso pago por ai. Assiste e depois me fala o que achou: https://www.youtube.com/watch?v=4KRaiesZmhk&t=1059s",
  // Semana 2 - Foco em DOR
  "Se voce sente que seu negocio podia estar num nivel maior mas nao sabe qual o proximo passo, essa aula vai te dar clareza. E uma aula bonus que gravei pra ajudar empresarios como voce: https://www.youtube.com/watch?v=4KRaiesZmhk&t=1059s",
  // Semana 3 - Foco em PROVA
  "Muita gente que assistiu essa aula me mandou mensagem dizendo que mudou a forma de enxergar o negocio. E uma aula especial bonus sobre escalar no digital. Veja e me conta o que achou: https://www.youtube.com/watch?v=4KRaiesZmhk&t=1059s",
  // Semana 4 - Foco em URGENCIA
  "Vou te mandar um conteudo que normalmente so compartilho com quem e proximo. E uma aula bonus sobre como escalar no digital de forma estrategica. Assiste enquanto ta disponivel: https://www.youtube.com/watch?v=4KRaiesZmhk&t=1059s",
];

function getWeekOfMonth() {
  const now = new Date();
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  return Math.ceil((now.getDate() + firstDay.getDay()) / 7) - 1; // 0-3
}

async function sendFollowUps(dayType) {
  const messages = dayType === "quinta" ? QUINTA_MSGS : QUARTA_MSGS;
  const weekIndex = getWeekOfMonth() % messages.length;
  const baseMsg = messages[weekIndex];
  const label = dayType === "quinta" ? "VISIONAIRE CIRCLE" : "AULA BONUS";

  console.log(`\n[FOLLOW-UP ${label}] Semana ${weekIndex + 1} do mes`);

  const memory = loadMemory();
  const followupKey = dayType === "quinta" ? "followup_quinta" : "followup_quarta";
  let sent = 0;

  for (const [userId, lead] of Object.entries(memory)) {
    // Pular se ja enviou esse follow-up essa semana
    if (lead[followupKey]) continue;

    const diasSemFalar = lead.last_interaction
      ? Math.floor((Date.now() - new Date(lead.last_interaction).getTime()) / 86400000)
      : 999;

    const temConversa = lead.conversation_history && lead.conversation_history.length > 0;
    const naoDesqualificado = lead.lead_state !== "desqualificado";

    // Envia para quem tem conversa e 2+ dias sem falar
    if (temConversa && diasSemFalar >= 2 && naoDesqualificado) {
      const personalizada = lead.lead_nome
        ? `${lead.lead_nome}, ${baseMsg.charAt(0).toLowerCase() + baseMsg.slice(1)}`
        : baseMsg;

      const success = await sendManyChatMessage(userId, personalizada);
      if (success) {
        lead[followupKey] = true;
        if (!lead.conversation_history) lead.conversation_history = [];
        lead.conversation_history.push({ role: "assistant", content: personalizada });
        memory[userId] = lead;
        sent++;
        console.log(`[FOLLOW-UP] -> ${lead.lead_nome || userId}`);
        await delay(3000); // 3s entre envios
      }
    }
  }

  saveMemory(memory);
  console.log(`[FOLLOW-UP ${label}] ${sent} enviados\n`);
  return sent;
}

async function checkFollowUps() {
  const now = new Date();
  const day = now.getDay(); // 0=dom, 3=qua, 4=qui
  const hour = now.getHours();

  // Quarta-feira 10h
  if (day === 3 && hour === 10) {
    await sendFollowUps("quarta");
  }
  // Quinta-feira 10h
  if (day === 4 && hour === 10) {
    await sendFollowUps("quinta");
  }

  // Reset dos flags no domingo (pra permitir novos follow-ups na proxima semana)
  if (day === 0 && hour === 3) {
    const memory = loadMemory();
    for (const userId of Object.keys(memory)) {
      memory[userId].followup_quinta = false;
      memory[userId].followup_quarta = false;
    }
    saveMemory(memory);
    console.log("[FOLLOW-UP] Flags resetados para nova semana");
  }
}

// Checa a cada hora
setInterval(checkFollowUps, 60 * 60 * 1000);

// ============================================================
// ROTAS
// ============================================================
app.get("/", (req, res) => {
  res.json({ status: "online", service: "SDR Amanda Mecenas v4", leads: Object.keys(loadMemory()).length });
});
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/lead/:id", (req, res) => res.json(getLeadData(req.params.id)));
app.get("/leads", (req, res) => {
  const mem = loadMemory();
  const summary = Object.entries(mem).map(([id, d]) => ({
    id, nome: d.lead_nome, nicho: d.lead_nicho, state: d.lead_state,
    temp: d.lead_temperatura, last: d.last_interaction, followup: d.followup_sent
  }));
  res.json(summary);
});

// Endpoint manual para testar follow-ups
app.get("/followup/test", async (req, res) => {
  const memory = loadMemory();
  const elegiveis = [];
  for (const [userId, lead] of Object.entries(memory)) {
    const dias = lead.last_interaction ? Math.floor((Date.now() - new Date(lead.last_interaction).getTime()) / 86400000) : 999;
    const temConversa = lead.conversation_history && lead.conversation_history.length > 0;
    if (temConversa && dias >= 2 && lead.lead_state !== "desqualificado") {
      elegiveis.push({ id: userId, nome: lead.lead_nome, dias, state: lead.lead_state, temp: lead.lead_temperatura, quinta: lead.followup_quinta || false, quarta: lead.followup_quarta || false });
    }
  }
  res.json({ elegiveis, total: elegiveis.length, semana_do_mes: getWeekOfMonth() + 1 });
});

// Dispara follow-ups manualmente (quarta ou quinta)
app.post("/followup/send/:type", async (req, res) => {
  const type = req.params.type; // "quarta" ou "quinta"
  if (!["quarta", "quinta"].includes(type)) return res.json({ error: "Use /followup/send/quarta ou /followup/send/quinta" });
  const sent = await sendFollowUps(type);
  res.json({ tipo: type, enviados: sent });
});

// ============================================================
// WEBHOOK PRINCIPAL
// ============================================================
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  try {
    const payload = req.body || {};
    const userId = payload.user_id || "unknown";
    const userName = payload.user_name || "";
    const lastMessage = payload.last_message || "";
    const fonte = payload.fonte_entrada || "";

    // IGNORA respostas de story (Amanda faz manualmente)
    if (fonte === "story" || fonte === "story_reply" || fonte === "stories") {
      console.log(`[IGNORADO] Resposta de story de ${userName}`);
      return res.json({ version: "v2", content: { messages: [], actions: [] } });
    }

    const leadData = getLeadData(userId);
    if (userName && !leadData.user_name) leadData.user_name = userName;
    if (fonte && !leadData.fonte_entrada) leadData.fonte_entrada = fonte;

    console.log("\n========================================");
    console.log(`MSG | ${leadData.lead_nome || userName || "?"} (${userId})`);
    console.log(`State: ${leadData.lead_state} | Nicho: ${leadData.lead_nicho || "?"} | Temp: ${leadData.lead_temperatura}`);
    console.log(`"${lastMessage}"`);
    console.log("========================================");

    if (!lastMessage && leadData.lead_state && leadData.lead_state !== "novo") {
      return res.json({ version: "v2", content: { messages: [{ type: "text", text: "E ai, tudo bem?" }], actions: [] } });
    }

    if (!leadData.lead_state || leadData.lead_state === "novo") leadData.lead_state = "saudacao";

    const messages = buildMessages(leadData.conversation_history, lastMessage || "(primeiro contato)");
    const context = buildContext(leadData);
    const fullPrompt = SYSTEM_PROMPT + "\n\n" + context;

    const claudePromise = anthropic.messages.create({
      model: "claude-sonnet-4-20250514", max_tokens: 1024,
      system: fullPrompt,
      messages: messages.length > 0 ? messages : [{ role: "user", content: lastMessage || "oi" }],
    });

    const response = await Promise.race([claudePromise, new Promise((_, rej) => setTimeout(() => rej(new Error("Timeout")), TIMEOUT_MS))]);
    const responseText = response.content.filter(b => b.type === "text").map(b => b.text).join("");
    console.log(`[Claude ${Date.now() - startTime}ms]`);

    let claudeData;
    try { claudeData = parseResponse(responseText); }
    catch (e) {
      console.error("Parse error:", e.message);
      claudeData = { reply: responseText.substring(0, 500), lead_state: leadData.lead_state, lead_updates: {}, action: "continue" };
    }

    // SALVA MEMORIA
    const updates = { lead_state: claudeData.lead_state || leadData.lead_state, ...(claudeData.lead_updates || {}) };
    if (claudeData.lead_state === "objecao") updates.objecao_count = (leadData.objecao_count || 0) + 1;

    const updatedHistory = [...messages];
    updatedHistory.push({ role: "assistant", content: claudeData.reply });
    updateLeadData(userId, updates, updatedHistory.slice(-15), userName);

    let replyText = (claudeData.reply || "E aí... tudo certo?")
      .replace(/\[LINK\]/g, LINK_PAGAMENTO)
      .replace(/\[CALENDLY\]/g, "https://calendly.com/scaleviews0/30min");

    // DELAY DE DIGITACAO (simula pessoa real)
    const typingDelay = calculateTypingDelay(replyText);
    console.log(`[Delay ${typingDelay}ms] Action: ${claudeData.action} | State: ${claudeData.lead_state}`);
    console.log(`Reply: ${replyText.substring(0, 120)}...`);

    await delay(typingDelay);

    // ENVIA
    if (userId !== "unknown" && MANYCHAT_API_TOKEN) {
      await sendManyChatMessage(userId, replyText);
      if (claudeData.action === "handoff") await addManyChatTag(userId, "handoff_solicitado");
      if (claudeData.action === "send_link") { await addManyChatTag(userId, "link_enviado"); await addManyChatTag(userId, "lead_quente"); }
      if (claudeData.action === "send_calendly") { await addManyChatTag(userId, "mentoria_individual"); await addManyChatTag(userId, "lead_quente"); }
    }

    return res.json({ version: "v2", content: { messages: [{ type: "text", text: replyText }], actions: [] } });

  } catch (error) {
    console.error("ERRO:", error.message);
    return res.json({ version: "v2", content: { messages: [{ type: "text", text: "Da um minuto que ja te respondo" }], actions: [] } });
  }
});

// ============================================================
// INICIAR
// ============================================================
app.listen(PORT, () => {
  const mem = loadMemory();
  console.log(`\n🚀 SDR Amanda v4.0 — Visionaire Business Legacy`);
  console.log(`📡 http://localhost:${PORT}/webhook`);
  console.log(`🔑 Claude: ${process.env.ANTHROPIC_API_KEY ? "OK" : "FALTA"} | ManyChat: ${MANYCHAT_API_TOKEN ? "OK" : "FALTA"}`);
  console.log(`🧠 Leads: ${Object.keys(mem).length}`);
  console.log(`🔗 ${LINK_PAGAMENTO}`);
  console.log(`📅 Follow-ups: QUA (aula bonus) + QUI (Visionaire Circle)\n`);
  checkFollowUps();
});
