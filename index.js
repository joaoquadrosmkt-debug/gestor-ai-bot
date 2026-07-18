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

// ========== SERVIDOR HTTP PARA MANTER STATUS LIVE NO RENDER ==========
const http = require('http');
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('🤖 Gestor AI Bot está rodando 24/7 com sucesso!\n');
}).listen(port, () => {
  console.log(`🌐 Servidor HTTP ativo na porta ${port}`);
});

const fs = require('fs');

// Registro de alterações passadas no dia para acompanhamento
const HISTORY_FILE = './historyLogs.json';
let historyLogs = {};
try {
  if (fs.existsSync(HISTORY_FILE)) {
    historyLogs = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  }
} catch (e) {
  console.error("Erro ao ler history", e);
}

function saveHistory() {
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyLogs, null, 2));
  } catch (e) {
    console.error("Erro ao salvar history", e);
  }
}

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

function getBrasiliaDateRange(fromOffsetDays = 0, toOffsetDays = undefined) {
  if (toOffsetDays === undefined) toOffsetDays = fromOffsetDays;
  
  const fromDate = new Date(new Date().getTime() + fromOffsetDays * 24 * 60 * 60 * 1000);
  const toDate = new Date(new Date().getTime() + toOffsetDays * 24 * 60 * 60 * 1000);

  const spFromDateStr = fromDate.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const spToDateStr = toDate.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  
  const fromISO = `${spFromDateStr}T03:00:00.000Z`;
  const tomorrow = new Date(new Date(`${spToDateStr}T00:00:00-03:00`).getTime() + 24 * 60 * 60 * 1000);
  const tomStr = tomorrow.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
  const toISO = `${tomStr}T02:59:59.999Z`;

  return { from: fromISO, to: toISO };
}

