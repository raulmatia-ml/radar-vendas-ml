const ML_AUTHORIZE_URL =
  "https://auth.mercadolivre.com.br/authorization";

const ML_TOKEN_URL =
  "https://api.mercadolibre.com/oauth/token";

const ML_API_URL =
  "https://api.mercadolibre.com";

const MAX_ORDER_PAGES = 10;
const ORDERS_PER_PAGE = 50;

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);

      if (request.method !== "GET") {
        return new Response("Método não permitido.", {
          status: 405,
          headers: {
            Allow: "GET",
          },
        });
      }

      if (url.pathname === "/") {
        return htmlResponse(dashboardPage());
      }

      if (url.pathname === "/connect") {
        return startAuthorization(env);
      }

      if (url.pathname === "/oauth/callback") {
        return finishAuthorization(url, env);
      }

      if (url.pathname === "/status") {
        return connectionStatus(env);
      }

      if (url.pathname === "/api/account") {
        return accountData(env);
      }

      if (url.pathname === "/api/orders") {
        return recentOrders(env);
      }

      if (url.pathname === "/api/dashboard") {
        return dashboardData(url, env);
      }

      return new Response("Página não encontrada.", {
        status: 404,
      });
    } catch (error) {
      console.error("Erro no Worker:", error);

      if (
        new URL(request.url).pathname.startsWith("/api/") ||
        new URL(request.url).pathname === "/status"
      ) {
        return jsonResponse(
          {
            error: true,
            message:
              error?.message ||
              "Não foi possível concluir a consulta.",
          },
          500
        );
      }

      return htmlResponse(
        `
          <section class="simple-page">
            <h1>Não foi possível concluir</h1>
            <p>Ocorreu um erro interno na integração.</p>
            <p class="error">
              ${escapeHtml(
                error?.message || "Erro desconhecido."
              )}
            </p>
            <a class="primary-button" href="/">
              Voltar ao painel
            </a>
          </section>
        `,
        500
      );
    }
  },
};

async function startAuthorization(env) {
  validateConfiguration(env);

  const state = generateSecureState();

  await env.ML_TOKENS.put(
    `oauth_state:${state}`,
    JSON.stringify({
      createdAt: new Date().toISOString(),
    }),
    {
      expirationTtl: 600,
    }
  );

  const authorizationUrl = new URL(ML_AUTHORIZE_URL);

  authorizationUrl.searchParams.set(
    "response_type",
    "code"
  );

  authorizationUrl.searchParams.set(
    "client_id",
    env.ML_CLIENT_ID
  );

  authorizationUrl.searchParams.set(
    "redirect_uri",
    env.ML_REDIRECT_URI
  );

  authorizationUrl.searchParams.set("state", state);

  return Response.redirect(
    authorizationUrl.toString(),
    302
  );
}

async function finishAuthorization(url, env) {
  validateConfiguration(env);

  const oauthError = url.searchParams.get("error");

  if (oauthError) {
    const description =
      url.searchParams.get("error_description") ||
      "A autorização foi recusada ou cancelada.";

    return htmlResponse(
      `
        <section class="simple-page">
          <h1>Autorização não concluída</h1>
          <p>${escapeHtml(description)}</p>
          <a class="primary-button" href="/connect">
            Tentar novamente
          </a>
        </section>
      `,
      400
    );
  }

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) {
    return htmlResponse(
      `
        <section class="simple-page">
          <h1>Retorno inválido</h1>
          <p>
            O Mercado Livre não enviou todas as
            informações necessárias.
          </p>
          <a class="primary-button" href="/connect">
            Recomeçar autorização
          </a>
        </section>
      `,
      400
    );
  }

  const stateKey = `oauth_state:${state}`;
  const storedState = await env.ML_TOKENS.get(stateKey);

  if (!storedState) {
    return htmlResponse(
      `
        <section class="simple-page">
          <h1>Autorização expirada</h1>
          <p>O link expirou ou já foi utilizado.</p>
          <a class="primary-button" href="/connect">
            Gerar novo acesso
          </a>
        </section>
      `,
      400
    );
  }

  await env.ML_TOKENS.delete(stateKey);

  const tokenResponse = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      code,
      redirect_uri: env.ML_REDIRECT_URI,
    }),
  });

  const tokenData =
    await readJsonResponse(tokenResponse);

  if (!tokenResponse.ok) {
    console.error(
      "Erro devolvido pelo Mercado Livre:",
      tokenData
    );

    const safeMessage =
      tokenData.message ||
      tokenData.error_description ||
      tokenData.error ||
      "O Mercado Livre recusou a troca do código.";

    return htmlResponse(
      `
        <section class="simple-page">
          <h1>Falha ao conectar</h1>
          <p>${escapeHtml(safeMessage)}</p>
          <a class="primary-button" href="/connect">
            Tentar novamente
          </a>
        </section>
      `,
      400
    );
  }

  if (!tokenData.access_token) {
    throw new Error(
      "O Mercado Livre não devolveu um access token."
    );
  }

  const connectedAt = new Date().toISOString();
  const expiresIn = Number(
    tokenData.expires_in || 0
  );

  const expiresAt = expiresIn
    ? new Date(
        Date.now() + expiresIn * 1000
      ).toISOString()
    : null;

  const storedTokens = {
    ...tokenData,
    connected_at: connectedAt,
    expires_at: expiresAt,
  };

  await env.ML_TOKENS.put(
    "mercadolivre_tokens",
    JSON.stringify(storedTokens)
  );

  await env.ML_TOKENS.put(
    "mercadolivre_connection",
    JSON.stringify({
      connected: true,
      user_id: tokenData.user_id || null,
      connected_at: connectedAt,
      expires_at: expiresAt,
    })
  );

  return htmlResponse(`
    <section class="simple-page">
      <div class="success-icon">✓</div>
      <h1>Mercado Livre conectado!</h1>
      <p>
        A autorização foi recebida e armazenada
        com sucesso.
      </p>
      <div class="success-box">
        Conta identificada:
        ${escapeHtml(
          String(tokenData.user_id || "confirmada")
        )}
      </div>
      <a class="primary-button" href="/">
        Abrir o Radar de Vendas
      </a>
    </section>
  `);
}

async function connectionStatus(env) {
  validateConfiguration(env);

  const connection = await env.ML_TOKENS.get(
    "mercadolivre_connection",
    {
      type: "json",
    }
  );

  if (!connection?.connected) {
    return jsonResponse({
      connected: false,
      message:
        "Nenhuma conta do Mercado Livre foi conectada.",
    });
  }

  return jsonResponse({
    connected: true,
    user_id: connection.user_id,
    connected_at: connection.connected_at,
    refreshed_at: connection.refreshed_at || null,
    expires_at: connection.expires_at,
  });
}

async function getValidAccessToken(env) {
  validateConfiguration(env);

  const tokens = await env.ML_TOKENS.get(
    "mercadolivre_tokens",
    {
      type: "json",
    }
  );

  if (!tokens?.access_token) {
    throw new Error(
      "A conta ainda não foi conectada ao Mercado Livre."
    );
  }

  const expiresAt = tokens.expires_at
    ? new Date(tokens.expires_at).getTime()
    : 0;

  const fiveMinutes = 5 * 60 * 1000;

  if (expiresAt > Date.now() + fiveMinutes) {
    return tokens.access_token;
  }

  if (!tokens.refresh_token) {
    throw new Error(
      "Não existe refresh token armazenado. Reconecte a conta."
    );
  }

  const response = await fetch(ML_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type":
        "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: env.ML_CLIENT_ID,
      client_secret: env.ML_CLIENT_SECRET,
      refresh_token: tokens.refresh_token,
    }),
  });

  const refreshed =
    await readJsonResponse(response);

  if (!response.ok || !refreshed.access_token) {
    console.error(
      "Falha ao renovar token:",
      refreshed
    );

    throw new Error(
      refreshed.message ||
        refreshed.error_description ||
        "O Mercado Livre recusou a renovação automática."
    );
  }

  const refreshedAt = new Date().toISOString();
  const expiresIn = Number(
    refreshed.expires_in || 0
  );

  const newExpiresAt = expiresIn
    ? new Date(
        Date.now() + expiresIn * 1000
      ).toISOString()
    : null;

  const updatedTokens = {
    ...tokens,
    ...refreshed,
    refresh_token:
      refreshed.refresh_token ||
      tokens.refresh_token,
    user_id:
      refreshed.user_id ||
      tokens.user_id ||
      null,
    connected_at:
      tokens.connected_at || refreshedAt,
    refreshed_at: refreshedAt,
    expires_at: newExpiresAt,
  };

  await env.ML_TOKENS.put(
    "mercadolivre_tokens",
    JSON.stringify(updatedTokens)
  );

  await env.ML_TOKENS.put(
    "mercadolivre_connection",
    JSON.stringify({
      connected: true,
      user_id: updatedTokens.user_id,
      connected_at: updatedTokens.connected_at,
      refreshed_at: refreshedAt,
      expires_at: newExpiresAt,
    })
  );

  return updatedTokens.access_token;
}

