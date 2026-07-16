require('dotenv').config();
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const cron = require('node-cron');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

// ========== CONFIGURAÇÃO ==========
const botToken = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;
const utmifyMcpUrl = process.env.UTMIFY_MCP_URL;
const facebookAccessToken = process.env.FACEBOOK_ACCESS_TOKEN;
const geminiApiKey = process.env.GEMINI_API_KEY;

if (!botToken || !chatId || !utmifyMcpUrl || !geminiApiKey) {
  console.error("ERRO: Configure as credenciais no arquivo .env antes de rodar o bot.");
  process.exit(1);
}

const bot = new TelegramBot(botToken, { polling: true });

// Registro de alterações passadas no dia para acompanhamento (em memória)
// Formato: { [campaignId]: { lastChangeTimeStr: "09:01", timestamp: 123456, salesAtChange: 3, profitAtChange: 50.00, budgetCents: 6000 } }
const historyLogs = {};

// Helper para formatar horário em Brasília (HH:MM)
function formatTimeSP(date = new Date()) {
  return date.toLocaleTimeString("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit"
  });
}

// ========== REGRAS DO GEMINI / ENGINE LOCAL ==========
const RULES_PROMPT = `
Você é um Gestor de Tráfego de Direct Response (Resposta Direta) de alta performance.
Sua moeda padrão é o Dólar ($).
IMPORTANTE: Todos os valores monetários vêm em CENTAVOS da API. Converta para dólares dividindo por 100.

Analise os dados de cada CAMPANHA (level="campaign") no dia de hoje e sugira alterações de orçamento com base nestas REGRAS RÍGIDAS:

1. ESCALA INICIAL (Aumento de 50%):
   - Mínimo de 3 vendas aprovadas hoje (approvedOrdersCount >= 3).
   - ROAS do dia >= 1.8.
   - Ação: "Aumentar 50%".

2. ESCALA CONSECUTIVA (Aumento de 50% após aumento recente):
   - Se a campanha teve um aumento nas últimas 2 horas, ela só escala novamente se:
     * O ROAS continuou >= 1.8.
     * Acumulou no mínimo 3 NOVAS vendas adicionais desde o momento do último aumento.
   - Ação: "Aumentar 50%".

3. STOP LOSS SEGURO (Campanhas ruins sem vendas):
   - Gasto hoje (spend/100) >= $8.00 E 0 vendas aprovadas (approvedOrdersCount == 0).
   - Ação: "Reduzir 50%".

4. AJUSTE DE ROAS BAIXO (Campanhas com vendas ruins):
   - Campanha tem vendas aprovadas (pelo menos 1), mas o ROAS está < 1.3.
   - Gasto acumulado hoje (spend/100) de pelo menos $12.00.
   - Ação: "Reduzir 30%".

Se nenhuma dessas regras for atendida, recomende "Manter".
`;

// ========== UTMIFY MCP (LEITURA) ==========

async function connectUtmifyMcp() {
  try {
    console.log("   Conectando ao MCP da Utmify via Streamable HTTP...");
    const transport = new StreamableHTTPClientTransport(new URL(utmifyMcpUrl));
    const client = new Client({ name: "gestor-ai-bot", version: "1.0.0" });
    await client.connect(transport);
    console.log("✅ Conectado ao MCP da Utmify!");
    return client;
  } catch (error) {
    console.error("❌ Erro ao conectar ao MCP da Utmify:", error.message);
    return null;
  }
}

async function callMcpTool(client, toolName, args = {}) {
  try {
    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.content && result.content.length > 0) {
      const textContent = result.content.find(c => c.type === 'text');
      if (textContent) {
        try { return JSON.parse(textContent.text); }
        catch { return textContent.text; }
      }
    }
    return result;
  } catch (error) {
    console.error(`Erro na ferramenta MCP '${toolName}':`, error.message);
    return null;
  }
}

async function getDashboardId(client) {
  const dashboards = await callMcpTool(client, 'get_dashboards');
  if (!dashboards || !Array.isArray(dashboards) || dashboards.length === 0) {
    console.log("❌ Nenhum dashboard encontrado na Utmify.");
    return null;
  }
  const dashboard = dashboards[0];
  console.log(`📊 Dashboard encontrado: "${dashboard.name}" (ID: ${dashboard.id}, Moeda: ${dashboard.currency})`);
  return dashboard.id;
}

