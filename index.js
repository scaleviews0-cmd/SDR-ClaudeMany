require("dotenv").config();
const express = require("express");
const cors = require("cors");
const Anthropic = require("@anthropic-ai/sdk").default;
const fs = require("fs");
const path = require("path");

// ============================================================
// CONFIGURACAO
// ============================================================

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, "system-prompt.txt"),
  "utf-8"
);

const LINK_PAGAMENTO = process.env.LINK_PAGAMENTO || "https://seu-link-aqui.com";
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 25000; // 25 segundos (Railway tem limite de 30s)

// ============================================================
// FUNCOES AUXILIARES
// ============================================================

/**
 * Monta o historico de conversa para enviar ao Claude
 */
function buildConversationMessages(payload) {
  let history = [];

  // Tenta parsear o historico existente
  try {
    if (payload.conversation_history && payload.conversation_history !== "[]") {
      history = JSON.parse(payload.conversation_history);
    }
  } catch (e) {
    console.warn("Erro ao parsear conversation_history:", e.message);
    history = [];
  }

  // Adiciona a mensagem atual do lead
  if (payload.last_message) {
    history.push({
      role: "user",
      content: payload.last_message,
    });
  }

  // Limita a 10 mensagens (FIFO)
  if (history.length > 10) {
    history = history.slice(-10);
  }

  return history;
}

/**
 * Monta o contexto dinamico do lead para injetar no prompt
 */
function buildLeadContext(payload) {
  const profile = payload.lead_profile || {};

  return `
# CONTEXTO DO LEAD (DADOS ATUAIS)

- Estado atual do funil: ${payload.lead_state || "novo"}
- Nome: ${profile.nome || "Nao informado"}
- Nicho: ${profile.nicho || "Nao informado"}
- Faturamento/Maturidade: ${profile.faturamento || "Nao informado"}
- Dor principal: ${profile.dor_principal || "Nao informado"}
- Desejo: ${profile.desejo || "Nao informado"}
- Ultima objecao: ${profile.objecao || "Nenhuma"}
- Temperatura: ${profile.temperatura || "frio"}
- Contador de objecoes: ${payload.objecao_count || 0}
- Fonte de entrada: ${payload.fonte_entrada || "Nao informado"}
- Nome do usuario no Instagram: ${payload.user_name || "Nao informado"}

# INSTRUCAO PARA ESTA MENSAGEM

Responda a ultima mensagem do lead considerando todo o contexto acima e o historico da conversa. Lembre-se: responda APENAS com o JSON no formato especificado, nada mais.

${payload.lead_state === "novo" || payload.lead_state === "saudacao"
    ? "ATENCAO: Esta e a primeira interacao ou o lead acabou de responder a saudacao. Seja acolhedor(a) e inicie a qualificacao de forma natural."
    : ""
  }

${payload.objecao_count >= 2
    ? "ATENCAO: O lead ja apresentou objecoes " + payload.objecao_count + " vezes. Se apresentar a mesma objecao novamente, faca handoff humano."
    : ""
  }
`.trim();
}

/**
 * Parseia a resposta do Claude (que deve ser JSON)
 */
function parseClaudeResponse(text) {
  // Remove possíveis backticks de markdown
  let clean = text.trim();
  if (clean.startsWith("```json")) {
    clean = clean.slice(7);
  }
  if (clean.startsWith("```")) {
    clean = clean.slice(3);
  }
  if (clean.endsWith("```")) {
    clean = clean.slice(0, -3);
  }
  clean = clean.trim();

  return JSON.parse(clean);
}

/**
 * Converte a resposta do Claude no formato do ManyChat v2
 */
function buildManyChatResponse(claudeData, updatedHistory) {
  const actions = [];

  // Atualiza lead_state
  if (claudeData.lead_state) {
    actions.push({
      action: "set_field_value",
      field_name: "lead_state",
      value: claudeData.lead_state,
    });
  }

  // Atualiza campos do lead
  if (claudeData.lead_updates) {
    const updates = claudeData.lead_updates;
    const fieldMap = {
      lead_nome: "lead_nome",
      lead_nicho: "lead_nicho",
      lead_faturamento: "lead_faturamento",
      lead_dor_principal: "lead_dor_principal",
      lead_desejo: "lead_desejo",
      lead_objecao: "lead_objecao",
      lead_temperatura: "lead_temperatura",
    };

    for (const [key, fieldName] of Object.entries(fieldMap)) {
      if (updates[key] && updates[key] !== "null" && updates[key] !== null) {
        actions.push({
          action: "set_field_value",
          field_name: fieldName,
          value: updates[key],
        });
      }
    }
  }

  // Atualiza historico da conversa
  actions.push({
    action: "set_field_value",
    field_name: "conversation_history",
    value: JSON.stringify(updatedHistory),
  });

  // Incrementa contador de objecoes se estiver em estado de objecao
  if (claudeData.lead_state === "objecao") {
    actions.push({
      action: "set_field_value",
      field_name: "objecao_count",
      value: "{{objecao_count}} + 1",
    });
  }

  // Adiciona tags baseadas na acao
  if (claudeData.action === "handoff") {
    actions.push({ action: "add_tag", tag_name: "handoff_solicitado" });
  }
  if (claudeData.action === "send_link") {
    actions.push({ action: "add_tag", tag_name: "link_enviado" });
    actions.push({ action: "add_tag", tag_name: "lead_quente" });
  }
  if (claudeData.action === "end" && claudeData.lead_state === "desqualificado") {
    actions.push({ action: "add_tag", tag_name: "lead_desqualificado" });
  }
  if (claudeData.lead_updates?.lead_temperatura === "quente") {
    actions.push({ action: "add_tag", tag_name: "lead_quente" });
  }

  // Monta a mensagem — substitui placeholder do link
  let replyText = claudeData.reply || "Oi! Me da um instante que ja te respondo.";
  replyText = replyText.replace(/\[LINK\]/g, LINK_PAGAMENTO);

  return {
    version: "v2",
    content: {
      messages: [
        {
          type: "text",
          text: replyText,
        },
      ],
      actions: actions,
    },
  };
}

