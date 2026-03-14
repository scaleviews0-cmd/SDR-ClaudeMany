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
const MANYCHAT_API_TOKEN = process.env.MANYCHAT_API_TOKEN;
const PORT = process.env.PORT || 3000;
const TIMEOUT_MS = 25000;

// ============================================================
// MANYCHAT API - ATUALIZAR CAMPOS DIRETO
// ============================================================

/**
 * BUSCA os dados atuais do lead no ManyChat via API
 * Isso garante que temos os dados mais recentes, mesmo que o Body do ManyChat nao envie
 */
async function getManyChatSubscriber(subscriberId) {
  if (!MANYCHAT_API_TOKEN || !subscriberId) return null;

  try {
    const response = await fetch(`https://api.manychat.com/fb/subscriber/getInfo?subscriber_id=${subscriberId}`, {
      method: "GET",
      headers: {
        "Authorization": `Bearer ${MANYCHAT_API_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    if (response.ok) {
      const data = await response.json();
      if (data.status === "success" && data.data) {
        const subscriber = data.data;
        const fields = {};

        // Extrair custom fields do subscriber
        if (subscriber.custom_fields) {
          for (const field of subscriber.custom_fields) {
            if (field.name && field.value !== null && field.value !== undefined) {
              fields[field.name] = String(field.value);
            }
          }
        }

        console.log(`[ManyChat] Dados do subscriber ${subscriberId} carregados:`, Object.keys(fields).filter(k => fields[k] && fields[k] !== "").length, "campos preenchidos");
        return fields;
      }
    } else {
      const errorBody = await response.text().catch(() => "");
      console.warn(`[ManyChat] Erro ao buscar subscriber ${subscriberId}:`, response.status, errorBody);
    }
  } catch (error) {
    console.warn(`[ManyChat] Erro ao buscar subscriber:`, error.message);
  }

  return null;
}

/**
 * Atualiza um Custom Field do lead no ManyChat via API
 */
async function setManyChatField(subscriberId, fieldName, value) {
  if (!MANYCHAT_API_TOKEN || !subscriberId || !value || value === "null") return;

  try {
    const response = await fetch("https://api.manychat.com/fb/subscriber/setCustomField", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MANYCHAT_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriber_id: Number(subscriberId),
        field_name: fieldName,
        field_value: String(value),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text().catch(() => "");
      console.warn(`ManyChat API erro ao setar ${fieldName}:`, response.status, errorBody);
    }
  } catch (error) {
    console.warn(`ManyChat API erro ao setar ${fieldName}:`, error.message);
  }
}

/**
 * Adiciona uma tag ao lead no ManyChat via API
 */
async function addManyChatTag(subscriberId, tagName) {
  if (!MANYCHAT_API_TOKEN || !subscriberId) return;

  try {
    const response = await fetch("https://api.manychat.com/fb/subscriber/addTagByName", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${MANYCHAT_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        subscriber_id: Number(subscriberId),
        tag_name: tagName,
      }),
    });

    if (!response.ok) {
      console.warn(`ManyChat API erro ao adicionar tag ${tagName}:`, response.status);
    }
  } catch (error) {
    console.warn(`ManyChat API erro ao adicionar tag ${tagName}:`, error.message);
  }
}

/**
 * Atualiza todos os campos do lead no ManyChat baseado na resposta do Claude
 */
async function updateManyChatLead(subscriberId, claudeData) {
  if (!subscriberId || !MANYCHAT_API_TOKEN) {
    console.warn("Sem subscriber_id ou MANYCHAT_API_TOKEN - pulando atualizacao ManyChat");
    return;
  }

  const updates = [];

  // Atualiza lead_state
  if (claudeData.lead_state) {
    updates.push(setManyChatField(subscriberId, "lead_state", claudeData.lead_state));
  }

  // Atualiza campos do lead
  if (claudeData.lead_updates) {
    const fields = claudeData.lead_updates;
    for (const [key, value] of Object.entries(fields)) {
      if (value && value !== "null" && value !== null) {
        updates.push(setManyChatField(subscriberId, key, value));
      }
    }
  }

  // Adiciona tags baseadas na acao
  if (claudeData.action === "handoff") {
    updates.push(addManyChatTag(subscriberId, "handoff_solicitado"));
  }
  if (claudeData.action === "send_link") {
    updates.push(addManyChatTag(subscriberId, "link_enviado"));
    updates.push(addManyChatTag(subscriberId, "lead_quente"));
  }
  if (claudeData.lead_updates?.lead_temperatura === "quente") {
    updates.push(addManyChatTag(subscriberId, "lead_quente"));
  }
  if (claudeData.lead_state === "objecao") {
    // Incrementar objecao_count - pegar valor atual + 1
    updates.push(setManyChatField(subscriberId, "objecao_count", String((claudeData.current_objecao_count || 0) + 1)));
  }

  // Executa todas as atualizacoes em paralelo
  await Promise.allSettled(updates);
  console.log(`[ManyChat] ${updates.length} campos atualizados para subscriber ${subscriberId}`);
}

// ============================================================
// FUNCOES AUXILIARES
// ============================================================

/**
 * Monta o historico de conversa para enviar ao Claude
 */
function buildConversationMessages(payload) {
  let history = [];

  try {
    if (payload.conversation_history && payload.conversation_history !== "[]" && payload.conversation_history !== "") {
      history = JSON.parse(payload.conversation_history);
    }
  } catch (e) {
    console.warn("Erro ao parsear conversation_history:", e.message);
    history = [];
  }

  if (payload.last_message) {
    history.push({
      role: "user",
      content: payload.last_message,
    });
  }

  if (history.length > 10) {
    history = history.slice(-10);
  }

  return history;
}

/**
 * Monta o contexto dinamico do lead para injetar no prompt
 */
function buildLeadContext(payload) {
  // Aceita tanto formato aninhado (lead_profile.nome) quanto flat (lead_nome)
  const profile = payload.lead_profile || {};
  const nome = profile.nome || payload.lead_nome || "";
  const nicho = profile.nicho || payload.lead_nicho || "";
  const faturamento = profile.faturamento || payload.lead_faturamento || "";
  const dor = profile.dor_principal || payload.lead_dor_principal || "";
  const desejo = profile.desejo || payload.lead_desejo || "";
  const objecao = profile.objecao || payload.lead_objecao || "";
  const temperatura = profile.temperatura || payload.lead_temperatura || "frio";
  const empresas = payload.lead_empresas || "";
  const produtosServicos = payload.lead_produtos_servicos || "";
  const tamanhoEquipe = payload.lead_tamanho_equipe || "";
  const redesSociais = payload.lead_redes_sociais || "";
  const objetivoCurto = payload.lead_objetivo_curto || "";
  const objetivoLongo = payload.lead_objetivo_longo || "";
  const ferramentas = payload.lead_ferramentas || "";
  const historicoAmanda = payload.lead_historico_amanda || "";

  return `
# CONTEXTO DO LEAD (DADOS ATUAIS - MEMORIA)

## Dados Basicos
- Estado atual do funil: ${payload.lead_state || "novo"}
- Nome: ${nome || "Nao informado"}
- Nome no Instagram: ${payload.user_name || "Nao informado"}
- Temperatura: ${temperatura}
- Contador de objecoes: ${payload.objecao_count || 0}
- Fonte de entrada: ${payload.fonte_entrada || "Nao informado"}

## Perfil Profissional
- Nicho/Segmento: ${nicho || "Nao informado"}
- Empresas: ${empresas || "Nao informado"}
- Produtos/Servicos que vende: ${produtosServicos || "Nao informado"}
- Faturamento: ${faturamento || "Nao informado"}
- Tamanho da equipe: ${tamanhoEquipe || "Nao informado"}
- Redes sociais/canais: ${redesSociais || "Nao informado"}
- Ferramentas que usa: ${ferramentas || "Nao informado"}

## Dores e Desejos
- Dor principal: ${dor || "Nao informado"}
- Desejo principal: ${desejo || "Nao informado"}
- Objetivo curto prazo: ${objetivoCurto || "Nao informado"}
- Objetivo longo prazo: ${objetivoLongo || "Nao informado"}
- Ultima objecao: ${objecao || "Nenhuma"}

## Historico com Amanda
- Compras/interacoes anteriores: ${historicoAmanda || "Nao informado"}

# INSTRUCAO PARA ESTA MENSAGEM

Responda a ultima mensagem do lead considerando todo o contexto acima e o historico da conversa. Use as informacoes da memoria para PERSONALIZAR sua resposta. Lembre-se: responda APENAS com o JSON no formato especificado, nada mais.

${payload.lead_state === "novo" || payload.lead_state === "saudacao" || !payload.lead_state
    ? "ATENCAO: Esta e a primeira interacao ou o lead acabou de responder a saudacao. Seja acolhedor(a) e inicie a qualificacao de forma natural. VARIE a saudacao."
    : ""
}

${(payload.objecao_count || 0) >= 2
    ? "ATENCAO: O lead ja apresentou objecoes " + payload.objecao_count + " vezes. Se apresentar a mesma objecao novamente, faca handoff humano."
    : ""
}
`.trim();
}

/**
 * Parseia a resposta do Claude (que deve ser JSON)
 */
function parseClaudeResponse(text) {
  let clean = text.trim();
  if (clean.startsWith("```json")) clean = clean.slice(7);
  if (clean.startsWith("```")) clean = clean.slice(3);
  if (clean.endsWith("```")) clean = clean.slice(0, -3);
  clean = clean.trim();
  return JSON.parse(clean);
}

// ============================================================
// ROTAS
// ============================================================

/**
 * Health check
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
    const payload = req.body || {};

    console.log("\n========================================");
    console.log(`[${new Date().toISOString()}] Nova mensagem recebida`);
    console.log(`User: ${payload.user_name || "?"} | ID: ${payload.user_id || "?"} | State: ${payload.lead_state || "novo"}`);
    console.log(`Mensagem: ${payload.last_message || "(vazio)"}`);
    console.log("========================================");

    // Se nao tem mensagem e nao e lead novo, resposta padrao
    if (!payload.last_message && payload.lead_state && payload.lead_state !== "novo") {
      return res.json({
        version: "v2",
        content: {
          messages: [{ type: "text", text: "Oi! Como posso te ajudar?" }],
          actions: [],
        },
      });
    }

    // Se for lead novo sem mensagem, inicia saudacao
    if (!payload.lead_state || payload.lead_state === "novo") {
      payload.lead_state = "saudacao";
      if (!payload.last_message) {
        payload.last_message = "(follow-back - primeiro contato)";
      }
    }

    // BUSCA DADOS ATUALIZADOS DO LEAD NO MANYCHAT (garante memoria)
    const subscriberId = payload.user_id;
    if (subscriberId && MANYCHAT_API_TOKEN) {
      const savedFields = await getManyChatSubscriber(subscriberId);
      if (savedFields) {
        // Preenche o payload com os dados salvos (prioridade para dados do ManyChat)
        const fieldMapping = [
          "lead_nome", "lead_nicho", "lead_faturamento", "lead_dor_principal",
          "lead_desejo", "lead_objecao", "lead_temperatura", "lead_state",
          "lead_empresas", "lead_produtos_servicos", "lead_tamanho_equipe",
          "lead_redes_sociais", "lead_objetivo_curto", "lead_objetivo_longo",
          "lead_ferramentas", "lead_historico_amanda", "conversation_history",
          "objecao_count", "fonte_entrada", "sdr_resposta"
        ];
        for (const field of fieldMapping) {
          if (savedFields[field] && savedFields[field] !== "" && savedFields[field] !== "null") {
            payload[field] = savedFields[field];
          }
        }
        // Usar lead_state do ManyChat se existir e nao for vazio
        if (savedFields.lead_state && savedFields.lead_state !== "" && savedFields.lead_state !== "novo") {
          payload.lead_state = savedFields.lead_state;
        }
        console.log(`[Memoria] Lead state: ${payload.lead_state} | Nome: ${payload.lead_nome || "?"} | Nicho: ${payload.lead_nicho || "?"}`);
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

      claudeData = {
        reply: responseText.substring(0, 500),
        lead_state: payload.lead_state,
        lead_updates: {},
        action: "continue",
        handoff_reason: null,
        internal_notes: "Erro no parse - resposta bruta usada",
      };
    }

    // Guarda o count atual para incrementar
    claudeData.current_objecao_count = parseInt(payload.objecao_count) || 0;

    // ATUALIZA CAMPOS NO MANYCHAT VIA API (sem precisar de mapeamento)
    const subscriberId = payload.user_id;
    if (subscriberId && MANYCHAT_API_TOKEN) {
      // Atualiza historico da conversa
      const updatedHistory = [...conversationMessages];
      updatedHistory.push({ role: "assistant", content: claudeData.reply });
      const trimmedHistory = updatedHistory.slice(-10);

      // Seta conversation_history no ManyChat
      await setManyChatField(subscriberId, "conversation_history", JSON.stringify(trimmedHistory));

      // Atualiza todos os outros campos
      await updateManyChatLead(subscriberId, claudeData);
    }

    // Monta resposta simples para o ManyChat (so a mensagem)
    let replyText = claudeData.reply || "Oi! Me da um instante que ja te respondo.";
    replyText = replyText.replace(/\[LINK\]/g, LINK_PAGAMENTO);

    // SALVA A RESPOSTA NO CAMPO sdr_resposta PARA O MANYCHAT ENVIAR
    if (subscriberId && MANYCHAT_API_TOKEN) {
      await setManyChatField(subscriberId, "sdr_resposta", replyText);
      console.log(`[ManyChat] sdr_resposta atualizado para subscriber ${subscriberId}`);
    }

    // ENVIA A MENSAGEM DIRETO PELA API DO MANYCHAT (sem depender do bloco Dinâmico)
    if (subscriberId && MANYCHAT_API_TOKEN) {
      try {
        const sendResponse = await fetch("https://api.manychat.com/fb/sending/sendContent", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${MANYCHAT_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            subscriber_id: Number(subscriberId),
            data: {
              version: "v2",
              content: {
                type: "instagram",
                messages: [
                  {
                    type: "text",
                    text: replyText,
                  },
                ],
              },
            },
          }),
        });
        if (sendResponse.ok) {
          console.log(`[ManyChat] Mensagem enviada diretamente ao lead!`);
        } else {
          const errorBody = await sendResponse.text().catch(() => "");
          console.warn(`[ManyChat] Erro ao enviar mensagem:`, sendResponse.status, errorBody);
        }
      } catch (sendError) {
        console.warn(`[ManyChat] Erro ao enviar mensagem:`, sendError.message);
      }
    }

    console.log(`Action: ${claudeData.action} | New State: ${claudeData.lead_state}`);
    console.log(`Resposta: ${replyText.substring(0, 100)}...`);

    // Retorna a mensagem tambem na resposta (caso o ManyChat use)
    return res.json({
      version: "v2",
      content: {
        messages: [
          {
            type: "text",
            text: replyText,
          },
        ],
        actions: [],
      },
    });

  } catch (error) {
    console.error("ERRO no webhook:", error.message);

    return res.json({
      version: "v2",
      content: {
        messages: [
          {
            type: "text",
            text: "Oi! Deixa eu verificar uma coisa aqui e ja te respondo, ta? Me manda sua duvida de novo em alguns minutinhos 😊",
          },
        ],
        actions: [],
      },
    });
  }
});

// ============================================================
// INICIAR SERVIDOR
// ============================================================

app.listen(PORT, () => {
  console.log(`\n🚀 SDR Amanda Mecenas - Webhook rodando na porta ${PORT}`);
  console.log(`📡 Endpoint: http://localhost:${PORT}/webhook`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 API Key Claude: ${process.env.ANTHROPIC_API_KEY ? "SIM" : "⚠️  NAO"}`);
  console.log(`🔑 API Token ManyChat: ${MANYCHAT_API_TOKEN ? "SIM" : "⚠️  NAO"}`);
  console.log(`🔗 Link pagamento: ${LINK_PAGAMENTO}`);
  console.log("-------------------------------------------\n");
});
