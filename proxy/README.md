# SmartReviz — Proxy Cloudflare Worker

Relais entre le front (GitHub Pages) et le service d'inférence LLM.
La clé API n'est **jamais** exposée au navigateur : elle vit dans les secrets du Worker.

```
Front (app.js)  ──POST──►  smartreviz-proxy (ce Worker)  ──►  https://llm.ilaas.fr/v1/chat/completions
   { system, messages,                                          Authorization: Bearer <ILAAS_API_KEY>
     max_tokens, response_format }                              model: mistral-small-4-119b
```

## Streaming : le Worker ne parse rien

Le Worker demande `stream: true` à ILAAS et **relaie le flux SSE tel quel** au
navigateur. Deux raisons, l'une et l'autre mesurées le 10/09/2026 :

1. **Sans streaming, la passerelle ILAAS coupe.** Une génération dure 25 à 60 s ;
   au-delà d'environ 60 s d'inactivité la passerelle renvoie un `504 Gateway
   Time-out` (parfois sous forme de page HTML avec un statut 200). En streaming
   les octets circulent en continu, la connexion n'est jamais inactive.
2. **Le Worker n'a pas le CPU pour réassembler.** Le plan Workers gratuit plafonne
   à 10 ms de CPU par requête ; parser les ~6 000 fragments SSE d'une génération
   dépassait ce plafond une fois sur trois (`Worker exceeded resource limits`,
   HTTP 503). Relayer le corps ne coûte quasiment rien.

C'est donc `readSSEStream()` dans `app.js` qui recolle les fragments — côté
navigateur, ce plafond n'existe pas.

Le chemin non-streamé reste en place comme repli : il normalise alors la réponse
OpenAI (`choices[0].message.content`) vers le format attendu par `app.js` :

```json
{ "content": [ { "type": "text", "text": "…" } ] }
```

## Configuration

`wrangler.toml` porte les variables **non secrètes** :

| Variable | Valeur | Rôle |
|---|---|---|
| `ILAAS_BASE`  | `https://llm.ilaas.fr/v1` | URL de base (compatible OpenAI) |
| `ILAAS_MODEL` | `mistral-small-4-119b`    | Modèle souverain (infra CINES) |

La **clé API** est un secret :

```bash
cd smartreviz/proxy
npx wrangler secret put ILAAS_API_KEY   # coller la clé fournie par le consortium ILAAS
```

## Déploiement

```bash
cd smartreviz/proxy
npx wrangler deploy
```

Le nom `smartreviz-proxy` (dans `wrangler.toml`) doit rester identique pour conserver
l'URL `https://smartreviz-proxy.julienmorice.workers.dev` déjà câblée dans `app.js`.

Alternative sans `wrangler` : copier/coller le contenu de `worker.js` dans l'éditeur
rapide du dashboard Cloudflare (Workers & Pages → smartreviz-proxy → Edit code), puis
définir `ILAAS_API_KEY` dans Settings → Variables and Secrets (type *Secret*), et
`ILAAS_BASE` / `ILAAS_MODEL` en variables texte.

## Ajouter un 2e moteur plus tard (ex. GLM 5 via OpenRouter)

1. Décommenter `OPENROUTER_BASE` / `OPENROUTER_MODEL` dans `wrangler.toml`.
2. `npx wrangler secret put OPENROUTER_API_KEY`
3. Côté front : envoyer `engine: "openrouter"` dans le corps de la requête
   (voir la table `ENGINES` dans `worker.js`).

## Test rapide

```bash
curl -X POST https://smartreviz-proxy.julienmorice.workers.dev \
  -H "Content-Type: application/json" \
  -d '{"system":"Réponds en JSON: {\"ok\":true}","messages":[{"role":"user","content":"test"}],"max_tokens":50,"response_format":{"type":"json_object"}}'
```
