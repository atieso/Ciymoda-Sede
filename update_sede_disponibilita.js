// Aggiorna il metafield di variante custom.sede_disponibilita
// scegliendo la prima sede con available > 0 in base a LOCATION_PRIORITY.

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());

// Limita quante varianti processare per run (sicurezza se hai cataloghi grandi)
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '400', 10);

const GQL = async (query, variables) => {
  const r = await fetch(`https://${SHOP}/admin/api/2025-01/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors));
  return j.data;
};

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
  // levels: [{available, location:{name}}]
  for (const wanted of PRIORITY) {
    const lvl = levels.find(l => l.location?.name === wanted);
    if (lvl && (lvl.available || 0) > 0) return wanted;
  }
  return ""; // nessuna disponibile
}

async function run() {
  console.log(`Start. Priority: ${PRIORITY.join(' > ')}`);
  let after = null;
  let processed = 0, updated = 0;

  while (processed < VARIANTS_PER_RUN) {
    const data = await GQL(qVariants, { after });
    const edges = data.productVariants.edges;
    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;

      const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => e.node);
      const chosen = chooseLocation(levels);

      // Prepara metafield input
      const mf = [{
        ownerId: node.id,
        namespace: "custom",
        key: "sede_disponibilita",
        type: "single_line_text_field",
        value: chosen
      }];

      // Scrivi solo se serve (sempre ok scrivere, costa 1 mutation)
      const res = await GQL(mSet, { metafields: mf });
      const errs = res.metafieldsSet.userErrors || [];
      if (errs.length) {
        console.error('UserErrors', JSON.stringify(errs));
      } else {
        updated++;
        console.log(`✔ ${node.sku || node.title} -> "${chosen || '(vuoto)'}"`);
      }

      processed++;
    }
    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  console.log(`Done. Processed: ${processed}, Updated: ${updated}`);
}

run().catch(e => { console.error(e); process.exit(1); });