async function getCampaignData(client, dashboardId, fromOffsetDays = 0, toOffsetDays = undefined) {
  const dateRange = getBrasiliaDateRange(fromOffsetDays, toOffsetDays);
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

async function updateCampaignStatus(campaignId, statusStr) {
  if (!facebookAccessToken || facebookAccessToken === 'seu_token_do_facebook_aqui') {
    console.log(`⚠️ Facebook Token não configurado. Simulando status ${statusStr} na campanha ${campaignId}`);
    return true;
  }
  try {
    const url = `https://graph.facebook.com/v19.0/${campaignId}`;
    await axios.post(url, {
      status: statusStr,
      access_token: facebookAccessToken
    });
    return true;
  } catch (error) {
    console.error(`Erro Facebook API (status ${campaignId}):`, error.response ? error.response.data : error.message);
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

    const nowSPHour = parseInt(new Date().toLocaleTimeString("en-US", { timeZone: "America/Sao_Paulo", hour: "2-digit", hour12: false }));
    const isPrimeTime = nowSPHour >= 18 && nowSPHour < 23;
    const cooldownLimit = isPrimeTime ? 1.0 : 1.75;

    let hoursSince = 0;
    const history = historyLogs[c.id];
    if (history) {
      hoursSince = (Date.now() - history.timestamp) / (1000 * 60 * 60);
      // Tolerância para respiro
      if (hoursSince < cooldownLimit) {
        console.log(`⏳ Campanha "${c.name}" ignorada (em período de respiro de ${cooldownLimit}h. Alterada há ${hoursSince.toFixed(1)}h).`);
        continue;
      }
    }

    const lastChangeStr = history ? history.lastChangeTimeStr : "Nenhuma hoje";
    
    // Lucro histórico de 7 dias para a hora atual
    const histProfitCents = hourlyHistory.profitByHour[nowSPHour] || 0;
    const isWeakHistoricalHour = histProfitCents < 0; // Ex: 06h, 07h, 09h, 10h
    const isPeakHistoricalHour = histProfitCents > 0; // Horário que dá lucro na média dos 7 dias é considerado pico

    // Regra Pós-Escala: Se o bot aumentou o orçamento nas últimas horas, verificar se a performance despencou
    let handledPostScale = false;
    if (history && history.action === 'Aumentar' && hoursSince >= cooldownLimit) {
      const newProfit = profitUSD - (history.profitAtChange || 0);
      if (roas < 1.3 || (newProfit < 0 && spendUSD >= 10.00)) {
        acaoSugerida = "Reduzir 30%";
        tagAcao = "-30%";
        newBudgetCents = Math.round(currentBudgetCents * 0.7);
        motivo = `Alerta pós-escala: o ROAS ou lucro caiu nas últimas ${hoursSince.toFixed(1)}h após a mudança do orçamento (Lucro novo: $${newProfit.toFixed(2)}).`;
        handledPostScale = true;
      }
    }

    if (!handledPostScale) {
      // 1 e 2: Escala (Aumentar 50%) -> Mínimo 3 vendas e ROAS >= 1.8 (Permitido somente até as 19:00)
      if (approvedSales >= 3 && roas >= 1.8) {
        if (nowSPHour >= 19) {
          console.log(`ℹ️ Campanha "${c.name}" elegível para escala, porém suspensa por trava noturna (após 19:00).`);
        } else {
          const peakExtraText = isPeakHistoricalHour ? " (janela de pico)" : "";
          if (history) {
            const newSales = approvedSales - (history.salesAtChange || 0);
            const newProfit = profitUSD - (history.profitAtChange || 0);
            if (newSales >= 3) {
              const proposedBudgetCents = Math.min(Math.round(currentBudgetCents * 1.5), 20000); // Teto máximo de $200.00
              if (proposedBudgetCents > currentBudgetCents) {
                acaoSugerida = "Aumentar 50%";
                tagAcao = "+50%";
                newBudgetCents = proposedBudgetCents;
                motivo = `escala consecutiva${peakExtraText}: aumento sugerido pois desde a ultima atualização às ${history.lastChangeTimeStr} teve ${newSales} vendas novas e lucro de $${newProfit.toFixed(2)}`;
              }
            }
          } else {
            const proposedBudgetCents = Math.min(Math.round(currentBudgetCents * 1.5), 20000); // Teto máximo de $200.00
            if (proposedBudgetCents > currentBudgetCents) {
              acaoSugerida = "Aumentar 50%";
              tagAcao = "+50%";
              newBudgetCents = proposedBudgetCents;
              motivo = `escala inicial${peakExtraText}: +${approvedSales} vendas e +$${profitUSD.toFixed(2)} de lucro hoje`;
            }
          }
        }
      }
      // 3: Stop Loss (Reduzir 50%) -> Gasto >= $8.00 e 0 Vendas
      else if (spendUSD >= 8.00 && approvedSales === 0) {
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

async function runCampaignCheck(isManual = false) {
  const now = new Date();
  const hour = now.getHours();

  if (!isManual && (hour >= 23 || hour < 8)) {
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

    // PASSO 4: Buscar histórico de 7 dias de lucro por hora para tolerância inteligente
    const today = new Date();
    const todayStr = today.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });
    const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
    const sevenDaysStr = sevenDaysAgo.toLocaleDateString("en-CA", { timeZone: "America/Sao_Paulo" });

    const summaryRes = await callMcpTool(mcpClient, 'get_dashboard_summary', {
      dashboardId: dashboardId,
      dateRange: { from: `${sevenDaysStr}T03:00:00.000Z`, to: `${todayStr}T02:59:59.999Z` }
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
      if (isManual) {
        await bot.sendMessage(chatId, "✅ Tudo tranquilo! Nenhuma campanha precisa de alteração de orçamento no momento.");
      }
      return;
    }

    // PASSO 5: Enviar sugestões para TODAS as ações
    for (const item of analysis.campanhas) {
      if (item.acaoSugerida === 'Manter') continue;

      const formattedBudgetAtual = item.orcamentoAtualDolares.toFixed(2);
      const formattedBudgetNovo = item.orcamentoNovoDolares.toFixed(2);
      const isScale = item.acaoSugerida.includes('Aumentar');
      const actionTag = isScale ? 'Aumentar' : 'Reduzir';

      const message = `${isScale ? '🟢' : '🔴'} ${item.tagAcao}\n` +
        `Campanha: ${item.nome}\n` +
        `Gasto: $${item.spendUSD.toFixed(2)}\n` +
        `Lucro: $${item.profitUSD.toFixed(2)}\n` +
        `ROAS: ${item.roas.toFixed(2)}\n` +
        `Última alteração: ${item.lastChangeStr}\n` +
        `Ação sugerida: ${item.acaoSugerida}: $${formattedBudgetAtual} → $${formattedBudgetNovo}\n` +
        `Motivo: ${item.motivo}`;

      let inline_keyboard = [];
      if (isScale) {
        const budget30 = Math.min(Math.round(item.orcamentoAtualCentavos * 1.3), 20000);
        const budget50 = Math.min(Math.round(item.orcamentoAtualCentavos * 1.5), 20000);
        const budget100 = Math.min(Math.round(item.orcamentoAtualCentavos * 2.0), 20000);
        
        inline_keyboard = [
          [
            { text: '✅ +30%', callback_data: `approve_${item.id}_${budget30}_${item.approvedSales}_${item.profitUSD.toFixed(2)}_${actionTag}` },
            { text: '🚀 +50%', callback_data: `approve_${item.id}_${budget50}_${item.approvedSales}_${item.profitUSD.toFixed(2)}_${actionTag}` },
            { text: '🔥 +100%', callback_data: `approve_${item.id}_${budget100}_${item.approvedSales}_${item.profitUSD.toFixed(2)}_${actionTag}` }
          ],
          [{ text: '❌ Ignorar', callback_data: `reject_${item.id}` }]
        ];
      } else {
        inline_keyboard = [
          [
            { text: '✅ Aprovar', callback_data: `approve_${item.id}_${item.orcamentoNovoCentavos}_${item.approvedSales}_${item.profitUSD.toFixed(2)}_${actionTag}` },
            { text: '❌ Não', callback_data: `reject_${item.id}` }
          ]
        ];
      }

      const opts = {
        reply_markup: {
          inline_keyboard: inline_keyboard
        }
      };

      await bot.sendMessage(chatId, message, opts);
      console.log(`📨 Sugestão de ação enviada para aprovação: "${item.nome}"`);
    }
  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }
}

// ========== COMANDOS DO TELEGRAM ==========

bot.onText(/\/analisar/, async (msg) => {
  const chatIdMsg = msg.chat.id;
  if (chatIdMsg.toString() !== chatId.toString()) return;
  
  await bot.sendMessage(chatIdMsg, "⏳ Rodando análise instantânea das campanhas no Facebook Ads...");
  await runCampaignCheck(true);
});

bot.onText(/\/reset/, async (msg) => {
  const chatIdMsg = msg.chat.id;
  if (chatIdMsg.toString() !== chatId.toString()) return;

  await bot.sendMessage(chatIdMsg, "⏳ Forçando Proteção Noturna manualmente...");
  
  const mcpClient = await connectUtmifyMcp();
  if (!mcpClient) return;

  try {
    const dashboardId = await getDashboardId(mcpClient);
    if (!dashboardId) return;

    const campaigns = await getCampaignData(mcpClient, dashboardId);
    const report = [];
    let errorCount = 0;

    for (const c of campaigns) {
      const roas = c.roas || 0;
      const spendUSD = (c.spend || 0) / 100;
      const sales = c.approvedOrdersCount || 0;
      let targetBudgetCents = c.dailyBudget || 1000;

      // Regra de tolerância: não julgar se gastou muito pouco
      if (sales === 0 && spendUSD < 8.00) continue;
      if (sales > 0 && roas < 1.3 && spendUSD < 12.00) continue;

      if (roas > 1.8) targetBudgetCents = Math.min(targetBudgetCents, 3000);
      else if (roas >= 1.3) targetBudgetCents = 2000;
      else targetBudgetCents = 1000;

      if (targetBudgetCents !== c.dailyBudget) {
        const success = await updateCampaignBudget(c.id, targetBudgetCents);
        if (success) {
          report.push(`🔄 *${c.name}* → $${(targetBudgetCents / 100).toFixed(2)} (ROAS: ${roas.toFixed(2)})`);
        } else {
          errorCount++;
          report.push(`❌ *FALHOU:* ${c.name} (Erro na API do Facebook)`);
        }
      }
    }

    let msgRet = "";
    if (report.length > 0) {
      msgRet = `🛡️ *Proteção Noturna MANUAL*\n\n${report.join('\n')}`;
      if (errorCount > 0) msgRet += `\n\n⚠️ Tivemos ${errorCount} erro(s) de permissão com o Facebook. Verifique o Token!`;
    } else {
      msgRet = `🛡️ *Proteção Noturna MANUAL:* Nenhuma campanha precisou de reajuste.`;
    }

    await bot.sendMessage(chatIdMsg, msgRet, { parse_mode: 'Markdown' });
  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }
});

bot.onText(/\/resetontem/, async (msg) => {
  const chatIdMsg = msg.chat.id;
  if (chatIdMsg.toString() !== chatId.toString()) return;

  await bot.sendMessage(chatIdMsg, "⏳ Forçando Proteção Noturna (COM OS DADOS DE ONTEM)...");
  
  const mcpClient = await connectUtmifyMcp();
  if (!mcpClient) return;

  try {
    const dashboardId = await getDashboardId(mcpClient);
    if (!dashboardId) return;

    // Passar offsetDays = -1 para pegar ontem
    const campaigns = await getCampaignData(mcpClient, dashboardId, -1);
    const report = [];
    let errorCount = 0;

    for (const c of campaigns) {
      const roas = c.roas || 0;
      const spendUSD = (c.spend || 0) / 100;
      const sales = c.approvedOrdersCount || 0;
      let targetBudgetCents = c.dailyBudget || 1000;

      // Regra de tolerância: não julgar se gastou muito pouco
      if (sales === 0 && spendUSD < 8.00) continue;
      if (sales > 0 && roas < 1.3 && spendUSD < 12.00) continue;

      if (roas > 1.8) targetBudgetCents = Math.min(targetBudgetCents, 3000);
      else if (roas >= 1.3) targetBudgetCents = 2000;
      else targetBudgetCents = 1000;

      if (targetBudgetCents !== c.dailyBudget) {
        const success = await updateCampaignBudget(c.id, targetBudgetCents);
        if (success) {
          report.push(`🔄 *${c.name}* → $${(targetBudgetCents / 100).toFixed(2)} (ROAS: ${roas.toFixed(2)})`);
        } else {
          errorCount++;
          report.push(`❌ *FALHOU:* ${c.name} (Erro na API do Facebook)`);
        }
      }
    }

    let msgRet = "";
    if (report.length > 0) {
      msgRet = `🛡️ *Proteção Noturna MANUAL (Dados de Ontem)*\n\n${report.join('\n')}`;
      if (errorCount > 0) msgRet += `\n\n⚠️ Tivemos ${errorCount} erro(s) de permissão com o Facebook. Verifique o Token!`;
    } else {
      msgRet = `🛡️ *Proteção Noturna MANUAL (Ontem):* Nenhuma campanha precisou de reajuste.`;
    }

    await bot.sendMessage(chatIdMsg, msgRet, { parse_mode: 'Markdown' });
  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }
});

bot.onText(/\/resumo/, async (msg) => {
  const chatIdMsg = msg.chat.id;
  
  // Apenas responder se for o dono do bot
  if (chatIdMsg.toString() !== chatId.toString()) return;

  await bot.sendMessage(chatIdMsg, "⏳ Buscando dados ao vivo da Utmify...");

  const mcpClient = await connectUtmifyMcp();
  if (!mcpClient) {
    return bot.sendMessage(chatIdMsg, "❌ Erro ao conectar na Utmify.");
  }

  try {
    const dashboardId = await getDashboardId(mcpClient);
    if (!dashboardId) return bot.sendMessage(chatIdMsg, "❌ Erro ao buscar dashboard.");

    const campaigns = await getCampaignData(mcpClient, dashboardId);
    
    // Buscar Totais Globais (inclusive vendas não rastreadas)
    const dateRangeToday = getBrasiliaDateRange();
    const summaryRes = await callMcpTool(mcpClient, 'get_dashboard_summary', {
      dashboardId: dashboardId,
      dateRange: dateRangeToday
    });

    let totalSpend = 0;
    let sumCampaignsRevenue = 0;
    let sumCampaignsSales = 0;

    for (const c of campaigns) {
      totalSpend += (c.spend || 0) / 100;
      sumCampaignsRevenue += (c.revenue || 0) / 100;
      sumCampaignsSales += (c.approvedOrdersCount || 0);
    }

    let totalRevenue = sumCampaignsRevenue;
    let totalSales = sumCampaignsSales;
    let pendingSales = 0;

    if (summaryRes) {
       // Puxamos faturamento e vendas da Utmify (para incluir as não rastreadas)
       const dashRevenue = (summaryRes.revenue || 0) / 100;
       
       // Importante: usar apenas vendas APROVADAS (approved ou paid) para não misturar com boletos pendentes!
       let dashApprovedSales = sumCampaignsSales;
       if (summaryRes.ordersCount) {
         dashApprovedSales = summaryRes.ordersCount.approved !== undefined ? summaryRes.ordersCount.approved : 
                            (summaryRes.ordersCount.paid !== undefined ? summaryRes.ordersCount.paid : summaryRes.ordersCount.total);
         
         pendingSales = summaryRes.ordersCount.pending || summaryRes.ordersCount.waitingPayment || 0;
       }
       
       // Só substitui se o dashboard tiver um valor maior
       if (dashRevenue >= sumCampaignsRevenue) totalRevenue = dashRevenue;
       if (dashApprovedSales >= sumCampaignsSales) totalSales = dashApprovedSales;
    }
    
    if (campaigns.length === 0 && totalSales === 0) {
      return bot.sendMessage(chatIdMsg, "Nenhum dado rodando hoje.");
    }

    let summaryText = "📊 *RESUMO DAS CAMPANHAS HOJE*\n\n";

    if (campaigns.length > 0) {
      for (const c of campaigns) {
        const spend = (c.spend || 0) / 100;
        const revenue = (c.revenue || 0) / 100;
        const profit = revenue - spend;
        const roas = c.roas || (spend > 0 ? revenue / spend : 0);
        const sales = c.approvedOrdersCount || 0;

        const emoji = profit >= 0 ? "🟢" : "🔴";
        summaryText += `${emoji} *${c.name}*\n`;
        summaryText += `Gasto: $${spend.toFixed(2)} | Fat: $${revenue.toFixed(2)}\n`;
        summaryText += `Lucro: $${profit.toFixed(2)} | ROAS: ${roas.toFixed(2)}\n\n`;
      }
    } else {
      summaryText += "_Nenhuma campanha ativa._\n\n";
    }

    const totalProfit = totalRevenue - totalSpend;
    const totalRoas = totalSpend > 0 ? (totalRevenue / totalSpend) : 0;
    const totalEmoji = totalProfit >= 0 ? "✅" : "⚠️";
    const untrackedSales = totalSales - sumCampaignsSales;

    summaryText += `🏆 *TOTAL GERAL*\n`;
    summaryText += `Vendas Aprovadas: ${totalSales}\n`;
    if (untrackedSales > 0) {
      summaryText += `👻 Vendas Não Rastreadas: ${untrackedSales}\n`;
    }
    if (pendingSales > 0) {
      summaryText += `⏳ Vendas Pendentes (Pix/Boleto): ${pendingSales}\n`;
    }
    summaryText += `Gasto Total: $${totalSpend.toFixed(2)}\n`;
    summaryText += `Faturamento Total: $${totalRevenue.toFixed(2)}\n`;
    summaryText += `${totalEmoji} *Lucro Total: $${totalProfit.toFixed(2)}*\n`;
    summaryText += `📈 *ROAS Médio: ${totalRoas.toFixed(2)}*\n`;

    await bot.sendMessage(chatIdMsg, summaryText, { parse_mode: 'Markdown' });

  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }
});

bot.onText(/\/status/, async (msg) => {
  const chatIdMsg = msg.chat.id;
  if (chatIdMsg.toString() !== chatId.toString()) return;

  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setHours(now.getHours() + 1, 0, 0, 0);
  
  let msgStatus = `🤖 *Status do Gestor AI*\n\n`;
  msgStatus += `🕒 *Próxima análise:* ${nextHour.toLocaleTimeString("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" })}\n\n`;
  msgStatus += `ℹ️ *Por que não recebi mensagens há mais de uma hora?*\n`;
  msgStatus += `O robô roda silenciosamente a cada hora cheia (das 08h às 22h). Ele **só envia mensagem** se alguma campanha precisar de alteração (Escala ou Stop Loss/Redução). Se nenhuma regra for atingida, ele simplesmente mantém os orçamentos e não envia notificações para evitar spam.`;

  await bot.sendMessage(chatIdMsg, msgStatus, { parse_mode: 'Markdown' });
});

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
    const actionTag = parts[5] || 'Aumentar';

    await bot.answerCallbackQuery(callbackQuery.id, { text: "Alterando orçamento no Facebook Ads..." });

    const success = await updateCampaignBudget(campaignId, newBudgetCents);

    if (success) {
      historyLogs[campaignId] = {
        lastChangeTimeStr: formatTimeSP(),
        timestamp: Date.now(),
        salesAtChange: sales,
        profitAtChange: profit,
        budgetCents: newBudgetCents,
        action: actionTag
      };
      saveHistory();

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

// ========== RESET NOTURNO (23:58 Brasília) ==========

cron.schedule('58 23 * * *', async () => {
  console.log("\n🛡️ ====== PROTEÇÃO NOTURNA (23:58 BRASÍLIA) ======");

  const mcpClient = await connectUtmifyMcp();
  if (!mcpClient) return;

  try {
    const dashboardId = await getDashboardId(mcpClient);
    if (!dashboardId) return;

    // Buscar campanhas de hoje para ajustar orçamentos (como antes)
    const campaignsToday = await getCampaignData(mcpClient, dashboardId, 0);
    // Buscar campanhas dos ÚLTIMOS 2 DIAS para regra de Pausa
    const campaigns2Days = await getCampaignData(mcpClient, dashboardId, -1, 0);

    const report = [];
    let errorCount = 0;

    // Criar um mapa do ROAS dos últimos 2 dias para fácil acesso
    const roas2DaysMap = {};
    for (const c of campaigns2Days) {
      roas2DaysMap[c.id] = c.roas || 0;
    }

    for (const c of campaignsToday) {
      const roasToday = c.roas || 0;
      const spendUSD = (c.spend || 0) / 100;
      const sales = c.approvedOrdersCount || 0;
      const roas2Days = roas2DaysMap[c.id] !== undefined ? roas2DaysMap[c.id] : roasToday;
      let targetBudgetCents = c.dailyBudget || 1000;

      // === SOLUÇÃO MANUAL: TAG [HOLD] ===
      // Se a campanha tiver [HOLD] ou [IGNORAR] no nome, o bot pula ela completamente
      if (c.name.toUpperCase().includes('[HOLD]') || c.name.toUpperCase().includes('[IGNORAR]')) {
        report.push(`✋ *${c.name}* → IGNORADA (Tag [HOLD] detectada)`);
        continue;
      }

      // Se a campanha esteve com ROAS < 1.3 na janela dos últimos 2 dias somados, PAUSA ELA
      if (roas2Days < 1.3 && spendUSD >= 5.00) {
        const success = await updateCampaignStatus(c.id, 'PAUSED');
        if (success) {
          report.push(`⏸️ *${c.name}* → PAUSADA (ROAS 2 Dias: ${roas2Days.toFixed(2)})`);
        } else {
          errorCount++;
          report.push(`❌ *FALHOU:* ${c.name} (Erro na API do Facebook ao pausar)`);
        }
        continue; // Pula o ajuste de orçamento já que foi pausada
      }

      // Regra de tolerância: não julgar se gastou muito pouco hoje
      if (sales === 0 && spendUSD < 8.00) continue;
      if (sales > 0 && roasToday < 1.3 && spendUSD < 12.00) continue;

      // === SOLUÇÃO AUTOMÁTICA: ROAS 2 DIAS ===
      // Protege a campanha de cair o orçamento se a média dos últimos 2 dias estiver excelente, 
      // mesmo que hoje (roasToday) tenha sido um dia instável/ruim.
      if (roasToday > 1.8 || roas2Days > 1.8) {
        targetBudgetCents = Math.min(targetBudgetCents, 3000); // Max $30
      } else if (roasToday >= 1.3 || roas2Days >= 1.3) {
        targetBudgetCents = 2000; // $20
      } else {
        targetBudgetCents = 1000; // $10
      }

      if (targetBudgetCents !== c.dailyBudget) {
        const success = await updateCampaignBudget(c.id, targetBudgetCents);
        if (success) {
          report.push(`🔄 *${c.name}* → $${(targetBudgetCents / 100).toFixed(2)} (ROAS Hoje: ${roasToday.toFixed(2)})`);
        } else {
          errorCount++;
          report.push(`❌ *FALHOU:* ${c.name} (Erro na API do Facebook)`);
        }
      }
    }

    let msg = "";
    if (report.length > 0) {
      msg = `🛡️ *Proteção Noturna (23:55)*\n\n${report.join('\n')}`;
      if (errorCount > 0) {
        msg += `\n\n⚠️ Tivemos ${errorCount} erro(s) de permissão com o Facebook. Verifique o Token!`;
      }
    } else {
      msg = `🛡️ *Proteção Noturna:* Nenhuma campanha precisou de reajuste.`;
    }

    // Calcular fechamento do caixa
    let totalSpendUSD = 0;
    let totalRevenueUSD = 0;
    let bestCampaign = { name: 'Nenhuma', roas: 0, profit: 0 };

    for (const c of campaignsToday) {
      const spend = (c.spend || 0) / 100;
      const rev = (c.revenue || 0) / 100;
      const profit = rev - spend;
      const roasToday = spend > 0 ? rev / spend : 0;
      
      totalSpendUSD += spend;
      totalRevenueUSD += rev;

      if (profit > bestCampaign.profit) {
        bestCampaign = { name: c.name, roas: roasToday, profit: profit };
      }
    }
    const totalProfitUSD = totalRevenueUSD - totalSpendUSD;
    const globalRoas = totalSpendUSD > 0 ? totalRevenueUSD / totalSpendUSD : 0;

    const recapMsg = `\n\n📊 *FECHAMENTO DE CAIXA (HOJE)*\n` +
      `Investimento: $${totalSpendUSD.toFixed(2)}\n` +
      `Faturamento: $${totalRevenueUSD.toFixed(2)}\n` +
      `Lucro Líquido: $${totalProfitUSD.toFixed(2)}\n` +
      `ROAS Global: ${globalRoas.toFixed(2)}\n` +
      `🏆 Melhor campanha: ${bestCampaign.name} (Lucro: $${bestCampaign.profit.toFixed(2)}, ROAS: ${bestCampaign.roas.toFixed(2)})`;

    msg += recapMsg;

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
  } finally {
    try { await mcpClient.close(); } catch (e) { /* ignorar */ }
  }
  Object.keys(historyLogs).forEach(k => delete historyLogs[k]);
  saveHistory();
}, { timezone: "America/Sao_Paulo" });

// ========== AGENDAMENTO INTELIGENTE (HORÁRIO DE BRASÍLIA) ==========
// Roda toda hora cravada das 08h até as 22h
cron.schedule('0 8-22 * * *', () => {
  runCampaignCheck();
}, { timezone: "America/Sao_Paulo" });


console.log("🤖 Robô Gestor AI ativo!");
console.log("   📖 Leitura: Utmify MCP (vendas reais via checkout)");
console.log("   ✏️ Escrita: Facebook Ads API (alteração de orçamento)");
console.log("   ⏰ Verificação: A cada 1 hora (08h às 22h). Campanhas alteradas ganham 2h de respiro.");
console.log("   🔒 Trava de Escala: Aumentos de +50% suspensos após 19:00.");
console.log("   🛡️ Reset noturno: 23:55 (Horário de Brasília).");
console.log("");

// Rodar verificação inicial
runCampaignCheck();
