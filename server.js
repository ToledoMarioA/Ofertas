#!/usr/bin/env node
"use strict";

/**
 * Servidor local del buscador de ofertas.
 *
 * Consulta Amazon México, Liverpool, Sam's Club, Costco y Mercado Libre
 * en vivo, extrae productos y precios, y entrega los resultados al HTML
 * mediante /api/search.
 *
 * Uso:
 *   node server.js
 *   Abrir http://127.0.0.1:8788
 *
 * Mercado Libre requiere las credenciales en .env y autorizar una vez en:
 *   http://127.0.0.1:8788/auth/mercadolibre
 *
 * Sin dependencias externas. Requiere Node 18 o superior.
 */

const http = require("node:http");
const http2 = require("node:http2");
const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

function loadEnvFile(filePath) {
  try {
    const text = fsSync.readFileSync(filePath, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch (error) {
    // .env es opcional
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || "0.0.0.0";
const ROOT = __dirname;
const CACHE_TTL = 10 * 60 * 1000;
const MAX_RESULTS_PER_STORE = 12;
const MIN_QUERY_LENGTH = 3;
const MELI_CLIENT_ID = process.env.MELI_CLIENT_ID || "";
const MELI_CLIENT_SECRET = process.env.MELI_CLIENT_SECRET || "";
const MELI_REDIRECT_URI =
  process.env.MELI_REDIRECT_URI ||
  `http://localhost:${PORT}/auth/mercadolibre/callback`;
const MELI_TOKEN_FILE = path.join(ROOT, ".meli-token.json");
const MELI_AUTH_URL = "https://auth.mercadolibre.com.mx/authorization";
const SEARS_ALGOLIA_APP_ID = process.env.SEARS_ALGOLIA_APP_ID || "6M62U1ZBKU";
const SEARS_ALGOLIA_KEY = process.env.SEARS_ALGOLIA_KEY || "6698ccede119391b5f6db5c39352b1f2";
const SEARS_ALGOLIA_INDEX = process.env.SEARS_ALGOLIA_INDEX || "sears";
const SANBORNS_ALGOLIA_APP_ID = process.env.SANBORNS_ALGOLIA_APP_ID || "YRJK5WM0EE";
const SANBORNS_ALGOLIA_KEY = process.env.SANBORNS_ALGOLIA_KEY || "7b13de153df99431646d353f780fb3b4";
const SANBORNS_ALGOLIA_INDEX = process.env.SANBORNS_ALGOLIA_INDEX || "sanborns";
const JINA_READER_URL = "https://r.jina.ai/";
const COMER_SEARCH_URL = "https://lacomer.buscador.amarello.com.mx/searchArtPrior";
const COMER_SUCC_ID = process.env.COMER_SUCC_ID || "363";
const DOMINOS_STORE_ID = process.env.DOMINOS_STORE_ID || "11121";
const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY || "";
const SCRAPINGBEE_API_KEY = process.env.SCRAPINGBEE_API_KEY || "";
let lastJinaRequest = 0;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const STORES = {
  amazon: {
    name: "Amazon",
    icon: "📦",
    color: "#ff9900",
    searchUrl: (query) =>
      `https://www.amazon.com.mx/s?k=${encodeURIComponent(query)}&ref=nb_sb_noss`
  },
  liverpool: {
    name: "Liverpool",
    icon: "🛍️",
    color: "#e10098",
    searchUrl: (query) =>
      `https://www.liverpool.com.mx/tienda?s=${encodeURIComponent(query)}`
  },
  samsclub: {
    name: "Sam's Club",
    icon: "🏪",
    color: "#0067b1",
    searchUrl: (query) =>
      `https://www.sams.com.mx/search?q=${encodeURIComponent(query)}`
  },
  walmart: {
    name: "Walmart",
    icon: "🏪",
    color: "#0071ce",
    searchUrl: (query) =>
      `https://www.walmart.com.mx/search?q=${encodeURIComponent(query)}`
  },
  costco: {
    name: "Costco",
    icon: "🏬",
    color: "#e31837",
    searchUrl: (query) =>
      "https://www.costco.com.mx/rest/v2/mexico/products/search?fields=FULL" +
      `&query=${encodeURIComponent(query)}&pageSize=24&searchOption=mx-search-all` +
      "&lang=es_MX&curr=MXN"
  },
  mercadolibre: {
    name: "Mercado Libre",
    icon: "🤝",
    color: "#ffe600"
  },
  sears: {
    name: "Sears",
    icon: "🏬",
    color: "#004b8d"
  },
  sanborns: {
    name: "Sanborns",
    icon: "🏬",
    color: "#7a1f3d"
  },
  suburbia: {
    name: "Suburbia",
    icon: "👕",
    color: "#f7a800"
  },
  chedraui: {
    name: "Chedraui",
    icon: "🛍️",
    color: "#e30613"
  },
  lacomer: {
    name: "La Comer",
    icon: "🥑",
    color: "#8cc63f"
  },
  homedepot: {
    name: "Home Depot",
    icon: "🔨",
    color: "#f96302"
  },
  soriana: {
    name: "Soriana",
    icon: "🛒",
    color: "#e4032e"
  },
  dominos: {
    name: "Domino's Pizza",
    icon: "🍕",
    color: "#006491"
  },
  starbucks: {
    name: "Starbucks",
    icon: "☕",
    color: "#00704a"
  }
};

const cache = new Map();
const pending = new Map();
const nextStoreSlot = new Map();

/* ------------------------------------------------------------------ */
/* Utilidades de texto                                                 */
/* ------------------------------------------------------------------ */

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  aacute: "á", eacute: "é", iacute: "í", oacute: "ó", uacute: "ú",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Uacute: "Ú",
  ntilde: "ñ", Ntilde: "Ñ", uuml: "ü", Uuml: "Ü",
  iexcl: "¡", iquest: "¿", mdash: "—", ndash: "–",
  hellip: "…", middot: "·", deg: "°", euro: "€", times: "×"
};

function decodeEntities(value) {
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const number = code[1] && code[1].toLowerCase() === "x"
        ? Number.parseInt(code.slice(2), 16)
        : Number.parseInt(code.slice(1), 10);
      return Number.isFinite(number) ? String.fromCodePoint(number) : match;
    }
    return ENTITIES[code] || ENTITIES[code.toLowerCase()] || match;
  });
}

