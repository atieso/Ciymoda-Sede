// update_sede_disponibilita.js
// versione con cursore persistente su METAFIELD DEL NEGOZIO
const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '50000', 10);
const API_VERSION = '2025-10';

if (!SHOP || !TOKEN) {
  console.error('❌ Missing env');
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
    console.error(text);
    throw new Error(`GraphQL HTTP ${res.status}`);
  }
  if (!res.ok || json.errors) {
    console.error('❌ GraphQL', res.status, res.statusText, JSON.stringify(json.errors || json, null, 2));
    throw new Error('GraphQL error');
  }
  return json.data;
}

// 1) leggo shop + metafield cursore
const Q_SHOP_CURSOR = `
{
  shop {
    id
    metafield(namespace:"custom", key:"variant_cursor") { value }
  }
}
`;

// 2) salvo shop metafield
const M_SET_SHOP_CURSOR = `
mutation setShopCursor($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

const Q_VARIANTS = `
query($after: String) {
  productVariants(first: 200, after: $after, query:"status:active") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        sku
        product { id title }
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

const M_SET_VARIANT_META = `
mutation setMeta($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

function chooseLocation(levels, priority) {
  const prio = priority.map(n => n.trim().toLowerCase());
  // prima rispetta la tua priorità
  for (const wanted of prio) {
    const m = levels.find(l => l.locationNameNorm === wanted);
    if (m && (m.available || 0) > 0) return m.location.name;
  }
  // poi prima sede con stock > 0
  const any = levels.find(l => (l.available || 0) > 0);
  return any ? (any.location?.name || "") : "";
}

async function run() {
  console.log(`▶ Start. shop=${SHOP}, batch=${VARIANTS_PER_RUN}`);

  // leggo cursore salvato nello shop
  const shopData = await GQL(Q_SHOP_CURSOR, {});
  const shopId = shopData.shop.id;
  let after = shopData.shop.metafield?.value || null;
  if (after) console.log(`📍 Riparto dal cursore Shopify: ${after.slice(0, 35)}...`);
  else console.log('📍 Nessun cursore precedente: parto dall’inizio');

  let processed = 0;
  let lastCursor = after;
  let hasNext = true;

  while (processed < VARIANTS_PER_RUN && hasNext) {
    const data = await GQL(Q_VARIANTS, { after: lastCursor });
    const { edges, pageInfo } = data.productVariants;
    if (!edges.length) {
      hasNext = false;
      break;
    }

    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;
      processed++;

      const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => {
        const qa = (e.node.quantities || []).find(q => q.name === 'available');
        return {
          available: qa ? (qa.quantity || 0) : 0,
          location: e.node.location,
          locationNameNorm: (e.node.location?.name || "").trim().toLowerCase()
        };
      });

      const chosen = chooseLocation(levels, PRIORITY);
      const current = node.metafield?.value || "";
      const totalAvail = levels.reduce((sum, l) => sum + (l.available || 0), 0);

      // niente stock da nessuna parte → salta
      if (!chosen && totalAvail === 0) continue;
      // già valorizzato correttamente → salta
      if (current === chosen) continue;

      const mfInput = [{
        ownerId: node.id,
        namespace: "custom",
        key: "sede_disponibilita",
        type: "single_line_text_field",
        value: chosen
      }];

      try {
        await GQL(M_SET_VARIANT_META, { metafields: mfInput });
        console.log(`✔ ${node.sku || node.title}: "${current}" -> "${chosen}"`);
      } catch (e) {
        console.error(`❌ mutation variante ${node.sku || node.title}:`, e.message);
      }
    }

    hasNext = pageInfo.hasNextPage;
    lastCursor = pageInfo.endCursor;
    console.log(`➡️ next? ${hasNext}  cursor=${lastCursor ? lastCursor.slice(0, 35)+'...' : 'null'}`);
  }

  // salva il cursore nello shop (anche null se abbiamo finito)
  try {
    const mfShop = [{
      ownerId: shopId,
      namespace: "custom",
      key: "variant_cursor",
      type: "single_line_text_field",
      value: lastCursor || ""
    }];
    await GQL(M_SET_SHOP_CURSOR, { metafields: mfShop });
    console.log(`💾 Cursore salvato nello shop: ${lastCursor ? lastCursor.slice(0,35)+'...' : '(vuoto/fine)'} `);
  } catch (e) {
    console.error('⚠️ Non sono riuscito a salvare il cursore nello shop:', e.message);
  }

  console.log(`✅ Done. Processed=${processed}`);
}

run().catch(e => { console.error('💥 Task failed:', e.message); process.exit(1); });