async function mercadoLivreRequest(path, env) {
  const accessToken =
    await getValidAccessToken(env);

  const response = await fetch(
    `${ML_API_URL}${path}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
      },
    }
  );

  const data = await readJsonResponse(response);

  if (!response.ok) {
    console.error(
      "Erro na API do Mercado Livre:",
      data
    );

    throw new Error(
      data.message ||
        data.error_description ||
        "A consulta ao Mercado Livre não foi concluída."
    );
  }

  return data;
}

async function accountData(env) {
  const account = await mercadoLivreRequest(
    "/users/me",
    env
  );

  return jsonResponse({
    connected: true,
    user_id: account.id,
    nickname: account.nickname,
    site_id: account.site_id,
    country_id: account.country_id,
    seller_reputation: account.seller_reputation
      ? {
          level_id:
            account.seller_reputation.level_id ||
            null,
          power_seller_status:
            account.seller_reputation
              .power_seller_status || null,
        }
      : null,
  });
}

async function recentOrders(env) {
  const connection = await getConnection(env);

  const sellerId = encodeURIComponent(
    connection.user_id
  );

  const orders = await mercadoLivreRequest(
    `/orders/search?seller=${sellerId}&sort=date_desc&limit=10`,
    env
  );

  const results = Array.isArray(orders.results)
    ? orders.results
    : [];

  return jsonResponse({
    total_found:
      orders.paging?.total ?? results.length,
    returned: results.length,
    orders: results.map(formatOrder),
  });
}

async function dashboardData(url, env) {
  const connection = await getConnection(env);

  const period = normalizePeriod(
    url.searchParams.get("period")
  );

  const dates = getPeriodDates(
    period,
    url.searchParams.get("from"),
    url.searchParams.get("to")
  );

  const previousDates = getPreviousPeriodDates(
    dates.from,
    dates.to
  );

  const [account, currentResult, previousResult] =
    await Promise.all([
      mercadoLivreRequest("/users/me", env),
      fetchOrdersForPeriod(
        connection.user_id,
        dates.from,
        dates.to,
        env
      ),
      fetchOrdersForPeriod(
        connection.user_id,
        previousDates.from,
        previousDates.to,
        env
      ),
    ]);

  const current = calculateMetrics(
    currentResult.orders
  );

  const previous = calculateMetrics(
    previousResult.orders
  );

  const comparison = {
    revenue: calculateChange(
      current.revenue,
      previous.revenue
    ),
    orders: calculateChange(
      current.orderCount,
      previous.orderCount
    ),
    units: calculateChange(
      current.units,
      previous.units
    ),
    averageTicket: calculateChange(
      current.averageTicket,
      previous.averageTicket
    ),
  };

  return jsonResponse({
    connected: true,
    account: {
      id: account.id,
      nickname: account.nickname,
      reputation:
        account.seller_reputation?.level_id ||
        null,
      power_seller_status:
        account.seller_reputation
          ?.power_seller_status || null,
    },
    period: {
      type: period,
      from: dates.from.toISOString(),
      to: dates.to.toISOString(),
      previous_from:
        previousDates.from.toISOString(),
      previous_to:
        previousDates.to.toISOString(),
    },
    metrics: {
      revenue: current.revenue,
      orders: current.orderCount,
      units: current.units,
      average_ticket: current.averageTicket,
      paid_orders: current.paidOrders,
      cancelled_orders:
        current.cancelledOrders,
      pending_orders: current.pendingOrders,
      pending_shipments:
        current.pendingShipments,
    },
    comparison,
    sales_by_day: current.salesByDay,
    top_products: current.topProducts.slice(0, 8),
    recent_orders: current.recentOrders.slice(
      0,
      12
    ),
    collection: {
      current_orders_loaded:
        currentResult.orders.length,
      current_total_found:
        currentResult.total,
      current_truncated:
        currentResult.truncated,
    },
    modules: {
      questions: "Em configuração",
      claims: "Em configuração",
      stock: "Em configuração",
      listings: "Em configuração",
      visits: "Em configuração",
      conversion: "Em configuração",
      financial: "Em configuração",
      ads: "Aguardando acesso",
      profit: "Aguardando planilha de custos",
      intelligence: "Em configuração",
    },
    generated_at: new Date().toISOString(),
  });
}

async function getConnection(env) {
  const connection = await env.ML_TOKENS.get(
    "mercadolivre_connection",
    {
      type: "json",
    }
  );

  if (!connection?.connected) {
    throw new Error(
      "A conta ainda não foi conectada."
    );
  }

  if (!connection.user_id) {
    throw new Error(
      "Não foi possível identificar a conta conectada."
    );
  }

  return connection;
}

async function fetchOrdersForPeriod(
  userId,
  from,
  to,
  env
) {
  const orders = [];
  let offset = 0;
  let total = 0;

  for (
    let page = 0;
    page < MAX_ORDER_PAGES;
    page++
  ) {
    const params = new URLSearchParams({
      seller: String(userId),
      sort: "date_desc",
      limit: String(ORDERS_PER_PAGE),
      offset: String(offset),
      "order.date_created.from":
        from.toISOString(),
      "order.date_created.to":
        to.toISOString(),
    });

    const data = await mercadoLivreRequest(
      `/orders/search?${params.toString()}`,
      env
    );

    const pageOrders = Array.isArray(
      data.results
    )
      ? data.results
      : [];

    total = Number(
      data.paging?.total || pageOrders.length
    );

    orders.push(...pageOrders);

    offset += pageOrders.length;

    if (
      pageOrders.length < ORDERS_PER_PAGE ||
      offset >= total
    ) {
      break;
    }
  }

  return {
    orders,
    total,
    truncated: orders.length < total,
  };
}

function calculateMetrics(orders) {
  let revenue = 0;
  let units = 0;
  let paidOrders = 0;
  let cancelledOrders = 0;
  let pendingOrders = 0;
  let pendingShipments = 0;

  const productMap = new Map();
  const salesDayMap = new Map();

  const validOrders = orders.filter(
    (order) =>
      order.status !== "cancelled" &&
      order.status !== "invalid"
  );

  for (const order of orders) {
    if (order.status === "paid") {
      paidOrders++;
    } else if (order.status === "cancelled") {
      cancelledOrders++;
    } else {
      pendingOrders++;
    }

    if (needsShipping(order)) {
      pendingShipments++;
    }

    if (
      order.status === "cancelled" ||
      order.status === "invalid"
    ) {
      continue;
    }

    const orderValue = Number(
      order.paid_amount ??
        order.total_amount ??
        0
    );

    revenue += orderValue;

    const dateKey = getDateKey(
      order.date_created
    );

    if (!salesDayMap.has(dateKey)) {
      salesDayMap.set(dateKey, {
        date: dateKey,
        revenue: 0,
        orders: 0,
        units: 0,
      });
    }

    const day = salesDayMap.get(dateKey);
    day.revenue += orderValue;
    day.orders++;

    const orderItems = Array.isArray(
      order.order_items
    )
      ? order.order_items
      : [];

    for (const item of orderItems) {
      const quantity = Number(
        item.quantity || 0
      );

      const unitPrice = Number(
        item.unit_price || 0
      );

      units += quantity;
      day.units += quantity;

      const itemId =
        item.item?.id || "sem-id";

      const title =
        item.item?.title ||
        "Produto sem título";

      if (!productMap.has(itemId)) {
        productMap.set(itemId, {
          item_id: itemId,
          title,
          quantity: 0,
          revenue: 0,
          orders: 0,
        });
      }

      const product = productMap.get(itemId);

      product.quantity += quantity;
      product.revenue +=
        quantity * unitPrice;
      product.orders++;
    }
  }

  const orderCount = validOrders.length;

  const averageTicket = orderCount
    ? revenue / orderCount
    : 0;

  const salesByDay = Array.from(
    salesDayMap.values()
  ).sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  const topProducts = Array.from(
    productMap.values()
  ).sort((a, b) => {
    if (b.revenue !== a.revenue) {
      return b.revenue - a.revenue;
    }

    return b.quantity - a.quantity;
  });

  const recentOrders = [...orders]
    .sort(
      (a, b) =>
        new Date(b.date_created).getTime() -
        new Date(a.date_created).getTime()
    )
    .map(formatOrder);

  return {
    revenue: roundMoney(revenue),
    orderCount,
    units,
    averageTicket:
      roundMoney(averageTicket),
    paidOrders,
    cancelledOrders,
    pendingOrders,
    pendingShipments,
    salesByDay: salesByDay.map((day) => ({
      ...day,
      revenue: roundMoney(day.revenue),
    })),
    topProducts: topProducts.map(
      (product) => ({
        ...product,
        revenue: roundMoney(
          product.revenue
        ),
      })
    ),
    recentOrders,
  };
}

function formatOrder(order) {
  const items = Array.isArray(
    order.order_items
  )
    ? order.order_items
    : [];

  return {
    id: order.id,
    date_created: order.date_created,
    status: order.status,
    status_label: translateOrderStatus(
      order.status
    ),
    shipping_status:
      order.shipping?.status || null,
    needs_shipping: needsShipping(order),
    currency_id: order.currency_id || "BRL",
    total_amount: Number(
      order.total_amount || 0
    ),
    paid_amount: Number(
      order.paid_amount || 0
    ),
    item_count: items.reduce(
      (total, item) =>
        total + Number(item.quantity || 0),
      0
    ),
    items: items.map((item) => ({
      item_id: item.item?.id || null,
      title:
        item.item?.title ||
        "Produto sem título",
      quantity: Number(
        item.quantity || 0
      ),
      unit_price: Number(
        item.unit_price || 0
      ),
    })),
  };
}

function needsShipping(order) {
  if (order.status !== "paid") {
    return false;
  }

  const shippingStatus =
    order.shipping?.status || "";

  return [
    "pending",
    "handling",
    "ready_to_ship",
  ].includes(shippingStatus);
}

function translateOrderStatus(status) {
  const labels = {
    confirmed: "Confirmado",
    payment_required:
      "Aguardando pagamento",
    payment_in_process:
      "Pagamento em análise",
    partially_paid:
      "Parcialmente pago",
    paid: "Pago",
    cancelled: "Cancelado",
    invalid: "Inválido",
  };

  return labels[status] || status || "Desconhecido";
}

function getDateKey(value) {
  const date = new Date(value);

  const formatter = new Intl.DateTimeFormat(
    "en-CA",
    {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }
  );

  return formatter.format(date);
}

function normalizePeriod(period) {
  const allowed = [
    "today",
    "yesterday",
    "7d",
    "30d",
    "custom",
  ];

  return allowed.includes(period)
    ? period
    : "7d";
}

function getPeriodDates(period, fromValue, toValue) {
  const now = new Date();

  if (period === "custom") {
    const customFrom = parseDateInput(
      fromValue,
      false
    );

    const customTo = parseDateInput(
      toValue,
      true
    );

    if (
      !customFrom ||
      !customTo ||
      customFrom > customTo
    ) {
      throw new Error(
        "O período personalizado é inválido."
      );
    }

    return {
      from: customFrom,
      to: customTo,
    };
  }

  if (period === "today") {
    return {
      from: startOfBrazilDay(now),
      to: now,
    };
  }

  if (period === "yesterday") {
    const todayStart =
      startOfBrazilDay(now);

    const yesterdayStart = new Date(
      todayStart.getTime() -
        24 * 60 * 60 * 1000
    );

    return {
      from: yesterdayStart,
      to: new Date(todayStart.getTime() - 1),
    };
  }

  const days = period === "30d" ? 30 : 7;
  const from = startOfBrazilDay(now);

  from.setUTCDate(
    from.getUTCDate() - (days - 1)
  );

  return {
    from,
    to: now,
  };
}

function startOfBrazilDay(date) {
  const parts =
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Sao_Paulo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(date);

  return new Date(`${parts}T00:00:00-03:00`);
}

function parseDateInput(value, endOfDay) {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return null;
  }

  return new Date(
    `${value}T${
      endOfDay
        ? "23:59:59.999"
        : "00:00:00.000"
    }-03:00`
  );
}

function getPreviousPeriodDates(from, to) {
  const duration =
    to.getTime() - from.getTime() + 1;

  return {
    from: new Date(
      from.getTime() - duration
    ),
    to: new Date(from.getTime() - 1),
  };
}

function calculateChange(current, previous) {
  if (previous === 0) {
    return current === 0 ? 0 : null;
  }

  return Number(
    (
      ((current - previous) / previous) *
      100
    ).toFixed(1)
  );
}

function roundMoney(value) {
  return Number(Number(value).toFixed(2));
}

function validateConfiguration(env) {
  const required = [
    "ML_CLIENT_ID",
    "ML_CLIENT_SECRET",
    "ML_REDIRECT_URI",
    "ML_TOKENS",
  ];

  const missing = required.filter(
    (name) => !env[name]
  );

  if (missing.length) {
    throw new Error(
      `Configuração ausente: ${missing.join(", ")}`
    );
  }
}

function generateSecureState() {
  const randomBytes =
    crypto.getRandomValues(
      new Uint8Array(32)
    );

  return Array.from(randomBytes)
    .map((byte) =>
      byte.toString(16).padStart(2, "0")
    )
    .join("");
}

async function readJsonResponse(response) {
  const responseText =
    await response.text();

  if (!responseText) {
    return {};
  }

  try {
    return JSON.parse(responseText);
  } catch {
    return {
      message:
        "A API devolveu uma resposta que não pôde ser interpretada.",
    };
  }
}

function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,
      headers: {
        "Content-Type":
          "application/json; charset=UTF-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options":
          "nosniff",
        "Access-Control-Allow-Origin": "*",
      },
    }
  );
}

function dashboardPage() {
  return `
    <div class="app-shell">
      <aside class="sidebar" id="sidebar">
        <div class="brand">
          <div class="brand-mark">R</div>
          <div>
            <strong>Radar</strong>
            <span>Vendas Mercado Livre</span>
          </div>
        </div>

        <nav class="navigation">
          <button class="nav-item active">
            <span class="nav-icon">◫</span>
            Visão geral
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">↗</span>
            Vendas
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">▣</span>
            Envios
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">?</span>
            Perguntas
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">!</span>
            Reclamações
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">▤</span>
            Anúncios e estoque
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">$</span>
            Financeiro
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">◎</span>
            Mercado Ads
            <small>Em breve</small>
          </button>

          <button class="nav-item disabled">
            <span class="nav-icon">✦</span>
            Inteligência
            <small>Em breve</small>
          </button>
        </nav>

        <div class="sidebar-footer">
          <span class="status-dot"></span>
          <div>
            <strong>Conta conectada</strong>
            <span id="sidebar-account">
              Carregando...
            </span>
          </div>
        </div>
      </aside>

      <main class="main-content">
        <header class="topbar">
          <div class="topbar-title">
            <button
              class="mobile-menu"
              id="mobile-menu"
              aria-label="Abrir menu"
            >
              ☰
            </button>

            <div>
              <h1>Visão geral</h1>
              <p>
                Tudo o que está acontecendo na sua
                operação.
              </p>
            </div>
          </div>

          <div class="topbar-actions">
            <div class="last-update">
              Atualizado:
              <strong id="last-update">—</strong>
            </div>

            <button
              class="refresh-button"
              id="refresh-button"
            >
              <span id="refresh-icon">↻</span>
              Atualizar
            </button>
          </div>
        </header>

        <section class="filters">
          <button
            class="period-button"
            data-period="today"
          >
            Hoje
          </button>

          <button
            class="period-button"
            data-period="yesterday"
          >
            Ontem
          </button>

          <button
            class="period-button active"
            data-period="7d"
          >
            7 dias
          </button>

          <button
            class="period-button"
            data-period="30d"
          >
            30 dias
          </button>

          <button
            class="period-button"
            data-period="custom"
          >
            Personalizado
          </button>

          <div
            class="custom-period"
            id="custom-period"
          >
            <input
              type="date"
              id="custom-from"
              aria-label="Data inicial"
            >

            <span>até</span>

            <input
              type="date"
              id="custom-to"
              aria-label="Data final"
            >

            <button id="apply-custom">
              Aplicar
            </button>
          </div>
        </section>

        <section
          class="connection-warning hidden"
          id="connection-warning"
        >
          <div>
            <strong>
              Conta não conectada
            </strong>
            <p>
              Conecte sua conta para carregar os
              dados reais.
            </p>
          </div>

          <a href="/connect">
            Conectar ao Mercado Livre
          </a>
        </section>

        <section
          class="loading-panel"
          id="loading-panel"
        >
          <div class="loader"></div>
          <p>Buscando os dados da operação...</p>
        </section>

        <section
          class="dashboard-content hidden"
          id="dashboard-content"
        >
          <div class="metric-grid">
            <article class="metric-card">
              <div class="metric-top">
                <span class="metric-label">
                  Faturamento
                </span>
                <span class="metric-icon blue">
                  R$
                </span>
              </div>

              <strong
                class="metric-value"
                id="metric-revenue"
              >
                R$ 0,00
              </strong>

              <div
                class="metric-change"
                id="change-revenue"
              >
                —
              </div>
            </article>

            <article class="metric-card">
              <div class="metric-top">
                <span class="metric-label">
                  Pedidos
                </span>
                <span class="metric-icon green">
                  ▣
                </span>
              </div>

              <strong
                class="metric-value"
                id="metric-orders"
              >
                0
              </strong>

              <div
                class="metric-change"
                id="change-orders"
              >
                —
              </div>
            </article>

            <article class="metric-card">
              <div class="metric-top">
                <span class="metric-label">
                  Unidades vendidas
                </span>
                <span class="metric-icon purple">
                  ◇
                </span>
              </div>

              <strong
                class="metric-value"
                id="metric-units"
              >
                0
              </strong>

              <div
                class="metric-change"
                id="change-units"
              >
                —
              </div>
            </article>

            <article class="metric-card">
              <div class="metric-top">
                <span class="metric-label">
                  Ticket médio
                </span>
                <span class="metric-icon orange">
                  ↗
                </span>
              </div>

              <strong
                class="metric-value"
                id="metric-ticket"
              >
                R$ 0,00
              </strong>

              <div
                class="metric-change"
                id="change-ticket"
              >
                —
              </div>
            </article>
          </div>

          <div class="alert-grid">
            <article class="alert-card shipment">
              <div class="alert-icon">▣</div>
              <div>
                <span>
                  Pedidos que precisam de envio
                </span>
                <strong id="pending-shipments">
                  0
                </strong>
              </div>
            </article>

            <article class="alert-card paid">
              <div class="alert-icon">✓</div>
              <div>
                <span>Pedidos pagos</span>
                <strong id="paid-orders">
                  0
                </strong>
              </div>
            </article>

            <article class="alert-card pending">
              <div class="alert-icon">◷</div>
              <div>
                <span>Pedidos pendentes</span>
                <strong id="pending-orders">
                  0
                </strong>
              </div>
            </article>

            <article class="alert-card cancelled">
              <div class="alert-icon">×</div>
              <div>
                <span>Pedidos cancelados</span>
                <strong id="cancelled-orders">
                  0
                </strong>
              </div>
            </article>
          </div>

          <div class="content-grid">
            <article class="panel sales-panel">
              <div class="panel-header">
                <div>
                  <h2>Faturamento por dia</h2>
                  <p>
                    Evolução das vendas no período
                    selecionado
                  </p>
                </div>

                <div class="chart-total">
                  <span>Total</span>
                  <strong id="chart-total">
                    R$ 0,00
                  </strong>
                </div>
              </div>

              <div
                class="chart-container"
                id="sales-chart"
              ></div>
            </article>

            <article class="panel products-panel">
              <div class="panel-header">
                <div>
                  <h2>Produtos campeões</h2>
                  <p>
                    Ranking por faturamento
                  </p>
                </div>
              </div>

              <div
                class="product-list"
                id="product-list"
              ></div>
            </article>
          </div>

          <article class="panel orders-panel">
            <div class="panel-header">
              <div>
                <h2>Pedidos recentes</h2>
                <p>
                  Últimas movimentações do período
                </p>
              </div>

              <span
                class="order-count"
                id="orders-loaded"
              >
                0 pedidos carregados
              </span>
            </div>

            <div class="table-wrapper">
              <table>
                <thead>
                  <tr>
                    <th>Pedido</th>
                    <th>Data</th>
                    <th>Produto</th>
                    <th>Unidades</th>
                    <th>Status</th>
                    <th>Valor</th>
                  </tr>
                </thead>

                <tbody id="orders-table"></tbody>
              </table>
            </div>
          </article>

          <section class="future-modules">
            <div class="section-title">
              <div>
                <h2>Próximos módulos</h2>
                <p>
                  A estrutura já está pronta. Agora
                  vamos acender cada luz do Radar.
                </p>
              </div>
            </div>

            <div class="module-grid">
              <article class="module-card">
                <span class="module-icon">?</span>
                <div>
                  <strong>
                    Perguntas e reclamações
                  </strong>
                  <p>
                    Pendências e alertas de
                    atendimento.
                  </p>
                </div>
                <span class="module-tag">
                  Em configuração
                </span>
              </article>

              <article class="module-card">
                <span class="module-icon">▤</span>
                <div>
                  <strong>
                    Estoque e reposição
                  </strong>
                  <p>
                    Estoque baixo e previsão de
                    ruptura.
                  </p>
                </div>
                <span class="module-tag">
                  Em configuração
                </span>
              </article>

              <article class="module-card">
                <span class="module-icon">↗</span>
                <div>
                  <strong>
                    Anúncios e conversão
                  </strong>
                  <p>
                    Visitas, exposição e
                    desempenho.
                  </p>
                </div>
                <span class="module-tag">
                  Em configuração
                </span>
              </article>

              <article class="module-card">
                <span class="module-icon">$</span>
                <div>
                  <strong>
                    Financeiro e lucro
                  </strong>
                  <p>
                    Tarifas, frete, margem e valor
                    líquido.
                  </p>
                </div>
                <span class="module-tag">
                  Próxima etapa
                </span>
              </article>
            </div>
          </section>
        </section>

        <section
          class="error-panel hidden"
          id="error-panel"
        >
          <div class="error-symbol">!</div>
          <h2>Não foi possível carregar o Radar</h2>
          <p id="error-message">
            Ocorreu um erro durante a consulta.
          </p>
          <button id="retry-button">
            Tentar novamente
          </button>
        </section>
      </main>
    </div>

    <script>
      (function () {
        var selectedPeriod = "7d";
        var currentController = null;

        var currencyFormatter =
          new Intl.NumberFormat("pt-BR", {
            style: "currency",
            currency: "BRL"
          });

        var numberFormatter =
          new Intl.NumberFormat("pt-BR");

        var dateFormatter =
          new Intl.DateTimeFormat("pt-BR", {
            timeZone: "America/Sao_Paulo",
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit"
          });

        var shortDateFormatter =
          new Intl.DateTimeFormat("pt-BR", {
            timeZone: "America/Sao_Paulo",
            day: "2-digit",
            month: "2-digit"
          });

        var elements = {
          loading:
            document.getElementById(
              "loading-panel"
            ),
          content:
            document.getElementById(
              "dashboard-content"
            ),
          error:
            document.getElementById(
              "error-panel"
            ),
          connectionWarning:
            document.getElementById(
              "connection-warning"
            ),
          errorMessage:
            document.getElementById(
              "error-message"
            ),
          refreshButton:
            document.getElementById(
              "refresh-button"
            ),
          refreshIcon:
            document.getElementById(
              "refresh-icon"
            ),
          customPeriod:
            document.getElementById(
              "custom-period"
            ),
          customFrom:
            document.getElementById(
              "custom-from"
            ),
          customTo:
            document.getElementById(
              "custom-to"
            ),
          sidebar:
            document.getElementById(
              "sidebar"
            )
        };

        document
          .querySelectorAll(".period-button")
          .forEach(function (button) {
            button.addEventListener(
              "click",
              function () {
                var period =
                  button.dataset.period;

                document
                  .querySelectorAll(
                    ".period-button"
                  )
                  .forEach(function (item) {
                    item.classList.remove(
                      "active"
                    );
                  });

                button.classList.add("active");
                selectedPeriod = period;

                if (period === "custom") {
                  elements.customPeriod.classList.add(
                    "visible"
                  );
                  prepareCustomDates();
                  return;
                }

                elements.customPeriod.classList.remove(
                  "visible"
                );

                loadDashboard();
              }
            );
          });

        document
          .getElementById("apply-custom")
          .addEventListener(
            "click",
            function () {
              if (
                !elements.customFrom.value ||
                !elements.customTo.value
              ) {
                alert(
                  "Escolha a data inicial e a data final."
                );
                return;
              }

              if (
                elements.customFrom.value >
                elements.customTo.value
              ) {
                alert(
                  "A data inicial não pode ser posterior à data final."
                );
                return;
              }

              loadDashboard();
            }
          );

        elements.refreshButton.addEventListener(
          "click",
          loadDashboard
        );

        document
          .getElementById("retry-button")
          .addEventListener(
            "click",
            loadDashboard
          );

        document
          .getElementById("mobile-menu")
          .addEventListener(
            "click",
            function () {
              elements.sidebar.classList.toggle(
                "open"
              );
            }
          );

        function prepareCustomDates() {
          var now = new Date();
          var sevenDaysAgo = new Date(
            now.getTime() -
              6 * 24 * 60 * 60 * 1000
          );

          if (!elements.customFrom.value) {
            elements.customFrom.value =
              formatInputDate(sevenDaysAgo);
          }

          if (!elements.customTo.value) {
            elements.customTo.value =
              formatInputDate(now);
          }
        }

        function formatInputDate(date) {
          var year = date.getFullYear();
          var month = String(
            date.getMonth() + 1
          ).padStart(2, "0");
          var day = String(
            date.getDate()
          ).padStart(2, "0");

          return (
            year + "-" + month + "-" + day
          );
        }

        async function loadDashboard() {
          if (currentController) {
            currentController.abort();
          }

          currentController =
            new AbortController();

          setLoading(true);

          var params =
            new URLSearchParams({
              period: selectedPeriod
            });

          if (selectedPeriod === "custom") {
            params.set(
              "from",
              elements.customFrom.value
            );
            params.set(
              "to",
              elements.customTo.value
            );
          }

          try {
            var response = await fetch(
              "/api/dashboard?" +
                params.toString(),
              {
                signal:
                  currentController.signal,
                cache: "no-store"
              }
            );

            var data = await response.json();

            if (!response.ok) {
              throw new Error(
                data.message ||
                  "Não foi possível carregar os dados."
              );
            }

            renderDashboard(data);
            showContent();
          } catch (error) {
            if (error.name === "AbortError") {
              return;
            }

            showError(
              error.message ||
                "Ocorreu um erro durante a consulta."
            );
          } finally {
            setLoading(false);
          }
        }

        function renderDashboard(data) {
          document.getElementById(
            "sidebar-account"
          ).textContent =
            data.account.nickname ||
            "Conta Mercado Livre";

          document.getElementById(
            "last-update"
          ).textContent =
            dateFormatter.format(
              new Date(data.generated_at)
            );

          setText(
            "metric-revenue",
            currencyFormatter.format(
              data.metrics.revenue || 0
            )
          );

          setText(
            "metric-orders",
            numberFormatter.format(
              data.metrics.orders || 0
            )
          );

          setText(
            "metric-units",
            numberFormatter.format(
              data.metrics.units || 0
            )
          );

          setText(
            "metric-ticket",
            currencyFormatter.format(
              data.metrics.average_ticket || 0
            )
          );

          setText(
            "pending-shipments",
            numberFormatter.format(
              data.metrics.pending_shipments ||
                0
            )
          );

          setText(
            "paid-orders",
            numberFormatter.format(
              data.metrics.paid_orders || 0
            )
          );

          setText(
            "pending-orders",
            numberFormatter.format(
              data.metrics.pending_orders || 0
            )
          );

          setText(
            "cancelled-orders",
            numberFormatter.format(
              data.metrics.cancelled_orders ||
                0
            )
          );

          setText(
            "chart-total",
            currencyFormatter.format(
              data.metrics.revenue || 0
            )
          );

          setText(
            "orders-loaded",
            numberFormatter.format(
              data.collection
                .current_orders_loaded || 0
            ) +
              " pedidos carregados"
          );

          renderChange(
            "change-revenue",
            data.comparison.revenue
          );

          renderChange(
            "change-orders",
            data.comparison.orders
          );

          renderChange(
            "change-units",
            data.comparison.units
          );

          renderChange(
            "change-ticket",
            data.comparison.averageTicket
          );

          renderChart(
            data.sales_by_day || []
          );

          renderProducts(
            data.top_products || []
          );

          renderOrders(
            data.recent_orders || []
          );
        }

        function renderChange(id, value) {
          var element =
            document.getElementById(id);

          element.classList.remove(
            "positive",
            "negative",
            "neutral"
          );

          if (value === null) {
            element.textContent =
              "↑ Primeiras vendas no período";
            element.classList.add("positive");
            return;
          }

          if (
            value === undefined ||
            Number.isNaN(value)
          ) {
            element.textContent =
              "Sem comparação disponível";
            element.classList.add("neutral");
            return;
          }

          if (value > 0) {
            element.textContent =
              "↑ " +
              Math.abs(value).toLocaleString(
                "pt-BR"
              ) +
              "% vs. período anterior";
            element.classList.add("positive");
            return;
          }

          if (value < 0) {
            element.textContent =
              "↓ " +
              Math.abs(value).toLocaleString(
                "pt-BR"
              ) +
              "% vs. período anterior";
            element.classList.add("negative");
            return;
          }

          element.textContent =
            "• Sem variação no período";
          element.classList.add("neutral");
        }

        function renderChart(days) {
          var container =
            document.getElementById(
              "sales-chart"
            );

          container.innerHTML = "";

          if (!days.length) {
            container.innerHTML =
              '<div class="empty-state">' +
              "<strong>Nenhuma venda no período</strong>" +
              "<span>Quando as vendas chegarem, o gráfico floresce por aqui.</span>" +
              "</div>";
            return;
          }

          var maximum = Math.max.apply(
            null,
            days.map(function (day) {
              return Number(
                day.revenue || 0
              );
            })
          );

          var chart =
            document.createElement("div");
          chart.className = "bar-chart";

          days.forEach(function (day) {
            var column =
              document.createElement("div");
            column.className =
              "chart-column";

            var value =
              document.createElement("span");
            value.className =
              "chart-value";
            value.textContent =
              compactCurrency(day.revenue);

            var barTrack =
              document.createElement("div");
            barTrack.className =
              "bar-track";

            var bar =
              document.createElement("div");
            bar.className = "bar";

            var percentage =
              maximum > 0
                ? (Number(day.revenue) /
                    maximum) *
                  100
                : 0;

            bar.style.height =
              Math.max(
                percentage,
                day.revenue > 0 ? 8 : 0
              ) + "%";

            bar.title =
              currencyFormatter.format(
                day.revenue || 0
              ) +
              " · " +
              day.orders +
              " pedidos";

            var label =
              document.createElement("span");
            label.className =
              "chart-label";

            label.textContent =
              shortDateFormatter.format(
                new Date(
                  day.date +
                    "T12:00:00-03:00"
                )
              );

            barTrack.appendChild(bar);
            column.appendChild(value);
            column.appendChild(barTrack);
            column.appendChild(label);
            chart.appendChild(column);
          });

          container.appendChild(chart);
        }

        function renderProducts(products) {
          var container =
            document.getElementById(
              "product-list"
            );

          container.innerHTML = "";

          if (!products.length) {
            container.innerHTML =
              '<div class="empty-state compact">' +
              "<strong>Nenhum produto vendido</strong>" +
              "<span>O ranking aparecerá assim que houver vendas.</span>" +
              "</div>";
            return;
          }

          var highestRevenue = Math.max.apply(
            null,
            products.map(function (product) {
              return Number(
                product.revenue || 0
              );
            })
          );

          products.forEach(
            function (product, index) {
              var item =
                document.createElement("div");
              item.className =
                "product-item";

              var percentage =
                highestRevenue > 0
                  ? (Number(
                      product.revenue
                    ) /
                      highestRevenue) *
                    100
                  : 0;

              item.innerHTML =
                '<div class="product-rank">' +
                (index + 1) +
                "</div>" +
                '<div class="product-info">' +
                '<div class="product-title-row">' +
                '<strong title="' +
                escapeAttribute(
                  product.title
                ) +
                '">' +
                escapeText(product.title) +
                "</strong>" +
                "<span>" +
                currencyFormatter.format(
                  product.revenue || 0
                ) +
                "</span>" +
                "</div>" +
                '<div class="product-progress">' +
                '<span style="width:' +
                percentage +
                '%"></span>' +
                "</div>" +
                '<small>' +
                numberFormatter.format(
                  product.quantity || 0
                ) +
                " unidades · " +
                numberFormatter.format(
                  product.orders || 0
                ) +
                " pedidos</small>" +
                "</div>";

              container.appendChild(item);
            }
          );
        }

        function renderOrders(orders) {
          var tbody =
            document.getElementById(
              "orders-table"
            );

          tbody.innerHTML = "";

          if (!orders.length) {
            var row =
              document.createElement("tr");

            row.innerHTML =
              '<td colspan="6">' +
              '<div class="empty-state table-empty">' +
              "<strong>Nenhum pedido no período</strong>" +
              "<span>Experimente selecionar outro intervalo.</span>" +
              "</div>" +
              "</td>";

            tbody.appendChild(row);
            return;
          }

          orders.forEach(function (order) {
            var firstItem =
              order.items &&
              order.items.length
                ? order.items[0]
                : null;

            var productTitle = firstItem
              ? firstItem.title
              : "Produto não informado";

            if (
              order.items &&
              order.items.length > 1
            ) {
              productTitle +=
                " +" +
                (order.items.length - 1);
            }

            var row =
              document.createElement("tr");

            var statusClass =
              getStatusClass(order.status);

            row.innerHTML =
              '<td><strong>#' +
              escapeText(
                String(order.id || "—")
              ) +
              "</strong></td>" +
              "<td>" +
              escapeText(
                dateFormatter.format(
                  new Date(order.date_created)
                )
              ) +
              "</td>" +
              '<td class="product-cell" title="' +
              escapeAttribute(productTitle) +
              '">' +
              escapeText(productTitle) +
              "</td>" +
              "<td>" +
              numberFormatter.format(
                order.item_count || 0
              ) +
              "</td>" +
              '<td><span class="status-badge ' +
              statusClass +
              '">' +
              escapeText(
                order.status_label ||
                  order.status
              ) +
              "</span></td>" +
              '<td class="money-cell">' +
              currencyFormatter.format(
                order.paid_amount ||
                  order.total_amount ||
                  0
              ) +
              "</td>";

            tbody.appendChild(row);
          });
        }

        function getStatusClass(status) {
          if (status === "paid") {
            return "status-paid";
          }

          if (status === "cancelled") {
            return "status-cancelled";
          }

          return "status-pending";
        }

        function compactCurrency(value) {
          var number = Number(value || 0);

          if (number >= 1000000) {
            return (
              "R$ " +
              (number / 1000000)
                .toLocaleString(
                  "pt-BR",
                  {
                    maximumFractionDigits: 1
                  }
                ) +
              " mi"
            );
          }

          if (number >= 1000) {
            return (
              "R$ " +
              (number / 1000)
                .toLocaleString(
                  "pt-BR",
                  {
                    maximumFractionDigits: 1
                  }
                ) +
              " mil"
            );
          }

          return currencyFormatter.format(
            number
          );
        }

        function setText(id, value) {
          document.getElementById(
            id
          ).textContent = value;
        }

        function setLoading(isLoading) {
          elements.refreshButton.disabled =
            isLoading;

          elements.refreshIcon.classList.toggle(
            "spinning",
            isLoading
          );

          if (isLoading) {
            elements.loading.classList.remove(
              "hidden"
            );
            elements.error.classList.add(
              "hidden"
            );
          } else {
            elements.loading.classList.add(
              "hidden"
            );
          }
        }

        function showContent() {
          elements.content.classList.remove(
            "hidden"
          );
          elements.error.classList.add(
            "hidden"
          );
          elements.connectionWarning.classList.add(
            "hidden"
          );
        }

        function showError(message) {
          elements.content.classList.add(
            "hidden"
          );
          elements.error.classList.remove(
            "hidden"
          );
          elements.errorMessage.textContent =
            message;

          if (
            message.toLowerCase().includes(
              "conect"
            )
          ) {
            elements.connectionWarning.classList.remove(
              "hidden"
            );
          }
        }

        function escapeText(value) {
          return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
        }

        function escapeAttribute(value) {
          return escapeText(value);
        }

        loadDashboard();
      })();
    </script>
  `;
}

function htmlResponse(content, status = 200) {
  return new Response(
    `<!DOCTYPE html>
    <html lang="pt-BR">
      <head>
        <meta charset="UTF-8">

        <meta
          name="viewport"
          content="width=device-width, initial-scale=1"
        >

        <meta
          name="color-scheme"
          content="light"
        >

        <title>Radar de Vendas ML</title>

        <style>
          :root {
            --background: #f3f6fa;
            --surface: #ffffff;
            --surface-soft: #f8fafc;
            --border: #e4e9f0;
            --text: #172033;
            --muted: #6c7688;
            --blue: #3483fa;
            --blue-dark: #1769d2;
            --blue-soft: #eaf2ff;
            --green: #14a067;
            --green-soft: #e7f8f0;
            --orange: #f59e0b;
            --orange-soft: #fff6df;
            --red: #df4c4c;
            --red-soft: #ffeded;
            --purple: #7957d5;
            --purple-soft: #f1edff;
            --shadow:
              0 8px 28px rgba(28, 46, 78, 0.07);
          }

          * {
            box-sizing: border-box;
          }

          html {
            scroll-behavior: smooth;
          }

          body {
            margin: 0;
            min-height: 100vh;
            background: var(--background);
            color: var(--text);
            font-family:
              Inter,
              ui-sans-serif,
              system-ui,
              -apple-system,
              BlinkMacSystemFont,
              "Segoe UI",
              sans-serif;
          }

          button,
          input {
            font: inherit;
          }

          button,
          a {
            -webkit-tap-highlight-color:
              transparent;
          }

          .hidden {
            display: none !important;
          }

          .app-shell {
            min-height: 100vh;
          }

          .sidebar {
            position: fixed;
            inset: 0 auto 0 0;
            z-index: 40;
            width: 268px;
            padding: 26px 18px 20px;
            display: flex;
            flex-direction: column;
            background: #111a2e;
            color: #fff;
            box-shadow:
              8px 0 30px
              rgba(12, 20, 38, 0.08);
          }

          .brand {
            display: flex;
            align-items: center;
            gap: 13px;
            padding: 0 10px 28px;
          }

          .brand-mark {
            width: 43px;
            height: 43px;
            display: grid;
            place-items: center;
            flex: 0 0 auto;
            border-radius: 13px;
            background:
              linear-gradient(
                145deg,
                #4b95ff,
                #1769d2
              );
            box-shadow:
              0 8px 18px
              rgba(52, 131, 250, 0.28);
            color: #fff;
            font-size: 21px;
            font-weight: 900;
          }

          .brand strong,
          .brand span {
            display: block;
          }

          .brand strong {
            font-size: 20px;
            letter-spacing: -0.4px;
          }

          .brand span {
            margin-top: 2px;
            color: #9ca8be;
            font-size: 12px;
          }

          .navigation {
            display: grid;
            gap: 6px;
          }

          .nav-item {
            width: 100%;
            min-height: 47px;
            padding: 10px 12px;
            display: flex;
            align-items: center;
            gap: 12px;
            border: 0;
            border-radius: 10px;
            background: transparent;
            color: #b7c0d2;
            cursor: pointer;
            text-align: left;
            transition:
              background 0.2s,
              color 0.2s;
          }

          .nav-item:hover:not(.disabled) {
            background:
              rgba(255, 255, 255, 0.06);
            color: #fff;
          }

          .nav-item.active {
            background:
              linear-gradient(
                90deg,
                rgba(52, 131, 250, 0.24),
                rgba(52, 131, 250, 0.1)
              );
            color: #fff;
            font-weight: 700;
          }

          .nav-item.disabled {
            cursor: default;
            opacity: 0.72;
          }

          .nav-item small {
            margin-left: auto;
            padding: 3px 6px;
            border-radius: 5px;
            background:
              rgba(255, 255, 255, 0.07);
            color: #8692aa;
            font-size: 9px;
            text-transform: uppercase;
          }

          .nav-icon {
            width: 24px;
            display: inline-grid;
            place-items: center;
            color: #87aef0;
            font-weight: 800;
          }

          .sidebar-footer {
            margin-top: auto;
            padding: 17px 10px 4px;
            display: flex;
            align-items: center;
            gap: 10px;
            border-top:
              1px solid
              rgba(255, 255, 255, 0.08);
          }

          .sidebar-footer strong,
          .sidebar-footer span {
            display: block;
          }

          .sidebar-footer strong {
            font-size: 12px;
          }

          .sidebar-footer div > span {
            margin-top: 3px;
            max-width: 170px;
            overflow: hidden;
            color: #94a0b6;
            font-size: 11px;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .status-dot {
            width: 9px;
            height: 9px;
            flex: 0 0 auto;
            border-radius: 50%;
            background: #25cf88;
            box-shadow:
              0 0 0 4px
              rgba(37, 207, 136, 0.12);
          }

          .main-content {
            min-height: 100vh;
            margin-left: 268px;
            padding: 28px 34px 50px;
          }

          .topbar {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 24px;
          }

          .topbar-title {
            display: flex;
            align-items: center;
            gap: 12px;
          }

          .topbar h1 {
            margin: 0;
            font-size: 28px;
            line-height: 1.2;
            letter-spacing: -0.8px;
          }

          .topbar p {
            margin: 7px 0 0;
            color: var(--muted);
            font-size: 14px;
          }

          .topbar-actions {
            display: flex;
            align-items: center;
            gap: 16px;
          }

          .last-update {
            color: var(--muted);
            font-size: 11px;
            text-align: right;
          }

          .last-update strong {
            display: block;
            margin-top: 2px;
            color: var(--text);
          }

          .refresh-button,
          .primary-button {
            min-height: 42px;
            padding: 0 17px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            border: 0;
            border-radius: 10px;
            background: var(--blue);
            box-shadow:
              0 7px 16px
              rgba(52, 131, 250, 0.2);
            color: #fff;
            cursor: pointer;
            font-weight: 750;
            text-decoration: none;
            transition:
              background 0.2s,
              transform 0.2s;
          }

          .refresh-button:hover,
          .primary-button:hover {
            background: var(--blue-dark);
            transform: translateY(-1px);
          }

          .refresh-button:disabled {
            cursor: wait;
            opacity: 0.75;
          }

          .spinning {
            display: inline-block;
            animation: spin 0.8s linear infinite;
          }

          @keyframes spin {
            to {
              transform: rotate(360deg);
            }
          }

          .mobile-menu {
            display: none;
            width: 40px;
            height: 40px;
            border: 1px solid var(--border);
            border-radius: 9px;
            background: var(--surface);
            color: var(--text);
            cursor: pointer;
          }

          .filters {
            margin: 27px 0 22px;
            padding: 7px;
            display: flex;
            align-items: center;
            gap: 5px;
            width: fit-content;
            max-width: 100%;
            border: 1px solid var(--border);
            border-radius: 12px;
            background: var(--surface);
            box-shadow:
              0 4px 16px
              rgba(28, 46, 78, 0.04);
          }

          .period-button {
            min-height: 35px;
            padding: 0 13px;
            border: 0;
            border-radius: 8px;
            background: transparent;
            color: var(--muted);
            cursor: pointer;
            font-size: 12px;
            font-weight: 700;
            white-space: nowrap;
          }

          .period-button:hover {
            color: var(--blue);
          }

          .period-button.active {
            background: var(--blue);
            color: #fff;
          }

          .custom-period {
            display: none;
            align-items: center;
            gap: 7px;
            margin-left: 6px;
            padding-left: 11px;
            border-left: 1px solid var(--border);
            color: var(--muted);
            font-size: 11px;
          }

          .custom-period.visible {
            display: flex;
          }

          .custom-period input {
            width: 132px;
            height: 34px;
            padding: 0 8px;
            border: 1px solid var(--border);
            border-radius: 7px;
            outline: none;
            color: var(--text);
          }

          .custom-period input:focus {
            border-color: var(--blue);
          }

          .custom-period button {
            height: 34px;
            padding: 0 12px;
            border: 0;
            border-radius: 7px;
            background: #172033;
            color: #fff;
            cursor: pointer;
            font-size: 11px;
            font-weight: 700;
          }

          .loading-panel,
          .error-panel {
            min-height: 430px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            border: 1px solid var(--border);
            border-radius: 16px;
            background: var(--surface);
            box-shadow: var(--shadow);
            color: var(--muted);
            text-align: center;
          }

          .loader {
            width: 40px;
            height: 40px;
            border: 4px solid var(--blue-soft);
            border-top-color: var(--blue);
            border-radius: 50%;
            animation: spin 0.85s linear infinite;
          }

          .error-panel h2 {
            margin: 12px 0 5px;
            color: var(--text);
          }

          .error-panel p {
            max-width: 480px;
            margin: 0 20px 20px;
            line-height: 1.6;
          }

          .error-panel button {
            padding: 11px 18px;
            border: 0;
            border-radius: 9px;
            background: var(--blue);
            color: #fff;
            cursor: pointer;
            font-weight: 700;
          }

          .error-symbol {
            width: 48px;
            height: 48px;
            display: grid;
            place-items: center;
            border-radius: 50%;
            background: var(--red-soft);
            color: var(--red);
            font-size: 24px;
            font-weight: 900;
          }

          .connection-warning {
            margin-bottom: 20px;
            padding: 18px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 20px;
            border: 1px solid #f5d78e;
            border-radius: 12px;
            background: #fff9e9;
          }

          .connection-warning p {
            margin: 3px 0 0;
            color: #78653c;
            font-size: 13px;
          }

          .connection-warning a {
            padding: 10px 14px;
            border-radius: 8px;
            background: var(--blue);
            color: #fff;
            font-size: 12px;
            font-weight: 700;
            text-decoration: none;
          }

          .metric-grid {
            display: grid;
            grid-template-columns:
              repeat(4, minmax(0, 1fr));
            gap: 16px;
          }

          .metric-card,
          .panel,
          .alert-card,
          .module-card {
            border: 1px solid var(--border);
            background: var(--surface);
            box-shadow: var(--shadow);
          }

          .metric-card {
            min-height: 152px;
            padding: 20px;
            border-radius: 14px;
          }

          .metric-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 12px;
          }

          .metric-label {
            color: var(--muted);
            font-size: 12px;
            font-weight: 650;
          }

          .metric-icon {
            width: 34px;
            height: 34px;
            display: grid;
            place-items: center;
            border-radius: 9px;
            font-size: 12px;
            font-weight: 900;
          }

          .metric-icon.blue {
            background: var(--blue-soft);
            color: var(--blue);
          }

          .metric-icon.green {
            background: var(--green-soft);
            color: var(--green);
          }

          .metric-icon.purple {
            background: var(--purple-soft);
            color: var(--purple);
          }

          .metric-icon.orange {
            background: var(--orange-soft);
            color: var(--orange);
          }

          .metric-value {
            display: block;
            margin-top: 15px;
            overflow: hidden;
            font-size: clamp(
              21px,
              2.1vw,
              29px
            );
            letter-spacing: -0.8px;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .metric-change {
            margin-top: 9px;
            font-size: 10px;
            font-weight: 700;
          }

          .metric-change.positive {
            color: var(--green);
          }

          .metric-change.negative {
            color: var(--red);
          }

          .metric-change.neutral {
            color: var(--muted);
          }

          .alert-grid {
            margin-top: 16px;
            display: grid;
            grid-template-columns:
              repeat(4, minmax(0, 1fr));
            gap: 12px;
          }

          .alert-card {
            min-height: 76px;
            padding: 15px;
            display: flex;
            align-items: center;
            gap: 13px;
            border-radius: 12px;
          }

          .alert-icon {
            width: 40px;
            height: 40px;
            display: grid;
            place-items: center;
            flex: 0 0 auto;
            border-radius: 10px;
            font-weight: 900;
          }

          .alert-card span,
          .alert-card strong {
            display: block;
          }

          .alert-card span {
            color: var(--muted);
            font-size: 10px;
          }

          .alert-card strong {
            margin-top: 3px;
            font-size: 21px;
          }

          .shipment .alert-icon {
            background: var(--orange-soft);
            color: var(--orange);
          }

          .paid .alert-icon {
            background: var(--green-soft);
            color: var(--green);
          }

          .pending .alert-icon {
            background: var(--blue-soft);
            color: var(--blue);
          }

          .cancelled .alert-icon {
            background: var(--red-soft);
            color: var(--red);
          }

          .content-grid {
            margin-top: 16px;
            display: grid;
            grid-template-columns:
              minmax(0, 1.55fr)
              minmax(310px, 0.85fr);
            gap: 16px;
          }

          .panel {
            border-radius: 14px;
            overflow: hidden;
          }

          .panel-header {
            padding: 19px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 16px;
            border-bottom: 1px solid var(--border);
          }

          .panel-header h2 {
            margin: 0;
            font-size: 15px;
            letter-spacing: -0.2px;
          }

          .panel-header p {
            margin: 5px 0 0;
            color: var(--muted);
            font-size: 10px;
          }

          .chart-total {
            text-align: right;
          }

          .chart-total span,
          .chart-total strong {
            display: block;
          }

          .chart-total span {
            color: var(--muted);
            font-size: 9px;
          }

          .chart-total strong {
            margin-top: 3px;
            font-size: 14px;
          }

          .chart-container {
            min-height: 280px;
            padding: 24px 20px 18px;
            overflow-x: auto;
          }

          .bar-chart {
            min-width: 520px;
            height: 235px;
            display: flex;
            align-items: stretch;
            gap: 9px;
          }

          .chart-column {
            min-width: 39px;
            flex: 1 0 39px;
            display: flex;
            flex-direction: column;
            align-items: center;
          }

          .chart-value {
            height: 26px;
            color: var(--muted);
            font-size: 8px;
            white-space: nowrap;
          }

          .bar-track {
            width: min(38px, 76%);
            height: 170px;
            display: flex;
            align-items: flex-end;
            border-radius: 7px 7px 3px 3px;
            background:
              linear-gradient(
                to top,
                #f2f6fb,
                #f9fbfd
              );
            overflow: hidden;
          }

          .bar {
            width: 100%;
            min-height: 0;
            border-radius: 7px 7px 3px 3px;
            background:
              linear-gradient(
                180deg,
                #5c9dff,
                #2f77e8
              );
            transition: height 0.5s ease;
          }

          .bar:hover {
            filter: brightness(1.06);
          }

          .chart-label {
            margin-top: 9px;
            color: var(--muted);
            font-size: 9px;
            white-space: nowrap;
          }

          .product-list {
            padding: 8px 20px 13px;
          }

          .product-item {
            padding: 12px 0;
            display: flex;
            align-items: flex-start;
            gap: 10px;
            border-bottom: 1px solid #eef1f5;
          }

          .product-item:last-child {
            border-bottom: 0;
          }

          .product-rank {
            width: 24px;
            height: 24px;
            display: grid;
            place-items: center;
            flex: 0 0 auto;
            border-radius: 7px;
            background: var(--blue-soft);
            color: var(--blue);
            font-size: 10px;
            font-weight: 900;
          }

          .product-info {
            min-width: 0;
            flex: 1;
          }

          .product-title-row {
            display: flex;
            justify-content: space-between;
            gap: 10px;
          }

          .product-title-row strong {
            overflow: hidden;
            font-size: 10px;
            text-overflow: ellipsis;
            white-space: nowrap;
          }

          .product-title-row span {
            flex: 0 0 auto;
            font-size: 10px;
            font-weight: 800;
          }

          .product-progress {
            height: 4px;
            margin: 7px 0 5px;
            border-radius: 999px;
            background: #eef2f7;
            overflow: hidden;
          }

          .product-progress span {
            display: block;
            height: 100%;
            border-radius: inherit;
            background:
              linear-gradient(
                90deg,
                var(--blue),
                #6ca9ff
              );
          }

          .product-info small {
            display: block;
            color: var(--muted);
            font-size: 8px;
          }

          .orders-panel {
            margin-top: 16px;
          }

          .order-count {
            padding: 6px 9px;
            border-radius: 7px;
            background: var(--surface-soft);
            color: var(--muted);
            font-size: 9px;
            font-weight: 700;
          }

          .table-wrapper {
            overflow-x: auto;
          }

          table {
            width: 100%;
            border-collapse: collapse;
            font-size: 10px;
          }

          th,
          td {
            padding: 13px 20px;
            border-bottom: 1px solid #eef1f5;
            text-align: left;
            white-space: nowrap;
          }

          th {
            background: #fbfcfe;
            color: var(--muted);
            font-size: 9px;
            text-transform: uppercase;
            letter-spacing: 0.35px;
          }

          tbody tr:last-child td {
            border-bottom: 0;
          }

          tbody tr:hover {
            background: #fbfdff;
          }

          .product-cell {
            max-width: 280px;
            overflow: hidden;
            text-overflow: ellipsis;
          }

          .money-cell {
            font-weight: 800;
          }

          .status-badge {
            padding: 5px 8px;
            border-radius: 999px;
            font-size: 8px;
            font-weight: 800;
          }

          .status-paid {
            background: var(--green-soft);
            color: var(--green);
          }

          .status-cancelled {
            background: var(--red-soft);
            color: var(--red);
          }

          .status-pending {
            background: var(--orange-soft);
            color: #b87908;
          }

          .empty-state {
            min-height: 220px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: 6px;
            color: var(--muted);
            text-align: center;
          }

          .empty-state strong {
            color: var(--text);
            font-size: 13px;
          }

          .empty-state span {
            max-width: 300px;
            font-size: 10px;
            line-height: 1.5;
          }

          .empty-state.compact {
            min-height: 220px;
          }

          .empty-state.table-empty {
            min-height: 130px;
          }

          .future-modules {
            margin-top: 28px;
          }

          .section-title h2 {
            margin: 0;
            font-size: 18px;
          }

          .section-title p {
            margin: 6px 0 0;
            color: var(--muted);
            font-size: 11px;
          }

          .module-grid {
            margin-top: 14px;
            display: grid;
            grid-template-columns:
              repeat(4, minmax(0, 1fr));
            gap: 12px;
          }

          .module-card {
            min-height: 145px;
            padding: 17px;
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            border-radius: 13px;
          }

          .module-icon {
            width: 34px;
            height: 34px;
            display: grid;
            place-items: center;
            border-radius: 9px;
            background: var(--blue-soft);
            color: var(--blue);
            font-weight: 900;
          }

          .module-card strong {
            display: block;
            margin-top: 12px;
            font-size: 11px;
          }

          .module-card p {
            margin: 5px 0 12px;
            color: var(--muted);
            font-size: 9px;
            line-height: 1.5;
          }

          .module-tag {
            margin-top: auto;
            padding: 5px 7px;
            border-radius: 6px;
            background: #f0f3f7;
            color: var(--muted);
            font-size: 8px;
            font-weight: 800;
            text-transform: uppercase;
          }

          .simple-page {
            width: min(560px, calc(100% - 40px));
            margin: 10vh auto;
            padding: 42px;
            border: 1px solid var(--border);
            border-radius: 18px;
            background: var(--surface);
            box-shadow: var(--shadow);
            text-align: center;
          }

          .simple-page h1 {
            margin-top: 0;
          }

          .simple-page p {
            color: var(--muted);
            line-height: 1.6;
          }

          .success-icon {
            width: 58px;
            height: 58px;
            margin: 0 auto 20px;
            display: grid;
            place-items: center;
            border-radius: 50%;
            background: var(--green-soft);
            color: var(--green);
            font-size: 28px;
            font-weight: 900;
          }

          .success-box {
            margin: 22px 0;
            padding: 15px;
            border-radius: 9px;
            background: var(--green-soft);
            color: var(--green);
            font-weight: 750;
          }

          .error {
            color: var(--red) !important;
          }

          @media (max-width: 1180px) {
            .metric-grid,
            .alert-grid,
            .module-grid {
              grid-template-columns:
                repeat(2, minmax(0, 1fr));
            }

            .content-grid {
              grid-template-columns: 1fr;
            }
          }

          @media (max-width: 820px) {
            .sidebar {
              transform: translateX(-102%);
              transition: transform 0.25s ease;
            }

            .sidebar.open {
              transform: translateX(0);
            }

            .main-content {
              margin-left: 0;
              padding: 21px 18px 40px;
            }

            .mobile-menu {
              display: grid;
              place-items: center;
            }

            .topbar {
              align-items: flex-start;
            }

            .last-update {
              display: none;
            }

            .filters {
              width: 100%;
              overflow-x: auto;
            }

            .custom-period.visible {
              min-width: 400px;
            }
          }

          @media (max-width: 560px) {
            .topbar {
              display: block;
            }

            .topbar-actions {
              margin-top: 16px;
              justify-content: flex-end;
            }

            .refresh-button {
              width: 100%;
            }

            .metric-grid,
            .alert-grid,
            .module-grid {
              grid-template-columns: 1fr;
            }

            .metric-card {
              min-height: 135px;
            }

            .metric-value {
              font-size: 27px;
            }

            .filters {
              margin-top: 21px;
            }

            .panel-header {
              align-items: flex-start;
            }

            .product-cell {
              max-width: 180px;
            }
          }
        </style>
      </head>

      <body>
        ${content}
      </body>
    </html>`,
    {
      status,
      headers: {
        "Content-Type":
          "text/html; charset=UTF-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options":
          "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
      },
    }
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}