function cleanText(html) {
  const withoutTags = String(html || "")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ");
  return decodeEntities(withoutTags)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function slugify(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parsePrice(value) {
  const text = cleanText(value).replace(/\s+/g, "");
  const match = text.match(/\$\s*([\d][\d.,]*)/) || text.match(/([\d][\d.,]*)/);
  if (!match) return 0;
  let raw = match[1].replace(/,/g, "");
  const dots = (raw.match(/\./g) || []).length;
  if (dots > 1) raw = raw.replace(/\.(?=.*\.)/g, "");
  const number = Number.parseFloat(raw);
  return Number.isFinite(number) && number > 0
    ? Math.round(number * 100) / 100
    : 0;
}

function discountPercent(oldPrice, price) {
  if (!oldPrice || oldPrice <= price) return 0;
  return Math.max(1, Math.round((1 - price / oldPrice) * 100));
}

function absoluteUrl(base, href) {
  try {
    return new URL(decodeEntities(href), base).href;
  } catch (error) {
    return "";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* Descarga de páginas                                                 */
/* ------------------------------------------------------------------ */

async function fetchPage(url, timeoutMs = 18000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "es-MX,es;q=0.9,en;q=0.7",
        "Upgrade-Insecure-Requests": "1",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache"
      }
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const html = await response.text();
    if (html.length < 5000) {
      throw new Error("Respuesta vacía o bloqueada");
    }
    if (/captcha|robot check|not a robot|introduce los caracteres/i.test(html.slice(0, 5000))) {
      throw new Error("Bloqueo anti-bot");
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPageHttp2(url, redirects = 0) {
  const target = new URL(url);
  const client = http2.connect(target.origin);

  return new Promise((resolve, reject) => {
    let settled = false;
    let status = 0;
    let headers = {};
    let body = "";

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { client.close(); } catch (closeError) {}
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(
      () => finish(new Error("Tiempo de espera agotado")),
      18000
    );

    client.on("error", (error) => finish(error));
    client.on("goaway", () => {
      if (!settled) finish(new Error("Conexión HTTP/2 cerrada"));
    });

    const request = client.request({
      ":method": "GET",
      ":path": target.pathname + target.search,
      ":authority": target.host,
      ":scheme": "https",
      "user-agent": USER_AGENT,
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "accept-language": "es-MX,es;q=0.9,en;q=0.7",
      "accept-encoding": "identity",
      "upgrade-insecure-requests": "1",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "referer": target.origin + "/"
    });

    request.on("response", (responseHeaders) => {
      status = Number(responseHeaders[":status"]) || 0;
      headers = responseHeaders;
    });

    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 6 * 1024 * 1024) {
        request.close(http2.constants.NGHTTP2_CANCEL);
      }
    });

    request.on("error", (error) => finish(error));
    request.on("end", () => {
      if (status >= 300 && status < 400 && headers.location && redirects < 3) {
        const next = new URL(String(headers.location), target).toString();
        fetchPageHttp2(next, redirects + 1).then(
          (value) => finish(null, value),
          (error) => finish(error)
        );
        return;
      }
      if (!status) return finish(new Error("Sin respuesta HTTP/2"));
      if (status < 200 || status >= 300) {
        return finish(new Error(`HTTP ${status}`));
      }
      if (body.length < 5000) {
        return finish(new Error("Respuesta vacía o bloqueada"));
      }
      if (/captcha|robot check|not a robot|introduce los caracteres|verify your identity/i.test(body.slice(0, 5000))) {
        return finish(new Error("Bloqueo anti-bot"));
      }
      finish(null, body);
    });

    request.end();
  });
}

async function politeFetchHttp2(storeId, url) {
  const wait = Math.max(0, (nextStoreSlot.get(storeId) || 0) - Date.now());
  if (wait > 0) await sleep(wait);
  nextStoreSlot.set(storeId, Date.now() + 2500);
  return fetchPageHttp2(url);
}

async function politeFetch(storeId, url, timeoutMs = 18000) {
  const wait = Math.max(0, (nextStoreSlot.get(storeId) || 0) - Date.now());
  if (wait > 0) await sleep(wait);
  nextStoreSlot.set(storeId, Date.now() + 2500);
  return fetchPage(url, timeoutMs);
}

async function politeFetchJson(storeId, url) {
  const wait = Math.max(0, (nextStoreSlot.get(storeId) || 0) - Date.now());
  if (wait > 0) await sleep(wait);
  nextStoreSlot.set(storeId, Date.now() + 2500);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "es-MX,es;q=0.9",
        "Cache-Control": "no-cache"
      }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    if (text.length < 5) throw new Error("Respuesta vacía");
    try {
      return JSON.parse(text);
    } catch (error) {
      throw new Error("Respuesta JSON no válida");
    }
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Amazon México                                                       */
/* ------------------------------------------------------------------ */

async function searchAmazon(query) {
  const html = await politeFetch("amazon", STORES.amazon.searchUrl(query));
  const chunks = html.split('data-component-type="s-search-result"').slice(1);
  const results = [];
  const seen = new Set();

  for (const chunk of chunks) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;

    const asin = (chunk.match(/data-asin="([A-Z0-9]{10})"/) || [])[1];
    if (!asin || seen.has(asin)) continue;

    const titleHtml = (chunk.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1];
    const title = cleanText(titleHtml);
    if (!title) continue;

    const offscreen = Array.from(
      chunk.matchAll(/<span class="a-offscreen">([\s\S]*?)<\/span>/g)
    ).map((match) => cleanText(match[1]));

    const priceText = offscreen.find(
      (value) => value.startsWith("$") && !/anterior/i.test(value)
    );
    const price = parsePrice(priceText);
    if (!price) continue;

    let oldPrice = 0;
    for (const value of offscreen) {
      const candidate = parsePrice(value);
      if (candidate > price * 1.02 && candidate < price * 8) {
        oldPrice = candidate;
        break;
      }
    }

    const image = (chunk.match(
      /<img[^>]*class="[^"]*s-image[^"]*"[^>]*src="([^"]+)"/
    ) || [])[1];

    results.push({
      id: `amazon-${asin}`,
      storeId: "amazon",
      store: STORES.amazon.name,
      icon: STORES.amazon.icon,
      color: STORES.amazon.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link: `https://www.amazon.com.mx/dp/${asin}`,
      image: image ? decodeEntities(image) : "",
      source: "Amazon",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(asin);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Liverpool                                                           */
/* ------------------------------------------------------------------ */

async function searchLiverpool(query) {
  const html = await politeFetch("liverpool", STORES.liverpool.searchUrl(query));
  const cardPattern =
    /<a[^>]*data-testid="(\d+)-card-card-link"[^>]*href="([^"]+)"[^>]*>\s*<section[^>]*data-testid="\1-card"[^>]*>([\s\S]*?)<\/section>/g;

  const results = [];
  const seen = new Set();
  let match;

  while ((match = cardPattern.exec(html)) && results.length < MAX_RESULTS_PER_STORE) {
    const sku = match[1];
    const href = match[2];
    const body = match[3];
    if (seen.has(sku)) continue;

    const title = cleanText(
      (body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]
    );
    if (!title) continue;

    const priceMarker = body.indexOf(`data-testid="${sku}-price"`);
    if (priceMarker < 0) continue;
    const priceChunk = body.slice(priceMarker, priceMarker + 2500);
    const price = parsePrice(priceChunk);
    if (!price) continue;

    let oldPrice = 0;
    const originalMatch = priceChunk.match(
      /data-testid="original"[^>]*>([\s\S]*?)(?=<\/span>\s*<\/span>|<div class="w-fit")/
    );
    if (originalMatch) {
      const candidate = parsePrice(originalMatch[1]);
      if (candidate > price * 1.02 && candidate < price * 8) oldPrice = candidate;
    }

    const image = (body.match(/<img[^>]*src="([^"]+)"/) || [])[1];
    const link = absoluteUrl("https://www.liverpool.com.mx", href);
    if (!link) continue;

    results.push({
      id: `liverpool-${sku}`,
      storeId: "liverpool",
      store: STORES.liverpool.name,
      icon: STORES.liverpool.icon,
      color: STORES.liverpool.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link,
      image: image ? absoluteUrl("https://www.liverpool.com.mx", image) : "",
      source: "Liverpool",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(sku);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Sam's Club                                                          */
/* ------------------------------------------------------------------ */

function scraperProxyUrl(target) {
  if (SCRAPER_API_KEY) {
    return "https://api.scraperapi.com/?" + new URLSearchParams({
      api_key: SCRAPER_API_KEY,
      url: target,
      country_code: "mx",
      premium: "true",
      render: "true"
    }).toString();
  }
  if (SCRAPINGBEE_API_KEY) {
    return "https://app.scrapingbee.com/api/v1/?" + new URLSearchParams({
      api_key: SCRAPINGBEE_API_KEY,
      url: target,
      country_code: "mx",
      premium_proxy: "true",
      render_js: "true"
    }).toString();
  }
  return "";
}

async function searchSamsClub(query) {
  const target = STORES.samsclub.searchUrl(query);
  const proxyUrl = scraperProxyUrl(target);
  const html = proxyUrl
    ? await politeFetch("samsclub", proxyUrl, 45000)
    : await politeFetchHttp2("samsclub", target);
  const nextData = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!nextData) throw new Error("No se encontró la información de productos");

  let data;
  try {
    data = JSON.parse(nextData[1]);
  } catch (error) {
    throw new Error("Respuesta de Sam's Club no válida");
  }

  const stacks =
    (data &&
      data.props &&
      data.props.pageProps &&
      data.props.pageProps.initialData &&
      data.props.pageProps.initialData.searchResult &&
      data.props.pageProps.initialData.searchResult.itemStacks) || [];

  const results = [];
  const seen = new Set();

  for (const stack of stacks) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    const items = [].concat(stack.items || [], stack.itemsV2 || []);

    for (const item of items) {
      if (results.length >= MAX_RESULTS_PER_STORE) break;
      if (!item || item.__typename !== "Product" || item.isOutOfStock) continue;

      const id = String(item.id || item.usItemId || "");
      if (!id || seen.has(id)) continue;

      const title = cleanText(item.name);
      const priceInfo = item.priceInfo || {};
      const price = Number(item.price) || parsePrice(priceInfo.linePrice);
      if (!title || !price) continue;

      let oldPrice = parsePrice(priceInfo.wasPrice) || parsePrice(priceInfo.itemPrice);
      if (oldPrice <= price * 1.02 || oldPrice > price * 8) oldPrice = 0;

      const link = absoluteUrl(
        "https://www.sams.com.mx",
        item.canonicalUrl || item.productUrl || ""
      );
      if (!link) continue;

      const categoryPath = item.category && item.category.path;
      const category = Array.isArray(categoryPath) && categoryPath.length
        ? categoryPath[categoryPath.length - 1].name
        : "Sam's Club";

      results.push({
        id: `samsclub-${id}`,
        storeId: "samsclub",
        store: STORES.samsclub.name,
        icon: STORES.samsclub.icon,
        color: STORES.samsclub.color,
        type: "tienda",
        product: title,
        category,
        price,
        old: oldPrice,
        discount: discountPercent(oldPrice, price),
        link,
        image: (item.imageInfo && item.imageInfo.thumbnailUrl) || "",
        source: "Sam's Club",
        kind: "store",
        live: true,
        fetchedAt: Date.now()
      });

      seen.add(id);
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Walmart México                                                      */
/* ------------------------------------------------------------------ */

async function fetchScrapingBeeWalmart(query) {
  const url = "https://app.scrapingbee.com/api/v1/walmart/search?" +
    new URLSearchParams({
      query,
      domain: "www.walmart.com.mx"
    }).toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${SCRAPINGBEE_API_KEY}`,
        "Accept": "application/json"
      }
    });
    if (!response.ok) throw new Error(`ScrapingBee HTTP ${response.status}`);
    const data = await response.json();
    if (!data || !Array.isArray(data.products)) {
      throw new Error("ScrapingBee no devolvió productos de Walmart");
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

async function searchWalmart(query) {
  if (SCRAPINGBEE_API_KEY) {
    const data = await fetchScrapingBeeWalmart(query);
    const results = [];
    const seen = new Set();
    const normalize = (value) =>
      String(value || "")
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
    const queryTokens = normalize(query).split(/\s+/).filter((token) => token.length >= 3);

    for (const product of data.products) {
      if (results.length >= MAX_RESULTS_PER_STORE) break;
      if (!product) continue;

      const id = String(product.product_id || product.id || "");
      if (!id || seen.has(id)) continue;

      const title = cleanText(product.title);
      const price = Number(product.price) || parsePrice(product.price);
      if (!title || !price) continue;

      if (product.currency && product.currency !== "MXN") continue;
      const haystack = normalize(title);
      if (queryTokens.length && !queryTokens.some((token) => haystack.includes(token))) {
        continue;
      }

      let oldPrice = Number(product.original_price || product.list_price || 0);
      if (oldPrice <= price * 1.02 || oldPrice > price * 8) oldPrice = 0;

      const link = absoluteUrl(
        "https://www.walmart.com.mx",
        product.url || product.canonical_url || ""
      );
      if (!link) continue;

      results.push({
        id: `walmart-${id}`,
        storeId: "walmart",
        store: STORES.walmart.name,
        icon: STORES.walmart.icon,
        color: STORES.walmart.color,
        type: "tienda",
        product: title,
        category: cleanText(product.category) || "Walmart",
        price,
        old: oldPrice,
        discount: discountPercent(oldPrice, price),
        link,
        image: product.image
          ? absoluteUrl("https://www.walmart.com.mx", product.image)
          : "",
        source: "Walmart",
        kind: "store",
        live: true,
        fetchedAt: Date.now()
      });

      seen.add(id);
    }

    return results;
  }

  const target = STORES.walmart.searchUrl(query);
  const proxyUrl = scraperProxyUrl(target);
  const html = proxyUrl
    ? await politeFetch("walmart", proxyUrl, 45000)
    : await politeFetchHttp2("walmart", target);

  const nextData = html.match(
    /<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!nextData) throw new Error("No se encontró la información de productos");

  let data;
  try {
    data = JSON.parse(nextData[1]);
  } catch (error) {
    throw new Error("Respuesta de Walmart no válida");
  }

  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const returnedQuery = normalize(data && data.query && data.query.q);
  const requestedQuery = normalize(query);
  if (
    returnedQuery &&
    !returnedQuery.includes(requestedQuery) &&
    !requestedQuery.includes(returnedQuery)
  ) {
    throw new Error("Walmart devolvió resultados de otra búsqueda");
  }

  const stacks =
    (data &&
      data.props &&
      data.props.pageProps &&
      data.props.pageProps.initialData &&
      data.props.pageProps.initialData.searchResult &&
      data.props.pageProps.initialData.searchResult.itemStacks) || [];

  const results = [];
  const seen = new Set();

  for (const stack of stacks) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    const items = [].concat(stack.items || [], stack.itemsV2 || []);

    for (const item of items) {
      if (results.length >= MAX_RESULTS_PER_STORE) break;
      if (!item || item.__typename !== "Product" || item.isOutOfStock) continue;

      const id = String(item.usItemId || item.id || "");
      if (!id || seen.has(id)) continue;

      const title = cleanText(item.name);
      const priceInfo = item.priceInfo || {};
      const price = Number(item.price) || parsePrice(priceInfo.linePrice);
      if (!title || !price) continue;

      let oldPrice = parsePrice(priceInfo.wasPrice) || parsePrice(priceInfo.itemPrice);
      if (oldPrice <= price * 1.02 || oldPrice > price * 8) oldPrice = 0;

      const link = absoluteUrl(
        "https://www.walmart.com.mx",
        item.canonicalUrl || item.productUrl || ""
      );
      if (!link) continue;

      const categoryPath = item.category && item.category.path;
      const category = Array.isArray(categoryPath) && categoryPath.length
        ? categoryPath[categoryPath.length - 1].name
        : "Walmart";

      results.push({
        id: `walmart-${id}`,
        storeId: "walmart",
        store: STORES.walmart.name,
        icon: STORES.walmart.icon,
        color: STORES.walmart.color,
        type: "tienda",
        product: title,
        category,
        price,
        old: oldPrice,
        discount: discountPercent(oldPrice, price),
        link,
        image: (item.imageInfo && item.imageInfo.thumbnailUrl) || "",
        source: "Walmart",
        kind: "store",
        live: true,
        fetchedAt: Date.now()
      });

      seen.add(id);
    }
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Costco                                                              */
/* ------------------------------------------------------------------ */

async function searchCostco(query) {
  const data = await politeFetchJson("costco", STORES.costco.searchUrl(query));
  const products = Array.isArray(data && data.products) ? data.products : [];
  const results = [];
  const seen = new Set();

  for (const product of products) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    if (!product) continue;

    const code = String(product.code || product.id || "");
    if (!code || seen.has(code)) continue;

    const name = cleanText(
      product.nameInSelectedLanguage || product.name || product.englishName
    );
    const price = Number(
      product.price && product.price.value !== undefined
        ? product.price.value
        : product.price && product.price.intValue
          ? product.price.intValue / 100
          : 0
    );
    if (!name || !price) continue;

    const basePrice = Number(
      product.basePrice && product.basePrice.value !== undefined
        ? product.basePrice.value
        : 0
    );
    const oldPrice = basePrice > price * 1.02 && basePrice < price * 8
      ? basePrice
      : 0;

    const link = absoluteUrl(
      "https://www.costco.com.mx",
      product.url || product.productUrl || ""
    );
    if (!link) continue;

    const images = Array.isArray(product.images) ? product.images : [];
    const imageEntry =
      images.find((image) => image.format === "results") ||
      images.find((image) => image.format === "product") ||
      images[0];

    results.push({
      id: `costco-${code}`,
      storeId: "costco",
      store: STORES.costco.name,
      icon: STORES.costco.icon,
      color: STORES.costco.color,
      type: "tienda",
      product: name,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link,
      image: imageEntry
        ? absoluteUrl("https://www.costco.com.mx", imageEntry.url)
        : "",
      source: "Costco",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(code);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Mercado Libre (OAuth + API)                                        */
/* ------------------------------------------------------------------ */

function hasMeliCredentials() {
  return Boolean(MELI_CLIENT_ID && MELI_CLIENT_SECRET);
}

function buildMeliAuthUrl() {
  const url = new URL(MELI_AUTH_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", MELI_CLIENT_ID);
  url.searchParams.set("redirect_uri", MELI_REDIRECT_URI);
  return url.href;
}

async function meliRequestToken(params) {
  const response = await fetch("https://api.mercadolibre.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Accept": "application/json",
      "User-Agent": USER_AGENT
    },
    body: new URLSearchParams(params)
  });
  const text = await response.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch (error) {
    data = {};
  }
  if (!response.ok) {
    throw new Error(
      data.message || data.error || `Mercado Libre respondió HTTP ${response.status}`
    );
  }
  return data;
}

async function readMeliToken() {
  try {
    const text = await fs.readFile(MELI_TOKEN_FILE, "utf8");
    const data = JSON.parse(text);
    return data && data.access_token ? data : null;
  } catch (error) {
    return null;
  }
}

async function saveMeliToken(data) {
  const current = await readMeliToken();
  const record = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || (current && current.refresh_token) || "",
    expires_at: Date.now() + (Number(data.expires_in) || 21600) * 1000,
    user_id: data.user_id || (current && current.user_id) || null,
    obtained_at: Date.now()
  };
  await fs.writeFile(MELI_TOKEN_FILE, JSON.stringify(record, null, 2), { mode: 0o600 });
  try {
    await fs.chmod(MELI_TOKEN_FILE, 0o600);
  } catch (error) {
    // permisos no disponibles en algunos sistemas
  }
  return record;
}

async function getMeliAccessToken() {
  if (!hasMeliCredentials()) return null;
  const token = await readMeliToken();
  if (!token) return null;
  if (token.expires_at && token.expires_at > Date.now() + 60000) {
    return token.access_token;
  }
  if (!token.refresh_token) return null;
  const refreshed = await meliRequestToken({
    grant_type: "refresh_token",
    client_id: MELI_CLIENT_ID,
    client_secret: MELI_CLIENT_SECRET,
    refresh_token: token.refresh_token
  });
  await saveMeliToken(refreshed);
  return refreshed.access_token;
}

async function searchMercadoLibre(query) {
  const token = await getMeliAccessToken();
  if (!token) {
    throw new Error("Mercado Libre no está conectado");
  }

  const url =
    "https://api.mercadolibre.com/sites/MLM/search?q=" +
    encodeURIComponent(query) +
    `&limit=${MAX_RESULTS_PER_STORE}`;
  const response = await fetch(url, {
    headers: {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
      "User-Agent": USER_AGENT
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  const products = Array.isArray(data.results) ? data.results : [];
  const results = [];
  const seen = new Set();

  for (const product of products) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    if (!product) continue;
    const id = String(product.id || "");
    if (!id || seen.has(id)) continue;

    const title = cleanText(product.title);
    const price = Number(product.price) || 0;
    const permalink = String(product.permalink || "");
    if (!title || !price || !/^https:\/\//.test(permalink)) continue;

    const original = Number(product.original_price);
    const oldPrice =
      Number.isFinite(original) && original > price * 1.02 && original < price * 8
        ? original
        : 0;

    const thumbnail = String(product.thumbnail || "").replace(/^http:\/\//, "https://");

    results.push({
      id: `mercadolibre-${id}`,
      storeId: "mercadolibre",
      store: STORES.mercadolibre.name,
      icon: STORES.mercadolibre.icon,
      color: STORES.mercadolibre.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link: permalink,
      image: /^https:\/\//.test(thumbnail) ? thumbnail : "",
      source: "Mercado Libre",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(id);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Sears (Algolia)                                                     */
/* ------------------------------------------------------------------ */

async function searchSears(query) {
  const response = await fetch(
    `https://${SEARS_ALGOLIA_APP_ID}-dsn.algolia.net/1/indexes/${SEARS_ALGOLIA_INDEX}/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Algolia-API-Key": SEARS_ALGOLIA_KEY,
        "X-Algolia-Application-Id": SEARS_ALGOLIA_APP_ID,
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({
        query,
        hitsPerPage: MAX_RESULTS_PER_STORE,
        analytics: false
      })
    }
  );

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data.message || data.error || `HTTP ${response.status}`;
    throw new Error(message);
  }

  const hits = Array.isArray(data.hits) ? data.hits : [];
  const results = [];
  const seen = new Set();

  for (const hit of hits) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    if (!hit) continue;
    const objectId = String(hit.objectID || hit.sku || "");
    if (!objectId || seen.has(objectId)) continue;

    const title = cleanText(hit.title);
    const price = Number(hit.sale_price) || Number(hit.price) || 0;
    if (!title || !price) continue;

    const listPrice = Number(hit.price) || 0;
    const oldPrice =
      listPrice > price * 1.02 && listPrice < price * 8 ? listPrice : 0;

    if (hit.is_active === false || Number(hit.stock) <= 0) continue;

    const seo = slugify(title);
    const link = seo
      ? `https://www.sears.com.mx/producto/${objectId}/${seo}/`
      : `https://www.sears.com.mx/producto/${objectId}/`;

    const photos = Array.isArray(hit.photos) ? hit.photos : [];
    const photo = photos[0] || {};

    results.push({
      id: `sears-${objectId}`,
      storeId: "sears",
      store: STORES.sears.name,
      icon: STORES.sears.icon,
      color: STORES.sears.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link,
      image: photo.thumbnail || photo.source || "",
      source: "Sears",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(objectId);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Sanborns (Algolia)                                                  */
/* ------------------------------------------------------------------ */

async function fetchAlgoliaHits(appId, apiKey, index, query) {
  const response = await fetch(
    `https://${appId}-dsn.algolia.net/1/indexes/${index}/query`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Algolia-API-Key": apiKey,
        "X-Algolia-Application-Id": appId,
        "User-Agent": USER_AGENT
      },
      body: JSON.stringify({
        query,
        hitsPerPage: MAX_RESULTS_PER_STORE,
        analytics: false
      })
    }
  );
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.message || data.error || `HTTP ${response.status}`);
  }
  return Array.isArray(data.hits) ? data.hits : [];
}

async function searchSanborns(query) {
  const hits = await fetchAlgoliaHits(
    SANBORNS_ALGOLIA_APP_ID,
    SANBORNS_ALGOLIA_KEY,
    SANBORNS_ALGOLIA_INDEX,
    query
  );
  const results = [];
  const seen = new Set();

  for (const hit of hits) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    if (!hit) continue;
    const objectId = String(hit.objectID || hit.sku || "");
    if (!objectId || seen.has(objectId)) continue;

    const title = cleanText(hit.title);
    const price = Number(hit.sale_price) || Number(hit.price) || 0;
    if (!title || !price) continue;

    const listPrice = Number(hit.price) || 0;
    const oldPrice =
      listPrice > price * 1.02 && listPrice < price * 8 ? listPrice : 0;
    if (hit.is_active === false || Number(hit.stock) <= 0) continue;

    const seo = slugify(title);
    const link = seo
      ? `https://www.sanborns.com.mx/producto/${objectId}/${seo}/`
      : `https://www.sanborns.com.mx/producto/${objectId}/`;

    const photos = Array.isArray(hit.photos) ? hit.photos : [];
    const photo = photos[0] || {};

    results.push({
      id: `sanborns-${objectId}`,
      storeId: "sanborns",
      store: STORES.sanborns.name,
      icon: STORES.sanborns.icon,
      color: STORES.sanborns.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link,
      image: photo.thumbnail || photo.source || "",
      source: "Sanborns",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(objectId);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Suburbia (Jina Reader + tarjetas HTML)                              */
/* ------------------------------------------------------------------ */

async function fetchSuburbiaHtml(query) {
  const target =
    "https://www.suburbia.com.mx/tienda?s=" + encodeURIComponent(query);
  const wait = Math.max(0, lastJinaRequest + 2500 - Date.now());
  if (wait > 0) await sleep(wait);
  lastJinaRequest = Date.now();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  try {
    const response = await fetch(JINA_READER_URL + target, {
      signal: controller.signal,
      headers: {
        "X-Return-Format": "html",
        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
        "User-Agent": USER_AGENT
      }
    });
    if (!response.ok) throw new Error(`Jina Reader HTTP ${response.status}`);
    const html = await response.text();
    if (html.length < 2000) throw new Error("Respuesta vacía de Suburbia");
    if (/Application error|client-side exception/i.test(html.slice(0, 1200))) {
      throw new Error("Suburbia no pudo renderizar la búsqueda");
    }
    return html;
  } finally {
    clearTimeout(timer);
  }
}

async function searchSuburbia(query) {
  const html = await fetchSuburbiaHtml(query);
  const cardPattern =
    /<a[^>]*data-testid="([A-Za-z0-9]+)-card-card-link"[^>]*href="([^"]+)"[^>]*>\s*<section[^>]*data-testid="\1-card"[^>]*>([\s\S]*?)<\/section>/g;

  const results = [];
  const seen = new Set();
  let match;

  while ((match = cardPattern.exec(html)) && results.length < MAX_RESULTS_PER_STORE) {
    const sku = match[1];
    const href = match[2];
    const body = match[3];
    if (seen.has(sku)) continue;

    const title = cleanText(
      (body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]
    );
    if (!title) continue;

    const priceMarker = body.indexOf(`data-testid="${sku}-price"`);
    if (priceMarker < 0) continue;
    const priceChunk = body.slice(priceMarker, priceMarker + 2500);
    const price = parsePrice(priceChunk);
    if (!price) continue;

    let oldPrice = 0;
    const originalMatch = priceChunk.match(
      /data-testid="original"[^>]*>([\s\S]*?)(?=<\/span>\s*<\/span>|<div class="w-fit")/
    );
    if (originalMatch) {
      const candidate = parsePrice(originalMatch[1]);
      if (candidate > price * 1.02 && candidate < price * 8) oldPrice = candidate;
    }

    const image = (body.match(/<img[^>]*src="([^"]+)"/) || [])[1];
    const link = absoluteUrl("https://www.suburbia.com.mx", href);
    if (!link) continue;

    results.push({
      id: `suburbia-${sku}`,
      storeId: "suburbia",
      store: STORES.suburbia.name,
      icon: STORES.suburbia.icon,
      color: STORES.suburbia.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link,
      image: image ? absoluteUrl("https://www.suburbia.com.mx", image) : "",
      source: "Suburbia",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(sku);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Chedraui (VTEX Intelligent Search)                                  */
/* ------------------------------------------------------------------ */

async function searchChedraui(query) {
  const url =
    "https://www.chedraui.com.mx/api/io/_v/api/intelligent-search/product_search" +
    `?query=${encodeURIComponent(query)}&locale=es-MX&count=${MAX_RESULTS_PER_STORE}`;
  const data = await politeFetchJson("chedraui", url);
  const products = Array.isArray(data && data.products) ? data.products : [];
  const results = [];
  const seen = new Set();

  for (const product of products) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    if (!product) continue;
    const productId = String(product.productId || product.productReference || "");
    if (!productId || seen.has(productId)) continue;

    const title = cleanText(product.productName || product.productTitle);
    if (!title) continue;

    const offers = [];
    for (const item of product.items || []) {
      for (const seller of item.sellers || []) {
        const offer = seller.commertialOffer || {};
        const price = Number(offer.Price);
        const available = Number(offer.AvailableQuantity);
        if (Number.isFinite(price) && price > 0 && available > 0) {
          offers.push({
            price,
            listPrice: Number(offer.ListPrice) || 0,
            seller: seller.sellerName || ""
          });
        }
      }
    }
    if (!offers.length) continue;
    offers.sort((a, b) => a.price - b.price);
    const best = offers[0];

    const oldPrice =
      best.listPrice > best.price * 1.02 && best.listPrice < best.price * 8
        ? best.listPrice
        : 0;

    const link = absoluteUrl(
      "https://www.chedraui.com.mx",
      product.link || ""
    );
    if (!link) continue;

    const firstItem = (product.items || [])[0] || {};
    const firstImage = (firstItem.images || [])[0] || {};
    const categories = Array.isArray(product.categories) ? product.categories : [];
    const category = categories.length
      ? categories[0].split("/").filter(Boolean).pop() || "En vivo"
      : "En vivo";

    results.push({
      id: `chedraui-${productId}`,
      storeId: "chedraui",
      store: STORES.chedraui.name,
      icon: STORES.chedraui.icon,
      color: STORES.chedraui.color,
      type: "tienda",
      product: title,
      category,
      price: best.price,
      old: oldPrice,
      discount: discountPercent(oldPrice, best.price),
      link,
      image: firstImage.imageUrl || "",
      source: "Chedraui",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(productId);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* La Comer (buscador Amarello)                                        */
/* ------------------------------------------------------------------ */

async function searchLaComer(query) {
  const params = new URLSearchParams({
    s: query,
    p: "1",
    succId: COMER_SUCC_ID,
    col: "lacomer_2",
    npagel: String(MAX_RESULTS_PER_STORE),
    patrocinados: "false"
  });
  const data = await politeFetchJson("lacomer", `${COMER_SEARCH_URL}?${params}`);
  const products = Array.isArray(data && data.res) ? data.res : [];
  const results = [];
  const seen = new Set();

  for (const product of products) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    if (!product) continue;
    const artEan = String(product.artEan || product.artCod || "");
    if (!artEan || seen.has(artEan)) continue;

    const title = cleanText(product.artDesCom || product.artDes);
    const price = Number(product.artPrven);
    const stock = Number(product.inveCant);
    if (!title || !price || (Number.isFinite(stock) && stock <= 0)) continue;

    const listPrice = Number(product.artPrlin) || 0;
    const oldPrice =
      listPrice > price * 1.02 && listPrice < price * 8 ? listPrice : 0;

    const agruId = Number(product.agruId) || 0;
    const link =
      `https://www.lacomer.com.mx/lacomer/#!/detarticulo/${artEan}/0/${agruId}/1//${agruId}`;

    results.push({
      id: `lacomer-${artEan}`,
      storeId: "lacomer",
      store: STORES.lacomer.name,
      icon: STORES.lacomer.icon,
      color: STORES.lacomer.color,
      type: "tienda",
      product: title,
      category: cleanText(product.agruDes) || "En vivo",
      price,
      old: oldPrice,
      discount: discountPercent(oldPrice, price),
      link,
      image: `https://www.lacomer.com.mx/superc/img_art/${artEan}_1.jpg`,
      source: "La Comer",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(artEan);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Home Depot México (HTML de búsqueda)                                */
/* ------------------------------------------------------------------ */

async function searchHomeDepot(query) {
  const url = `https://www.homedepot.com.mx/s/${encodeURIComponent(query)}`;
  const html = await politeFetch("homedepot", url);
  const starts = [];
  const cardPattern =
    /<div[^>]*id="recommendProd_(\d+)"[^>]*data-testid="\1"[^>]*>/g;
  let startMatch;
  while ((startMatch = cardPattern.exec(html))) {
    starts.push({ sku: startMatch[1], index: startMatch.index });
  }

  const results = [];
  const seen = new Set();

  for (let index = 0; index < starts.length; index++) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    const { sku, index: start } = starts[index];
    if (seen.has(sku)) continue;
    const end = starts[index + 1] ? starts[index + 1].index : start + 18000;
    const block = html.slice(start, end);

    const nameHtml = block.match(
      new RegExp(`data-testid="${sku}-name"[^>]*>([\\s\\S]*?)<\\/a>`)
    );
    const title = cleanText(nameHtml && nameHtml[1]);
    if (!title) continue;

    const priceBlock = block.match(
      /<div class="product-price[^"]*"[^>]*>([\s\S]*?)<\/div><\/div>/
    );
    if (!priceBlock) continue;
    const priceText = cleanText(priceBlock[1]);
    const priceMatch = priceText.match(/\$\s*([\d,]+)(?:\s*(\d{2}))?/);
    if (!priceMatch) continue;
    const price =
      Number(priceMatch[1].replace(/,/g, "")) +
      (priceMatch[2] ? Number(priceMatch[2]) / 100 : 0);
    if (!price) continue;

    const linkMatch = block.match(/href="(\/p\/[^"]+)"/);
    const link = linkMatch
      ? absoluteUrl("https://www.homedepot.com.mx", linkMatch[1])
      : "";
    if (!link) continue;

    const imageMatch = block.match(/<img[^>]*src="([^"]+)"/);
    const image = imageMatch
      ? absoluteUrl("https://www.homedepot.com.mx", imageMatch[1])
      : `https://cdn.homedepot.com.mx/productos/${sku}/${sku}.jpg`;

    results.push({
      id: `homedepot-${sku}`,
      storeId: "homedepot",
      store: STORES.homedepot.name,
      icon: STORES.homedepot.icon,
      color: STORES.homedepot.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price,
      old: 0,
      discount: 0,
      link,
      image,
      source: "Home Depot",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(sku);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Soriana (Google Translate como puente)                              */
/* ------------------------------------------------------------------ */

async function searchSoriana(query) {
  const url =
    "https://www-soriana-com.translate.goog/buscar?q=" +
    encodeURIComponent(query) +
    "&_x_tr_sl=es&_x_tr_tl=en&_x_tr_hl=en";
  const html = await politeFetch("soriana", url);

  const starts = [];
  const cardPattern = /<div class="product" data-pid="(\d+)"[^>]*>/g;
  let match;
  while ((match = cardPattern.exec(html))) {
    starts.push({ pid: match[1], index: match.index });
  }

  const results = [];
  const seen = new Set();

  for (let index = 0; index < starts.length; index++) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    const { pid, index: start } = starts[index];
    if (seen.has(pid)) continue;
    const end = starts[index + 1] ? starts[index + 1].index : start + 20000;
    const block = html.slice(start, end);

    const links = Array.from(
      block.matchAll(/<a[^>]*class="[^"]*product-tile--link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)
    );
    const nameLink = links.find((entry) => cleanText(entry[2]));
    if (!nameLink) continue;

    const title = cleanText(nameLink[2]);
    const rawLink = nameLink[1].replace(/&amp;/g, "&");
    let link = rawLink;
    if (link.startsWith("https://www-soriana-com.translate.goog")) {
      link = link.replace(
        "https://www-soriana-com.translate.goog",
        "https://www.soriana.com"
      );
    }
    link = link
      .replace(/([?&])_x_tr_[^&]+/g, "$1")
      .replace(/[?&]+$/, "");
    if (!/^https:\/\//.test(link)) continue;

    const currentPrice = block.match(
      /name="clevertap-price"[^>]*value="([\d.]+)"/
    );
    const listPrice = block.match(
      /name="clevertap-list-price"[^>]*value="([\d.]+)"/
    );
    const rawPrice = Number(currentPrice ? currentPrice[1] : 0) ||
      Number(listPrice ? listPrice[1] : 0);
    if (!rawPrice) continue;

    const listValue = Number(listPrice ? listPrice[1] : 0);
    const oldPrice =
      listValue > rawPrice * 1.02 && listValue < rawPrice * 8
        ? listValue
        : 0;

    const imageMatch = block.match(/<img[^>]*src="([^"]+)"/);

    results.push({
      id: `soriana-${pid}`,
      storeId: "soriana",
      store: STORES.soriana.name,
      icon: STORES.soriana.icon,
      color: STORES.soriana.color,
      type: "tienda",
      product: title,
      category: "En vivo",
      price: rawPrice,
      old: oldPrice,
      discount: discountPercent(oldPrice, rawPrice),
      link,
      image: imageMatch ? absoluteUrl("https://www.soriana.com", imageMatch[1]) : "",
      source: "Soriana",
      kind: "store",
      live: true,
      fetchedAt: Date.now()
    });

    seen.add(pid);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Domino's Pizza (menú y cupones por sucursal)                        */
/* ------------------------------------------------------------------ */

async function searchDominos(query) {
  const menuUrl =
    `https://order.golo04.dominos.com/power/store/${DOMINOS_STORE_ID}/menu`;
  const data = await politeFetchJson("dominos", menuUrl);
  const table = data && data.Coupons;
  if (!table || !Array.isArray(table.Columns) || !Array.isArray(table.Data)) {
    return [];
  }

  const index = Object.fromEntries(table.Columns.map((column, position) => [column, position]));
  const rows = table.Data.map((row) => {
    const coupon = {};
    table.Columns.forEach((column, position) => { coupon[column] = row[position]; });
    return coupon;
  });

  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const queryTokens = normalize(query).split(/\s+/).filter((token) => token.length >= 3);

  const results = [];
  const seen = new Set();

  for (const coupon of rows) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    const code = String(coupon.Code || "");
    if (!code || seen.has(code)) continue;
    const haystack = normalize(`${coupon.Name} ${coupon.Description}`);
    if (queryTokens.length && !queryTokens.some((token) => haystack.includes(token))) {
      continue;
    }

    const tags = String(coupon.Tags || "");
    const priceMatch =
      tags.match(/(?:^|,)BasePrice=([\d.]+)/) ||
      String(coupon.PriceInfo || "").match(/(?:^|,)Value=([\d.]+)/);
    const price = priceMatch
      ? Number(priceMatch[1])
      : Number(coupon.Price) || 0;
    if (!price) continue;

    const couponName = cleanText(coupon.Name);
    const couponDescription = cleanText(coupon.Description);
    const title =
      couponDescription && couponDescription.length <= 80
        ? couponDescription
        : couponName || couponDescription;
    if (!title) continue;

    const service = /ServiceMethodOverride=Carryout/i.test(tags)
      ? "Solo recoger"
      : /ServiceMethodOverride=Delivery/i.test(tags)
        ? "Solo delivery"
        : "Promo";

    const link =
      "https://www.dominos.com.mx/pages/order/#!/order/coupons/new?code=" +
      encodeURIComponent(code);

    results.push({
      id: `dominos-${code}`,
      storeId: "dominos",
      store: STORES.dominos.name,
      icon: STORES.dominos.icon,
      color: STORES.dominos.color,
      type: "restaurante",
      product: title,
      category: "Promos",
      price,
      old: 0,
      discount: 0,
      link,
      image: coupon.ThumbNailSizeImageURL || coupon.LargeSizeImageURL || "",
      source: "Domino's Pizza",
      kind: "store",
      live: true,
      code,
      promo: service,
      fetchedAt: Date.now()
    });

    seen.add(code);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Starbucks (menú de Rappi, sucursal Portales Norte)                  */
/* ------------------------------------------------------------------ */

async function searchStarbucks(query) {
  const url =
    "https://www.rappi.com.mx/restaurantes/1306704225-starbucks";
  const html = await politeFetch("starbucks", url);

  const normalize = (value) =>
    String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "");
  const queryTokens = /starbucks/i.test(query)
    ? []
    : normalize(query).split(/\s+/).filter((token) => token.length >= 3);

  const starts = [];
  const cardPattern = /data-qa="product-item-(\d+)"/g;
  let match;
  while ((match = cardPattern.exec(html))) {
    starts.push({ id: match[1], index: match.index });
  }

  const results = [];
  const seen = new Set();

  for (let index = 0; index < starts.length; index++) {
    if (results.length >= MAX_RESULTS_PER_STORE) break;
    const { id: productId, index: start } = starts[index];
    if (seen.has(productId)) continue;
    const end = starts[index + 1] ? starts[index + 1].index : start + 12000;
    const block = html.slice(start, end);

    const nameMatch = block.match(/<h4[^>]*>([\s\S]*?)<\/h4>/);
    const descriptionMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const title = cleanText(nameMatch && nameMatch[1]);
    const description = cleanText(descriptionMatch && descriptionMatch[1]);
    if (!title) continue;

    const haystack = normalize(`${title} ${description}`);
    if (queryTokens.length && !queryTokens.some((token) => haystack.includes(token))) {
      continue;
    }

    const priceMatches = Array.from(
      block.matchAll(/<span[^>]*>\s*\$\s*([\d,.]+)\s*<\/span>/g)
    ).map((entry) => Number(entry[1].replace(/,/g, "")));
    if (!priceMatches.length) continue;

    const price = priceMatches[0];
    const old = priceMatches[1] > price ? priceMatches[1] : 0;
    if (!price) continue;

    const imageMatch = block.match(
      /<noscript>[\s\S]*?<img[^>]*src="([^"]+)"/
    );

    results.push({
      id: `starbucks-${productId}`,
      storeId: "starbucks",
      store: STORES.starbucks.name,
      icon: STORES.starbucks.icon,
      color: STORES.starbucks.color,
      type: "restaurante",
      product: title,
      category: "Menú",
      price,
      old,
      discount: discountPercent(old, price),
      link: url,
      image: imageMatch
        ? imageMatch[1].replace(/&amp;/g, "&")
        : "",
      source: "Starbucks · Rappi",
      kind: "store",
      live: true,
      promo: "Rappi",
      fetchedAt: Date.now()
    });

    seen.add(productId);
  }

  return results;
}

/* ------------------------------------------------------------------ */
/* Búsqueda combinada                                                  */
/* ------------------------------------------------------------------ */

function interleaveMany(lists) {
  const merged = [];
  const length = lists.reduce((max, list) => Math.max(max, list.length), 0);
  for (let index = 0; index < length; index++) {
    for (const list of lists) {
      if (list[index]) merged.push(list[index]);
    }
  }
  return merged;
}

async function runSearch(query) {
  const startedAt = Date.now();
  const searches = [
    ["amazon", searchAmazon],
    ["liverpool", searchLiverpool],
    ["samsclub", searchSamsClub],
    ["walmart", searchWalmart],
    ["costco", searchCostco],
    ["sears", searchSears],
    ["sanborns", searchSanborns],
    ["suburbia", searchSuburbia],
    ["chedraui", searchChedraui],
    ["lacomer", searchLaComer],
    ["homedepot", searchHomeDepot],
    ["soriana", searchSoriana],
    ["dominos", searchDominos],
    ["starbucks", searchStarbucks]
  ];
  if (hasMeliCredentials() && (await readMeliToken())) {
    searches.push(["mercadolibre", searchMercadoLibre]);
  }
  const settled = await Promise.allSettled(
    searches.map(([, search]) => search(query))
  );

  const sources = {};
  const lists = [];

  searches.forEach(([id], index) => {
    const result = settled[index];
    const offers = result.status === "fulfilled" ? result.value : [];
    lists.push(offers);
    sources[id] = {
      ok: result.status === "fulfilled",
      count: offers.length,
      ...(result.status === "rejected"
        ? { error: String(result.reason && result.reason.message || result.reason) }
        : {})
    };
  });

  const payload = {
    query,
    updatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    results: interleaveMany(lists),
    sources
  };

  console.log(
    `[buscar] "${query}" · ` +
    Object.entries(sources)
      .map(([id, source]) => `${STORES[id].name} ${source.ok ? source.count : "error"}`)
      .join(" · ") +
    ` · ${payload.elapsedMs} ms`
  );

  return payload;
}

async function getSearchResults(query) {
  const key = query.toLowerCase();
  const cached = cache.get(key);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return { ...cached.payload, cached: true };
  }

  if (pending.has(key)) return pending.get(key);

  const promise = runSearch(query)
    .then((payload) => {
      cache.set(key, { timestamp: Date.now(), payload });
      return payload;
    })
    .finally(() => pending.delete(key));

  pending.set(key, promise);
  return promise;
}

/* ------------------------------------------------------------------ */
/* Servidor HTTP                                                       */
/* ------------------------------------------------------------------ */

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  response.end(body);
}

function sendText(response, status, text) {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text)
  });
  response.end(text);
}

function sendHtml(response, status, html) {
  response.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store"
  });
  response.end(html);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[character]));
}

function authResultPage(title, message, success) {
  const color = success ? "#0f8a4f" : "#b3300f";
  const background = success ? "#eafaf1" : "#fff1ec";
  return `<!doctype html>
<html lang="es-MX"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Ofertazo</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f7f4ef;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1c1917}
  .card{width:min(440px,calc(100% - 40px));background:#fff;border:1px solid #e7e0d6;border-radius:22px;padding:28px;box-shadow:0 24px 60px -30px rgba(0,0,0,.35)}
  .badge{display:inline-block;background:${background};color:${color};border-radius:999px;padding:5px 11px;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase}
  h1{font-size:1.35rem;letter-spacing:-.03em;margin:16px 0 8px}
  p{color:#78716c;font-size:.9rem;line-height:1.6;margin:0 0 18px;overflow-wrap:anywhere}
  a{display:inline-block;background:#1c1917;color:#fff;text-decoration:none;border-radius:10px;padding:10px 14px;font-size:.84rem;font-weight:700}
  a.secondary{background:transparent;color:#78716c;border:1px solid #e7e0d6;margin-left:6px}
</style></head>
<body><main class="card">
  <span class="badge">${success ? "Conectado" : "Atención"}</span>
  <h1>${escapeHtml(title)}</h1>
  <p>${message}</p>
  <a href="/">Volver al buscador</a>
  <a class="secondary" href="/auth/mercadolibre">Reintentar</a>
</main></body></html>`;
}

const STATIC_FILES = new Map([
  ["/", ["buscador-ofertas.html", "text/html; charset=utf-8"]],
  ["/buscador-ofertas.html", ["buscador-ofertas.html", "text/html; charset=utf-8"]],
  ["/preview-ofertas.png", ["preview-ofertas.png", "image/png"]],
  ["/preview-ofertas-resultados.png", ["preview-ofertas-resultados.png", "image/png"]],
  ["/preview-ofertas-filtros.png", ["preview-ofertas-filtros.png", "image/png"]]
]);

async function serveStatic(response, pathname) {
  const entry = STATIC_FILES.get(pathname);
  if (!entry) return false;
  const [filename, mime] = entry;
  try {
    const data = await fs.readFile(path.join(ROOT, filename));
    response.writeHead(200, {
      "Content-Type": mime,
      "Content-Length": data.length,
      "Cache-Control": "no-cache"
    });
    response.end(data);
    return true;
  } catch (error) {
    sendText(response, 404, "Archivo no encontrado");
    return true;
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "OPTIONS") {
      response.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type"
      });
      response.end();
      return;
    }

    if (request.method !== "GET") {
      sendJson(response, 405, { ok: false, error: "Método no permitido" });
      return;
    }

    if (url.pathname === "/auth/mercadolibre") {
      if (!hasMeliCredentials()) {
        sendHtml(response, 500, authResultPage(
          "Falta configurar Mercado Libre",
          "Agrega MELI_CLIENT_ID y MELI_CLIENT_SECRET al archivo .env y reinicia el servidor.",
          false
        ));
        return;
      }
      response.writeHead(302, {
        "Location": buildMeliAuthUrl(),
        "Cache-Control": "no-store"
      });
      response.end();
      return;
    }

    if (url.pathname === "/auth/mercadolibre/callback") {
      const oauthError = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (oauthError || !code) {
        sendHtml(response, 400, authResultPage(
          "No se autorizó Mercado Libre",
          "Mercado Libre devolvió: " + escapeHtml(oauthError || "falta el código de autorización") + ".",
          false
        ));
        return;
      }
      try {
        const token = await meliRequestToken({
          grant_type: "authorization_code",
          client_id: MELI_CLIENT_ID,
          client_secret: MELI_CLIENT_SECRET,
          code,
          redirect_uri: MELI_REDIRECT_URI
        });
        await saveMeliToken(token);

        let userError = "";
        try {
          const meResponse = await fetch("https://api.mercadolibre.com/users/me", {
            headers: {
              "Authorization": `Bearer ${token.access_token}`,
              "Accept": "application/json"
            }
          });
          if (!meResponse.ok) {
            const detail = await meResponse.json().catch(() => ({}));
            userError = detail.message || `HTTP ${meResponse.status}`;
          }
        } catch (error) {
          userError = String(error.message || error);
        }

        if (userError) {
          sendHtml(response, 502, authResultPage(
            "Conexión creada, pero la cuenta no está activa",
            "Mercado Libre respondió: " + escapeHtml(userError) +
            ". Completa la validación de tu cuenta en Mercado Libre y vuelve a autorizar.",
            false
          ));
          return;
        }

        sendHtml(response, 200, authResultPage(
          "Mercado Libre conectado",
          "La búsqueda en vivo de Mercado Libre ya está habilitada. Vuelve al buscador y prueba con un artículo.",
          true
        ));
      } catch (error) {
        sendHtml(response, 502, authResultPage(
          "No se pudo conectar Mercado Libre",
          escapeHtml(error.message || String(error)),
          false
        ));
      }
      return;
    }

    if (url.pathname === "/auth/mercadolibre/status") {
      const token = await readMeliToken();
      sendJson(response, 200, {
        ok: true,
        configured: hasMeliCredentials(),
        connected: Boolean(token),
        expired: token ? Number(token.expires_at || 0) <= Date.now() : null,
        expiresAt: token ? token.expires_at : null
      });
      return;
    }

    if (url.pathname === "/api/health") {
      const meliToken = await readMeliToken();
      sendJson(response, 200, {
        ok: true,
        service: "buscador-ofertas",
        stores: Object.keys(STORES),
        mercadolibre: {
          configured: hasMeliCredentials(),
          connected: Boolean(meliToken)
        }
      });
      return;
    }

    if (url.pathname === "/api/search") {
      const query = String(url.searchParams.get("q") || "").trim().slice(0, 80);
      if (query.length < MIN_QUERY_LENGTH) {
        sendJson(response, 400, {
          ok: false,
          error: `Escribe al menos ${MIN_QUERY_LENGTH} caracteres`
        });
        return;
      }

      const payload = await getSearchResults(query);
      sendJson(response, 200, { ok: true, ...payload });
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      sendJson(response, 404, { ok: false, error: "Ruta no encontrada" });
      return;
    }

    if (await serveStatic(response, url.pathname)) return;
    sendText(response, 404, "No encontrado");
  } catch (error) {
    console.error("[error]", error);
    sendJson(response, 500, {
      ok: false,
      error: "Error interno del servidor"
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Buscador de ofertas en vivo");
  console.log(`  → http://${HOST}:${PORT}`);
  console.log("  Fuentes: Amazon + Liverpool + Sam's Club + Walmart + Costco + Sears + Sanborns + Suburbia + Chedraui + La Comer + Home Depot + Soriana + Domino's + Starbucks + Mercado Libre (si está conectado)");
  console.log(`  Mercado Libre: ${MELI_CLIENT_ID ? "configurado" : "sin configurar"} → http://${HOST}:${PORT}/auth/mercadolibre`);
  console.log("  Detén el servidor con Ctrl+C");
  console.log("");
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`El puerto ${PORT} ya está ocupado. Prueba: PORT=8790 node server.js`);
  } else {
    console.error(error);
  }
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nServidor detenido.");
  server.close(() => process.exit(0));
});
