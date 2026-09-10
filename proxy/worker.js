/**
 * SmartReviz — Proxy Cloudflare Worker
 * -----------------------------------
 * Reçoit une requête du front (GitHub Pages), la relaie vers un service
 * d'inférence LLM compatible OpenAI (par défaut : ILAAS / llm.ilaas.fr),
 * puis normalise la réponse au format attendu par app.js :
 *
 *     { "content": [ { "type": "text", "text": "<réponse du modèle>" } ] }
 *
 * La clé API n'est jamais exposée au navigateur : elle vit dans les
 * secrets du Worker (voir wrangler.toml).
 *
 * Corps de requête attendu (POST, JSON) :
 *   {
 *     "system":          "<prompt système>",
 *     "messages":        [ { "role": "user", "content": "..." } ],
 *     "max_tokens":      8192,
 *     "response_format": { "type": "json_object" },   // optionnel
 *     "engine":          "ilaas"                       // optionnel, cf. ENGINES
 *   }
 */

// --- Moteurs disponibles -----------------------------------------------------
// Pour ajouter un 2e modèle plus tard (ex. GLM 5 via OpenRouter), ajouter une
// entrée ici et définir les secrets correspondants dans le Worker.
const ENGINES = {
  ilaas: {
    baseVar: "ILAAS_BASE", // ex. https://llm.ilaas.fr/v1
    keyVar: "ILAAS_API_KEY",
    modelVar: "ILAAS_MODEL", // ex. mistral-small-4-119b
  },
  openrouter: {
    baseVar: "OPENROUTER_BASE", // ex. https://openrouter.ai/api/v1
    keyVar: "OPENROUTER_API_KEY",
    modelVar: "OPENROUTER_MODEL", // ex. z-ai/glm-5
  },
};

const DEFAULT_ENGINE = "ilaas";

// Origines autorisées à appeler le proxy (CORS).
const ALLOWED_ORIGINS = [
  "https://julienmorice.github.io",
  "http://localhost:8080",
  "http://127.0.0.1:8080",
];

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status,
    headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return json({ error: { message: "Method not allowed" } }, 405, origin);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: { message: "Corps JSON invalide" } }, 400, origin);
    }

    // --- Sélection du moteur -------------------------------------------------
    const engineKey = (payload.engine || DEFAULT_ENGINE).toLowerCase();
    const engine = ENGINES[engineKey];
    if (!engine) {
      return json({ error: { message: "Moteur inconnu : " + engineKey } }, 400, origin);
    }

    const base = env[engine.baseVar];
    const apiKey = env[engine.keyVar];
    const model = env[engine.modelVar];
    if (!base || !apiKey || !model) {
      return json(
        { error: { message: "Proxy mal configuré (base/clé/modèle manquant pour " + engineKey + ")" } },
        500,
        origin
      );
    }

    // --- Construction de la requête OpenAI-compatible ----------------------
    const messages = [];
    if (payload.system) messages.push({ role: "system", content: payload.system });
    if (Array.isArray(payload.messages)) messages.push(...payload.messages);

    // On demande le flux en streaming : la génération dure 60 à 80 s, et un appel
    // bloquant se fait couper par la passerelle ILAAS (504 Gateway Time-out, de
    // façon erratique dès ~60 s). En streaming les octets circulent en continu,
    // la connexion ne reste jamais inactive. Le Worker réassemble le flux et
    // renvoie malgré tout UNE seule réponse JSON : le front ne voit aucune
    // différence.
    const upstreamBody = {
      model: model,
      messages: messages,
      max_tokens: payload.max_tokens || 8192,
      temperature: typeof payload.temperature === "number" ? payload.temperature : 0.4,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (payload.response_format) {
      upstreamBody.response_format = payload.response_format;
    }

    // --- Appel upstream ---------------------------------------------------
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 95000);

    let upstream;
    try {
      upstream = await fetch(base.replace(/\/$/, "") + "/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + apiKey,
        },
        body: JSON.stringify(upstreamBody),
        signal: controller.signal,
      });
    } catch (e) {
      clearTimeout(timeout);
      const msg = e.name === "AbortError" ? "TIMEOUT" : "Upstream injoignable : " + e.message;
      return json({ error: { message: msg } }, 504, origin);
    }

    // --- Cas streaming : relais direct du flux SSE -------------------------
    // Le Worker ne réassemble PAS le flux lui-même : le plan Workers gratuit
    // plafonne à 10 ms de CPU, et parser les ~6 000 fragments d'une génération
    // dépassait ce plafond une fois sur trois (« Worker exceeded resource
    // limits »). En relayant le corps tel quel, Cloudflare se contente de faire
    // transiter les octets : coût CPU quasi nul. C'est app.js qui réassemble,
    // sans limite côté navigateur.
    const contentType = upstream.headers.get("Content-Type") || "";
    if (upstream.ok && contentType.includes("text/event-stream")) {
      clearTimeout(timeout);
      return new Response(upstream.body, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...corsHeaders(origin),
        },
      });
    }

    // --- Cas non-streaming (repli) ----------------------------------------
    const raw = await upstream.text();
    clearTimeout(timeout);

    // La passerelle ILAAS renvoie parfois une page HTML « 504 Gateway Time-out »
    // avec un statut 200 : on la reconnaît pour remonter un vrai TIMEOUT plutôt
    // qu'un pavé de HTML à l'enseignant.
    if (/^\s*</.test(raw) && /gateway time-?out|didn't respond in time/i.test(raw)) {
      return json({ error: { message: "TIMEOUT" } }, 504, origin);
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      return json(
        { error: { message: "Réponse upstream non-JSON (" + upstream.status + ") : " + raw.slice(0, 300) } },
        502,
        origin
      );
    }

    if (!upstream.ok) {
      const message =
        (data && data.error && (data.error.message || data.error)) ||
        "Erreur upstream (" + upstream.status + ")";
      return json({ error: { message: message } }, upstream.status, origin);
    }

    // --- Normalisation vers le format attendu par app.js ------------------
    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (typeof text !== "string") {
      return json(
        { error: { message: "Réponse upstream inattendue : pas de choices[0].message.content" } },
        502,
        origin
      );
    }

    return json(
      {
        content: [{ type: "text", text: text }],
        model: data.model || model,
        usage: data.usage || null,
      },
      200,
      origin
    );
  },
};
