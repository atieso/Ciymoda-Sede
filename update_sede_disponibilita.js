// update_sede_disponibilita.js
// Aggiorna il metafield di variante custom.sede_disponibilita
// Sedi in priorità da secret LOCATION_PRIORITY, default: "CityModa Lecce|Citymoda Triggiano"

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '400', 10);

// Usa API version stabile
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

  // Prova a fare parse JSON, se fallisce mostra raw
  let json;
  try { json = JSON.parse(text); } catch (e) {
    console.error(`❌ GraphQL HTTP ${res.status} ${res.statusText} - Non-JSON body:`);
    console.error(text);
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

const qVariants = `
query($after: String) {
  productVariants(first: 200, after: $after, query:"status:active") {
    pageInfo { hasNextPage endCursor }
    edges {
      node {
        id
        title
        sku
        inventoryItem {
          id
          inventoryLevels(first: 50) {
            edges { node { available location { id name } } }
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
  for (const wanted of PRIORITY) {
    const lvl = levels.find(l => l.location?.name === wanted);
    if (lvl && (lvl.available || 0) > 0) return wanted;
  }
  return ""; // nessuna disponibile
}

async function run() {
  console.log(`▶ Start. Shop: ${SHOP}`);
  console.log(`Priority: ${PRIORITY.join(' > ')}`);
  console.log(`API: ${API_VERSION}`);

  // Check scopes minimi con una query banalissima
  try {
    await GQL(`{ shop { name } }`, {});
  } catch (e) {
    console.error('❌ Verifica token/scopes fallita. Scopes richiesti: read_products, write_products, read_inventory, read_locations');
    throw e;
  }

  let after = null;
  let processed = 0, updated = 0;

  while (processed < VARIANTS_PER_RUN) {
    let data;
    try {
      data = await GQL(qVariants, { after });
    } catch (e) {
      console.error('❌ Errore nel fetch delle varianti. Fermiamo il ciclo.');
      throw e;
    }

    const edges = data.productVariants.edges || [];
    if (edges.length === 0) {
      console.log('ℹ️ Nessuna variante trovata in questa pagina.');
      break;
    }

    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;
      processed++;

      const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => e.node);
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
        // Logga, ma NON interrompere tutto: andiamo avanti con le altre
        console.error(`❌ Mutation error per ${node.sku || node.title}:`, e.message);
      }
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  console.log(`✅ Done. Processed: ${processed}, Updated: ${updated}`);
}

run().catch(e => {
  // Mantieni il codice 1 per far fallire il job solo quando è davvero bloccante
  console.error('💥 Task failed:', e.message);
  process.exit(1);
});
