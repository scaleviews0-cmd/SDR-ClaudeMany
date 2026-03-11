# SDR Automatizado - Amanda Mecenas | Comunidade Scale

Webhook que integra ManyChat + Claude para atuar como SDR automatizado no Instagram Direct.

## Setup

1. Clone o repositório
2. Rode `npm install`
3. Crie o arquivo `.env` com suas variáveis (veja `.env` de exemplo)
4. Rode `npm start`

## Variáveis de Ambiente

| Variável | Descrição |
|----------|-----------|
| `ANTHROPIC_API_KEY` | Sua chave da API do Claude |
| `PORT` | Porta do servidor (padrão: 3000) |
| `LINK_PAGAMENTO` | Link de checkout da Comunidade Scale |

## Endpoints

- `GET /` — Status do servidor
- `GET /health` — Health check
- `POST /webhook` — Recebe mensagens do ManyChat

## Deploy no Railway

1. Conecte este repo no Railway
2. Adicione as variáveis de ambiente no painel
3. O Railway faz deploy automático a cada push
