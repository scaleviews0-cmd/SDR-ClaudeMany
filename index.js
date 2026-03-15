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
const LINK_PAGAMENTO = process.env.LINK_PAGAMENTO || "https://seu-link-aqui.com";
const MANYCHAT_API_TOKEN = process.env.MANYCHAT_API_TOKEN;
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 25000;

// ============================================================
// MEMORIA LOCAL - ARQUIVO JSON (nao depende do ManyChat)
// ============================================================
const MEMORY_FILE = path.join(__dirname, "leads_memory.json");

function loadMemory() {
  try {
    if (fs.existsSync(MEMORY_FILE)) return JSON.parse(fs.readFileSync(MEMORY_FILE, "utf-8"));
  } catch (e) { console.warn("Erro ao carregar memoria:", e.message); }
  return {};
}

function saveMemory(memory) {
  try { fs.writeFileSync(MEMORY_FILE, JSON.stringify(memory, null, 2)); }
  catch (e) { console.warn("Erro ao salvar memoria:", e.message); }
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
  if (userName) existing.user_name = userName;

  memory[userId] = existing;
  saveMemory(memory);

  const filled = Object.entries(existing).filter(([k, v]) => v && v !== "" && v !== "frio" && v !== "novo" && v !== 0 && !["created_at", "last_interaction", "conversation_history"].includes(k)).length;
  console.log(`[MEMORIA] Lead ${userId} salvo com ${filled} campos preenchidos`);
  return existing;
}

// ============================================================
// MANYCHAT API - ENVIAR MENSAGEM
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
    if (r.ok) { console.log("[ManyChat] Mensagem enviada!"); return true; }
    else { const e = await r.text().catch(() => ""); console.warn("[ManyChat] Erro:", r.status, e.substring(0, 200)); return false; }
  } catch (e) { console.warn("[ManyChat] Erro:", e.message); return false; }
}

