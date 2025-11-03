// update_sede_disponibilita.js – versione con quantities()
// Aggiorna custom.sede_disponibilita scegliendo la prima sede con available > 0

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '400', 10);
const API_VERSION = '2025-10';

if (!SHOP || !TOKEN) {
  console.error('❌ Missing env: SHOPIFY_SHOP_DOMAIN and/or SHOPIFY_ACCESS_TOKEN');
  process.exit(1);
}

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
  try { json = JSON.parse(text); } catch {
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

// ⚠️ USIAMO quantities(names:["available"]) al posto di InventoryLevel.available
const qVariants = `
query($after: String) {
  productVariants(first: 200, after: $after, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        sku
        inventoryItem {
          id
          inventoryLevels(first: 50) {
            edges {
              node {
                location { id name }
                quantities(names: ["available"]) { name quantity }
              }
            }
          }
        }
      }
    }
  }
}
`;

const mSet = `
mutation setMeta($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { key value owner { id } }
    userErrors { field message }
  }
}
`;

function chooseLocation(levels) {
  // Priorità in lower-case normalizzata
  const priorityNorm = PRIORITY.map(n => n.trim().toLowerCase());

  // 2a. Rispetta la priorità se i nomi combaciano (case-insensitive)
  for (const wantedNorm of priorityNorm) {
    const lvl = levels.find(l => l.locationNameNorm === wantedNorm);
    if (lvl && (lvl.available || 0) > 0) return lvl.location.name; // restituisci il nome originale
  }

  // 2b. Fallback intelligente: prima location con available > 0, anche se il nome non è in PRIORITY
  const any = levels.find(l => (l.available || 0) > 0);
  if (any) return any.location?.name || "";

  // Nessuna disponibilità
  return "";
}


async function run() {
  console.log(`▶ Start. Shop: ${SHOP}`);
  console.log(`Priority: ${PRIORITY.join(' > ')}`);
  console.log(`API: ${API_VERSION}`);

  // Sanity check token/scopes
  await GQL(`{ shop { name } }`, {});

  let after = null;
  let processed = 0, updated = 0;

  while (processed < VARIANTS_PER_RUN) {
    const data = await GQL(qVariants, { after });
    const edges = data.productVariants.edges || [];
    if (edges.length === 0) break;

    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;
      processed++;

// Mappa livelli: estrae quantity da quantities e logga le sedi disponibili
const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => {
  const qAvail = (e.node.quantities || []).find(q => q.name === 'available');
  return {
    available: qAvail ? (qAvail.quantity || 0) : 0,
    location: e.node.location,
    locationNameNorm: (e.node.location?.name || "").trim().toLowerCase()
  };
});

// Log diagnostico (vedi esattamente i nomi sedi restituiti)
console.log(
  `Levels for ${node.sku || node.title}:`,
  levels.map(l => `${l.location?.name}:${l.available}`).join(" | ")
);


      const chosen = chooseLocation(levels);

      const metafields = [{
        ownerId: node.id,
        namespace: "custom",
        key: "sede_disponibilita",
        type: "single_line_text_field",
        value: chosen
      }];

      try {
        const res = await GQL(mSet, { metafields });
        const errs = res.metafieldsSet.userErrors || [];
        if (errs.length) {
          console.error(`⚠️ UserErrors per ${node.sku || node.title}:`, JSON.stringify(errs));
        } else {
          updated++;
          console.log(`✔ ${node.sku || node.title} -> "${chosen || '(vuoto)'}"`);
        }
      } catch (e) {
        console.error(`❌ Mutation error per ${node.sku || node.title}:`, e.message);
      }
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  console.log(`✅ Done. Processed: ${processed}, Updated: ${updated}`);
}

run().catch(e => {
  console.error('💥 Task failed:', e.message);
  process.exit(1);
});
