// update_sede_disponibilita.js – COMPLETO
// Aggiorna il metafield di VARIANTE custom.sede_disponibilita scegliendo
// la prima sede con stock > 0 secondo una priorità definita.
// Richiede Admin API scopes: read_products, write_products, read_inventory, read_locations.

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
// Puoi cambiare l'ordine con il secret LOCATION_PRIORITY (separatore "|")
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano')
  .split('|')
  .map(s => s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '10000', 30);
const API_VERSION = '2025-10';

if (!SHOP || !TOKEN) {
  console.error('❌ Missing env: SHOPIFY_SHOP_DOMAIN and/or SHOPIFY_ACCESS_TOKEN');
  process.exit(1);
}

// Helper GraphQL
async function GQL(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'X-Shopify-Access-Token': TOKEN
    },
    body: JSON.stringify({ query, variables })
  });

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch {
    console.error(`❌ GraphQL HTTP ${res.status} ${res.statusText} – Non-JSON body:\n${text}`);
    throw new Error(`GraphQL HTTP ${res.status}`);
  }

  if (!res.ok || json.errors) {
    console.error(`❌ GraphQL HTTP ${res.status} ${res.statusText}`);
    if (json.errors) console.error('Errors:', JSON.stringify(json.errors, null, 2));
    else console.error('Body:', JSON.stringify(json, null, 2));
    throw new Error('GraphQL error');
  }
  return json.data;
}

// Query varianti: usa quantities(names:["available"]) sui livelli
const qVariants = `
query($after: String) {
  productVariants(first: 200, after: $after, query:"status:active") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        sku
        metafield(namespace:"custom", key:"sede_disponibilita"){ value }
        inventoryItem {
          id
          inventoryLevels(first: 50) {
            edges {
              node {
                location { id name }
                quantities(names:["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
}
`;

// Mutation set metafield
const mSet = `
mutation setMeta($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { owner { id } key value }
    userErrors { field message }
  }
}
`;

// Scelta sede: rispetta PRIORITY case-insensitive; fallback alla prima con stock > 0
function chooseLocation(levels) {
  const prio = PRIORITY.map(n => n.trim().toLowerCase());
  for (const wanted of prio) {
    const m = levels.find(l => l.locationNameNorm === wanted);
    if (m && (m.available || 0) > 0) return m.location.name; // restituisce il nome originale
  }
  const any = levels.find(l => (l.available || 0) > 0);
  return any ? (any.location?.name || "") : "";
}

async function run() {
  console.log(`▶ Start. Shop: ${SHOP}`);
  console.log(`Priority: ${PRIORITY.join(' > ')}`);
  console.log(`API: ${API_VERSION}`);

  // Verifica token/scopes
  await GQL(`{ shop { name } }`, {});

  let after = null;
  let processed = 0, updated = 0;

  while (processed < VARIANTS_PER_RUN) {
    const data = await GQL(qVariants, { after });
    const edges = data.productVariants.edges || [];
    if (!edges.length) break;

    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;
      processed++;

      // Mappa livelli: quantity "available" + nomi normalizzati
      const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => {
        const qa = (e.node.quantities || []).find(q => q.name === 'available');
        return {
          available: qa ? (qa.quantity || 0) : 0,
          location: e.node.location,
          locationNameNorm: (e.node.location?.name || "").trim().toLowerCase()
        };
      });

      // Log diagnostico dei livelli (nomeSede:qty | ...)
      console.log(`Levels for ${node.sku || node.title}: ${levels.map(l => `${l.location?.name}:${l.available}`).join(' | ') || '—'}`);

      const chosen = chooseLocation(levels);
      const current = node.metafield?.value || "";

      // Se uguale al corrente, salta
      if (current === chosen) {
        continue;
      }

      // Prepara input metafield variante
      const metafields = [{
        ownerId: node.id,
        namespace: "custom",
        key: "sede_disponibilita",
        type: "single_line_text_field",
        value: chosen // può essere "" se nessuna sede ha stock
      }];

      try {
        const setRes = await GQL(mSet, { metafields });
        const errs = setRes.metafieldsSet.userErrors || [];
        if (errs.length) {
          console.error(`⚠️ UserErrors ${node.sku || node.title}:`, JSON.stringify(errs));
          continue;
        }

        // Rilettura per conferma
        const check = await GQL(
          `query($id:ID!){ productVariant(id:$id){ metafield(namespace:"custom", key:"sede_disponibilita"){ value } } }`,
          { id: node.id }
        );
        const afterVal = check.productVariant?.metafield?.value || "";
        console.log(`✔ ${node.sku || node.title}: before="${current}" -> after="${afterVal}"`);
        updated++;
      } catch (e) {
        console.error(`❌ Mutation error ${node.sku || node.title}:`, e.message);
      }
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  console.log(`✅ Done. Processed: ${processed}, Updated: ${updated}`);
}

run().catch(e => { console.error('💥 Task failed:', e.message); process.exit(1); });