async function addManyChatTag(subscriberId, tagName) {
  if (!MANYCHAT_API_TOKEN || !subscriberId) return;
  try {
    await fetch("https://api.manychat.com/fb/subscriber/addTagByName", {
      method: "POST",
      headers: { "Authorization": "Bearer " + MANYCHAT_API_TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify({ subscriber_id: Number(subscriberId), tag_name: tagName }),
    });
  } catch (e) { /* silencioso */ }
}

// ============================================================
// CONTEXTO PARA O CLAUDE
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
# MEMORIA COMPLETA DO LEAD

## Basico
- Estado: ${lead.lead_state || "novo"}
- Nome: ${lead.lead_nome || "Nao informado"}
- Instagram: ${lead.user_name || "Nao informado"}
- Temperatura: ${lead.lead_temperatura || "frio"}
- Objecoes: ${lead.objecao_count || 0}x
- Fonte: ${lead.fonte_entrada || "Nao informado"}
- Dias sem interacao: ${dias}

## Profissional
- Nicho: ${lead.lead_nicho || "Nao informado"}
- Empresas: ${lead.lead_empresas || "Nao informado"}
- Produtos/Servicos: ${lead.lead_produtos_servicos || "Nao informado"}
- Faturamento: ${lead.lead_faturamento || "Nao informado"}
- Equipe: ${lead.lead_tamanho_equipe || "Nao informado"}
- Redes: ${lead.lead_redes_sociais || "Nao informado"}
- Ferramentas: ${lead.lead_ferramentas || "Nao informado"}

## Dores e Objetivos
- Dor: ${lead.lead_dor_principal || "Nao informado"}
- Desejo: ${lead.lead_desejo || "Nao informado"}
- Objetivo curto prazo: ${lead.lead_objetivo_curto || "Nao informado"}
- Objetivo longo prazo: ${lead.lead_objetivo_longo || "Nao informado"}
- Objecao: ${lead.lead_objecao || "Nenhuma"}

## Historico Amanda
- Compras: ${lead.lead_historico_amanda || "Nao informado"}

# INSTRUCOES`;

  if (dias > 3 && lead.lead_nome) {
    ctx += `\nATENCAO: Lead voltou apos ${dias} dias. Retome naturalmente: "Opa ${lead.lead_nome}! Da ultima vez a gente conversou sobre ${lead.lead_dor_principal || lead.lead_nicho || 'seu negocio'}..."`;
  }
  if (!lead.lead_state || lead.lead_state === "novo" || lead.lead_state === "saudacao") {
    ctx += "\nPrimeira interacao ou inicio. Seja acolhedor(a). VARIE a saudacao.";
  }
  if ((lead.objecao_count || 0) >= 2) {
    ctx += `\nLead com ${lead.objecao_count} objecoes. Se repetir, faca handoff.`;
  }

  ctx += "\n\nREGRA CRITICA: Se um campo acima NAO esta como 'Nao informado', NUNCA pergunte sobre ele. Use a info para personalizar.";
  ctx += "\nResponda APENAS com JSON no formato especificado.";

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
// ROTAS
// ============================================================
app.get("/", (req, res) => {
  res.json({ status: "online", service: "SDR Amanda Mecenas v3", leads: Object.keys(loadMemory()).length });
});
app.get("/health", (req, res) => res.json({ status: "ok" }));
app.get("/lead/:id", (req, res) => res.json(getLeadData(req.params.id)));
app.get("/leads", (req, res) => {
  const mem = loadMemory();
  const summary = Object.entries(mem).map(([id, d]) => ({
    id, nome: d.lead_nome, nicho: d.lead_nicho, state: d.lead_state, temp: d.lead_temperatura, last: d.last_interaction
  }));
  res.json(summary);
});

app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  try {
    const payload = req.body || {};
    const userId = payload.user_id || "unknown";
    const userName = payload.user_name || "";
    const lastMessage = payload.last_message || "";

    // CARREGA MEMORIA
    const leadData = getLeadData(userId);
    if (userName && !leadData.user_name) leadData.user_name = userName;
    if (payload.fonte_entrada && !leadData.fonte_entrada) leadData.fonte_entrada = payload.fonte_entrada;

    console.log("\n========================================");
    console.log(`MENSAGEM | User: ${leadData.lead_nome || userName || "?"} | ID: ${userId}`);
    console.log(`State: ${leadData.lead_state} | Nicho: ${leadData.lead_nicho || "?"} | Temp: ${leadData.lead_temperatura}`);
    console.log(`Msg: "${lastMessage}"`);
    console.log("========================================");

    if (!lastMessage && leadData.lead_state && leadData.lead_state !== "novo") {
      return res.json({ version: "v2", content: { messages: [{ type: "text", text: "Oi! Como posso te ajudar?" }], actions: [] } });
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

    let replyText = (claudeData.reply || "Oi! Ja te respondo.").replace(/\[LINK\]/g, LINK_PAGAMENTO);
    console.log(`Action: ${claudeData.action} | State: ${claudeData.lead_state} | Reply: ${replyText.substring(0, 100)}...`);

    // ENVIA
    if (userId !== "unknown" && MANYCHAT_API_TOKEN) {
      await sendManyChatMessage(userId, replyText);
      if (claudeData.action === "handoff") await addManyChatTag(userId, "handoff_solicitado");
      if (claudeData.action === "send_link") { await addManyChatTag(userId, "link_enviado"); await addManyChatTag(userId, "lead_quente"); }
    }

    return res.json({ version: "v2", content: { messages: [{ type: "text", text: replyText }], actions: [] } });

  } catch (error) {
    console.error("ERRO:", error.message);
    return res.json({ version: "v2", content: { messages: [{ type: "text", text: "Oi! Me manda de novo em alguns minutinhos 😊" }], actions: [] } });
  }
});

app.listen(PORT, () => {
  const mem = loadMemory();
  console.log(`\n🚀 SDR Amanda Mecenas v3.0 - MEMORIA DEFINITIVA`);
  console.log(`📡 http://localhost:${PORT}/webhook`);
  console.log(`🔑 Claude: ${process.env.ANTHROPIC_API_KEY ? "OK" : "FALTA"} | ManyChat: ${MANYCHAT_API_TOKEN ? "OK" : "FALTA"}`);
  console.log(`🧠 Leads na memoria: ${Object.keys(mem).length}`);
  console.log(`🔗 ${LINK_PAGAMENTO}\n`);
});