function getBrasiliaDateRange() {
  const now = new Date();
  const spDateStr = now.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  
  const fromISO = `${spDateStr}T03:00:00.000Z`;
  const tomorrow = new Date(new Date(`${spDateStr}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000);
  const tomStr = tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const toISO = `${tomStr}T02:59:59.999Z`;

  return { from: fromISO, to: toISO };
}

async function getCampaignData(client, dashboardId) {
  const dateRange = getBrasiliaDateRange();
  console.log(`🔍 Buscando dados Meta Ads (${dateRange.from} até ${dateRange.to})...`);

  const data = await callMcpTool(client, 'get_meta_ad_objects', {
    dashboardId: dashboardId,
    dateRange: dateRange,
    level: 'campaign'
  });

  if (!data || !data.results) {
    console.log("❌ Nenhum dado de campanha recebido da Utmify.");
    return [];
  }

  const activeCampaigns = data.results.filter(c =>
    c.level === 'campaign' && (c.effectiveStatus === 'ACTIVE' || c.status === 'ACTIVE')
  );

  console.log(`✅ ${activeCampaigns.length} campanha(s) ativa(s) encontrada(s).`);

  for (const c of activeCampaigns) {
    const spend = (c.spend / 100).toFixed(2);
    const revenue = (c.revenue / 100).toFixed(2);
    const profit = ((c.revenue - c.spend) / 100).toFixed(2);
    const roas = c.roas !== null && c.roas !== undefined ? c.roas.toFixed(2) : '0.00';
    const budget = c.dailyBudget ? (c.dailyBudget / 100).toFixed(2) : 'N/A';
    console.log(`   📌 ${c.name} | Gasto: $${spend} | Vendas: ${c.approvedOrdersCount} | Lucro: $${profit} | ROAS: ${roas} | Orçamento: $${budget}`);
  }

  return activeCampaigns;
}

// ========== FACEBOOK ADS API (ESCRITA) ==========

async function updateCampaignBudget(campaignId, newBudgetCents) {
  if (!facebookAccessToken || facebookAccessToken === 'seu_token_do_facebook_aqui') {
    console.log(`⚠️ Facebook Token não configurado. Simulando alteração para $${(newBudgetCents / 100).toFixed(2)}`);
    return true;
  }
  try {
    const url = `https://graph.facebook.com/v19.0/${campaignId}`;
    await axios.post(url, {
      daily_budget: newBudgetCents,
      access_token: facebookAccessToken
    });
    return true;
  } catch (error) {
    console.error(`Erro Facebook API (campanha ${campaignId}):`, error.response ? error.response.data : error.message);
    return false;
  }
}

// ========== ENGINE LOCAL DE REGRAS DE TRÁFEGO ==========

function evaluateLocalRules(campaignsData, hourlyHistory = { profitByHour: {}, salesByHour: {} }) {
  const recommendations = [];

  for (const c of campaignsData) {
    const spendUSD = (c.spend || 0) / 100;
    const approvedSales = c.approvedOrdersCount || 0;
    const revenueUSD = (c.revenue || 0) / 100;
    const profitUSD = revenueUSD - spendUSD;
    const roas = c.roas !== null && c.roas !== undefined ? c.roas : (spendUSD > 0 ? revenueUSD / spendUSD : 0);

    const currentBudgetCents = c.dailyBudget || 1000;
    const currentBudgetUSD = currentBudgetCents / 100;

    let acaoSugerida = "Manter";
    let tagAcao = "";
    let newBudgetCents = currentBudgetCents;
    let motivo = "";

    const history = historyLogs[c.id];
    const lastChangeStr = history ? history.lastChangeTimeStr : "Nenhuma hoje";
    const nowSPHour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
    
    // Lucro histórico de 5 dias para a hora atual
    const histProfitCents = hourlyHistory.profitByHour[nowSPHour] || 0;
    const isWeakHistoricalHour = histProfitCents < 0; // Ex: 06h, 07h, 09h, 10h
    const isPeakHistoricalHour = nowSPHour >= 12 && nowSPHour <= 15; // 12h às 15h

    // 1 e 2: Escala (Aumentar 50%) -> Mínimo 3 vendas e ROAS >= 1.8 (Permitido somente até as 19:00)
    if (approvedSales >= 3 && roas >= 1.8) {
      if (nowSPHour >= 19) {
        console.log(`ℹ️ Campanha "${c.name}" elegível para escala, porém suspensa por trava noturna (após 19:00).`);
      } else {
        const now = Date.now();
        const peakExtraText = isPeakHistoricalHour ? " (janela de pico)" : "";
        if (history && (now - history.timestamp < 2 * 60 * 60 * 1000)) {
          const newSales = approvedSales - (history.salesAtChange || 0);
          const newProfit = profitUSD - (history.profitAtChange || 0);
          if (newSales >= 3) {
            acaoSugerida = "Aumentar 50%";
            tagAcao = "+50%";
            newBudgetCents = Math.round(currentBudgetCents * 1.5);
            motivo = `escala${peakExtraText}: +${newSales} vendas e +$${newProfit.toFixed(2)} de lucro desde o aumento das ${history.lastChangeTimeStr}`;
          }
        } else {
          acaoSugerida = "Aumentar 50%";
          tagAcao = "+50%";
          newBudgetCents = Math.round(currentBudgetCents * 1.5);
          motivo = `escala inicial${peakExtraText}: +${approvedSales} vendas e +$${profitUSD.toFixed(2)} de lucro hoje`;
        }
      }
    }
    // 3: Stop Loss (Reduzir 50%) -> Gasto >= $8.00 e 0 Vendas
    else if (spendUSD >= 8.00 && approvedSales === 0) {
      // Filtro de Tolerância: Se for um horário de prejuízo recorrente histórico (ex: 09h-10h) e o gasto estiver < $12.00, tolera 1 ciclo
      if (isWeakHistoricalHour && spendUSD < 12.00) {
        console.log(`🛡️ Tolerância de Horário Histórico: Campanha "${c.name}" gastou $${spendUSD.toFixed(2)} às ${nowSPHour}:00h (horário historicamente fraco), aguardando recuperação no pico.`);
      } else {
        acaoSugerida = "Reduzir 50%";
        tagAcao = "-50%";
        newBudgetCents = Math.round(currentBudgetCents * 0.5);
        motivo = `stop loss: $${spendUSD.toFixed(2)} gastos sem nenhuma venda hoje`;
      }
    }
    // 4: Ajuste ROAS Baixo (Reduzir 30%) -> Tem vendas, ROAS < 1.3 e Gasto >= $12.00
    else if (approvedSales >= 1 && roas < 1.3 && spendUSD >= 12.00) {
      acaoSugerida = "Reduzir 30%";
      tagAcao = "-30%";
      newBudgetCents = Math.round(currentBudgetCents * 0.7);
      motivo = `roas baixo: ${approvedSales} venda(s), Faturamento $${revenueUSD.toFixed(2)}, ROAS ${roas.toFixed(2)} < 1.3 e gasto de $${spendUSD.toFixed(2)}`;
    }

    if (acaoSugerida !== "Manter") {
      recommendations.push({
        id: c.id,
        nome: c.name,
        tagAcao: tagAcao,
        acaoSugerida: acaoSugerida,
        spendUSD: spendUSD,
        profitUSD: profitUSD,
        roas: roas,
        lastChangeStr: lastChangeStr,
        orcamentoAtualCentavos: currentBudgetCents,
        orcamentoNovoCentavos: newBudgetCents,
        orcamentoAtualDolares: currentBudgetUSD,
        orcamentoNovoDolares: newBudgetCents / 100,
        approvedSales: approvedSales,
        motivo: motivo
      });
    }
  }
  return { campanhas: recommendations };
}

async function getGeminiAnalysis(campaignsData) {
  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiApiKey}`,
      {
        contents: [{
          parts: [
            { text: RULES_PROMPT },
            { text: `Dados das campanhas ativas hoje:\n${JSON.stringify(campaignsData, null, 2)}` }
          ]
        }],
        generationConfig: { responseMimeType: "application/json" }
      }
    );
    return JSON.parse(response.data.candidates[0].content.parts[0].text);
  } catch (error) {
    console.log("⚡ Executando regras via Engine Local determinística...");
    return evaluateLocalRules(campaignsData);
  }
}

// ========== PROCESSAMENTO PRINCIPAL ==========

async function runCampaignCheck() {
  const now = new Date();
  const hour = now.getHours();

  if (hour >= 23 || hour < 8) {
    console.log("😴 Modo silencioso (madrugada). Sem envios.");
    return;
  }

  console.log(`\n[${now.toLocaleTimeString()}] ====== INICIANDO ANÁLISE DE CAMPANHAS ======`);

  const mcpClient = await connectUtmifyMcp();
  if (!mcpClient) return;

  try {
    const dashboardId = await getDashboardId(mcpClient);
    if (!dashboardId) return;

    const campaigns = await getCampaignData(mcpClient, dashboardId);
    if (campaigns.length === 0) {
      console.log("Nenhuma campanha ativa encontrada.");
      return;
    }

    // PASSO 4: Buscar histórico de 5 dias de lucro por hora para tolerância inteligente
    const today = new Date();
    const todayStr = today.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const fiveDaysAgo = new Date(today.getTime() - 5 * 24 * 60 * 60 * 1000);
    const fiveDaysStr = fiveDaysAgo.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

    const summaryRes = await callMcpTool(mcpClient, 'get_dashboard_summary', {
      dashboardId: dashboardId,
      dateRange: { from: `${fiveDaysStr}T03:00:00.000Z`, to: `${todayStr}T02:59:59.999Z` }
    });

    const hourlyHistory = { profitByHour: {}, salesByHour: {} };
    if (summaryRes && summaryRes.profitByHourNet) {
      for (const item of summaryRes.profitByHourNet) {
        hourlyHistory.profitByHour[item.hour] = item.cents;
      }
    }
    if (summaryRes && summaryRes.ordersCount && summaryRes.ordersCount.byHour) {
      for (const item of summaryRes.ordersCount.byHour) {
        hourlyHistory.salesByHour[item.hour] = item.count;
      }
    }

    // PASSO 5: Processar análise de regras de tráfego com filtro de histórico
    console.log("🧠 Processando análise de regras de tráfego (com filtro de histórico de 5 dias)...");
    const analysis = evaluateLocalRules(campaigns, hourlyHistory);

    if (!analysis.campanhas || analysis.campanhas.length === 0) {
      console.log("✅ Nenhuma campanha precisa de alteração de orçamento no momento.");
      return;
    }

    // PASSO 5: Enviar sugestões via Telegram exatamente no layout solicitado pelo usuário
    for (const item of analysis.campanhas) {
      if (item.acaoSugerida === 'Manter') continue;

      let emojiHeader = '🔴';
      if (item.tagAcao === '+50%') emojiHeader = '🟢';

      const formattedBudgetAtual = Math.round(item.orcamentoAtualDolares);
      const formattedBudgetNovo = Math.round(item.orcamentoNovoDolares);

      const message = `${emojiHeader} ${item.tagAcao}\n` +
        `Campanha: ${item.nome}\n` +
        `Gasto: $${item.spendUSD.toFixed(2)}\n` +
        `Lucro: $${item.profitUSD.toFixed(2)}\n` +
        `ROAS: ${item.roas.toFixed(2)}\n` +
        `Última alteração: ${item.lastChangeStr}\n` +
        `Ação sugerida: ${item.acaoSugerida}: $${formattedBudgetAtual} → $${formattedBudgetNovo}\n` +
        `Motivo: ${item.motivo}`;

      const opts = {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Aprovar', callback_data: `approve_${item.id}_${item.orcamentoNovoCentavos}_${item.approvedSales}_${item.profitUSD.toFixed(2)}` },
            { text: '❌ Não', callback_data: `reject_${item.id}` }
          ]]
        }
      };

      await bot.sendMessage(chatId, message, opts);
      console.log(`📨 Sugestão enviada para "${item.nome}": ${item.tagAcao}`);
    }
  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }
}

// ========== TELEGRAM CALLBACKS ==========

bot.on('callback_query', async (callbackQuery) => {
  const data = callbackQuery.data;
  const message = callbackQuery.message;

  if (data.startsWith('approve_')) {
    const parts = data.split('_');
    const campaignId = parts[1];
    const newBudgetCents = parseInt(parts[2]);
    const sales = parseInt(parts[3] || '0');
    const profit = parseFloat(parts[4] || '0');

    await bot.answerCallbackQuery(callbackQuery.id, { text: "Alterando orçamento no Facebook Ads..." });

    const success = await updateCampaignBudget(campaignId, newBudgetCents);

    if (success) {
      historyLogs[campaignId] = {
        lastChangeTimeStr: formatTimeSP(),
        timestamp: Date.now(),
        salesAtChange: sales,
        profitAtChange: profit,
        budgetCents: newBudgetCents
      };

      await bot.editMessageText(
        `${message.text}\n\n✅ *Aprovado e aplicado no Meta Ads!*`,
        { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown' }
      );
    } else {
      await bot.sendMessage(message.chat.id, `⚠️ Erro ao aplicar orçamento no Facebook (campanha: ${campaignId}).`);
    }
  } else if (data.startsWith('reject_')) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Sugestão não aprovada." });
    await bot.editMessageText(
      `${message.text}\n\n❌ *Não aprovado.*`,
      { chat_id: message.chat.id, message_id: message.message_id, parse_mode: 'Markdown' }
    );
  }
});

// ========== RESET NOTURNO (23:55 Brasília) ==========

cron.schedule('55 23 * * *', async () => {
  console.log("\n🛡️ ====== PROTEÇÃO NOTURNA (23:55 BRASÍLIA) ======");

  const mcpClient = await connectUtmifyMcp();
  if (!mcpClient) return;

  try {
    const dashboardId = await getDashboardId(mcpClient);
    if (!dashboardId) return;

    const campaigns = await getCampaignData(mcpClient, dashboardId);
    const report = [];

    for (const c of campaigns) {
      const roas = c.roas || 0;
      let targetBudgetCents = c.dailyBudget || 1000;

      if (roas > 1.8) {
        targetBudgetCents = Math.min(targetBudgetCents, 3000); // Max $30
      } else if (roas >= 1.3) {
        targetBudgetCents = 2000; // $20
      } else {
        targetBudgetCents = 1000; // $10
      }

      if (targetBudgetCents !== c.dailyBudget) {
        const success = await updateCampaignBudget(c.id, targetBudgetCents);
        if (success) {
          report.push(`🔄 *${c.name}* → $${(targetBudgetCents / 100).toFixed(2)} (ROAS: ${roas.toFixed(2)})`);
        }
      }
    }

    const msg = report.length > 0
      ? `🛡️ *Proteção Noturna (23:55)*\n\n${report.join('\n')}`
      : `🛡️ *Proteção Noturna:* Nenhuma campanha precisou de reajuste.`;

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }

  Object.keys(historyLogs).forEach(k => delete historyLogs[k]);
}, { timezone: "America/Sao_Paulo" });

// ========== AGENDAMENTO INTELIGENTE (HORÁRIO DE BRASÍLIA) ==========
// 08:00 às 16:00 -> A cada 2 horas (08:00, 10:00, 12:00, 14:00, 16:00)
// 18:00 às 22:00 -> A cada 1 hora (18:00, 19:00, 20:00, 21:00, 22:00) para defesa rápida
cron.schedule('0 8-16/2,18-22 * * *', () => {
  runCampaignCheck();
}, { timezone: "America/Sao_Paulo" });

console.log("🤖 Robô Gestor AI ativo!");
console.log("   📖 Leitura: Utmify MCP (vendas reais via checkout)");
console.log("   ✏️ Escrita: Facebook Ads API (alteração de orçamento)");
console.log("   ⏰ Verificação: 2h de dia (08h-16h) e 1h à noite (18h-22h).");
console.log("   🔒 Trava de Escala: Aumentos de +50% suspensos após 19:00.");
console.log("   🛡️ Reset noturno: 23:55 (Horário de Brasília).");
console.log("");

// Rodar verificação inicial
runCampaignCheck();