// ============================================================
// ROTAS
// ============================================================

/**
 * Health check - para verificar se o servidor esta rodando
 */
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "SDR Amanda Mecenas - Comunidade Scale",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * WEBHOOK PRINCIPAL - recebe mensagens do ManyChat
 */
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();

  try {
    const payload = req.body;

    console.log("\n========================================");
    console.log(`[${new Date().toISOString()}] Nova mensagem recebida`);
    console.log(`User: ${payload.user_name || "?"} | State: ${payload.lead_state || "novo"}`);
    console.log(`Mensagem: ${payload.last_message || "(vazio)"}`);
    console.log("========================================");

    // Validacao basica
    if (!payload.last_message && payload.lead_state !== "novo") {
      return res.json({
        version: "v2",
        content: {
          messages: [{ type: "text", text: "Oi! Como posso te ajudar?" }],
          actions: [],
        },
      });
    }

    // Se for lead novo sem mensagem, inicia saudacao
    if (payload.lead_state === "novo" || !payload.lead_state) {
      payload.lead_state = "saudacao";
      if (!payload.last_message) {
        payload.last_message = "(follow-back - primeiro contato)";
      }
    }

    // Monta historico e contexto
    const conversationMessages = buildConversationMessages(payload);
    const leadContext = buildLeadContext(payload);
    const fullSystemPrompt = SYSTEM_PROMPT + "\n\n" + leadContext;

    // Chama o Claude com timeout
    const claudePromise = anthropic.messages.create({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: fullSystemPrompt,
      messages: conversationMessages.length > 0
        ? conversationMessages
        : [{ role: "user", content: payload.last_message || "oi" }],
    });

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), TIMEOUT_MS)
    );

    const response = await Promise.race([claudePromise, timeoutPromise]);

    // Extrai texto da resposta
    const responseText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("");

    console.log(`[Claude respondeu em ${Date.now() - startTime}ms]`);

    // Parseia a resposta JSON do Claude
    let claudeData;
    try {
      claudeData = parseClaudeResponse(responseText);
    } catch (parseError) {
      console.error("Erro ao parsear resposta do Claude:", parseError.message);
      console.error("Resposta bruta:", responseText);

      // Fallback: usa o texto bruto como resposta
      claudeData = {
        reply: responseText.substring(0, 500),
        lead_state: payload.lead_state,
        lead_updates: {},
        action: "continue",
        handoff_reason: null,
        internal_notes: "Erro no parse - resposta bruta usada",
      };
    }

    // Atualiza historico com a resposta do assistant
    const updatedHistory = [...conversationMessages];
    updatedHistory.push({
      role: "assistant",
      content: claudeData.reply,
    });

    // Mantém apenas as ultimas 10
    const trimmedHistory = updatedHistory.slice(-10);

    // Monta resposta para o ManyChat
    const manychatResponse = buildManyChatResponse(claudeData, trimmedHistory);

    console.log(`Action: ${claudeData.action} | New State: ${claudeData.lead_state}`);
    console.log(`Resposta: ${claudeData.reply.substring(0, 100)}...`);

    return res.json(manychatResponse);

  } catch (error) {
    console.error("ERRO no webhook:", error.message);

    // Resposta de fallback para nao deixar o lead sem resposta
    const fallbackResponse = {
      version: "v2",
      content: {
        messages: [
          {
            type: "text",
            text: "Oi! Deixa eu verificar uma coisa aqui e ja te respondo, ta? Me manda sua duvida de novo em alguns minutinhos 😊",
          },
        ],
        actions: [
          {
            action: "add_tag",
            tag_name: "erro_webhook",
          },
        ],
      },
    };

    return res.json(fallbackResponse);
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  console.log(`\n🚀 SDR Amanda Mecenas - Webhook rodando na porta ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/webhook`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 API Key configurada: ${process.env.ANTHROPIC_API_KEY ? "SIM" : "⚠️  NAO - configure a ANTHROPIC_API_KEY"}`);
  console.log(`🔗 Link pagamento: ${LINK_PAGAMENTO}`);
  console.log("-------------------------------------------\n");
});
