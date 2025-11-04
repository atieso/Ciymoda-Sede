// update_sede_disponibilita.js – con cursore persistente
import fs from "node:fs";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '50000', 10);
const API_VERSION = '2025-10';
const CURSOR_FILE = '.shopify_variant_cursor.json';

if (!SHOP || !TOKEN) { console.error('❌ Missing env'); process.exit(1); }

const gidNum = gid => (gid || '').split('/').pop();

async function GQL(query, variables) {
  const res = await fetch(`https://${SHOP}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: { 'Content-Type':'application/json', 'X-Shopify-Access-Token': TOKEN },
    body: JSON.stringify({ query, variables })
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { console.error(text); throw new Error(`GraphQL HTTP ${res.status}`); }
  if (!res.ok || json.errors) { console.error('❌ GraphQL', res.status, res.statusText, JSON.stringify(json.errors||json,null,2)); throw new Error('GraphQL error'); }
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

const mSet = `
mutation setMeta($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { key value }
    userErrors { field message }
  }
}
`;

function chooseLocation(levels, priority) {
  const prio = priority.map(n => n.trim().toLowerCase());
  for (const wanted of prio) {
    const m = levels.find(l => l.locationNameNorm === wanted);
    if (m && (m.available || 0) > 0) return m.location.name;
  }
  const any = levels.find(l => (l.available || 0) > 0);
  return any ? (any.location?.name || "") : "";
}

function loadCursor() {
  try {
    const raw = fs.readFileSync(CURSOR_FILE, 'utf8');
    const json = JSON.parse(raw);
    return json.after || null;
  } catch {
    return null;
  }
}

function saveCursor(after) {
  fs.writeFileSync(CURSOR_FILE, JSON.stringify({ after }, null, 2), 'utf8');
}

async function run() {
  console.log(`▶ Start. Shop: ${SHOP}`);
  await GQL(`{ shop { name } }`, {});

  let after = loadCursor();
  if (after) console.log(`📍 Riparto dal cursore: ${after.slice(0, 30)}...`);

  let processed = 0;
  let lastCursor = after;

  while (processed < VARIANTS_PER_RUN) {
    const data = await GQL(qVariants, { after: lastCursor });
    const { edges, pageInfo } = data.productVariants;
    if (!edges.length) break;

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
      const totalAvail = levels.reduce((acc, l) => acc + (l.available || 0), 0);

      if (!chosen && totalAvail === 0) {
        continue; // niente stock in nessuna sede
      }

      if (current === chosen) {
        continue; // già uguale
      }

      const metafields = [{
        ownerId: node.id,
        namespace: "custom",
        key: "sede_disponibilita",
        type: "single_line_text_field",
        value: chosen
      }];

      try {
        const setRes = await GQL(mSet, { metafields });
        const errs = setRes.metafieldsSet.userErrors || [];
        if (errs.length) {
          console.error(`⚠️ UserErrors ${node.sku || node.title}:`, JSON.stringify(errs));
        } else {
          console.log(`✔ ${node.sku || node.title}: "${current}" -> "${chosen}"`);
        }
      } catch (e) {
        console.error(`❌ Mutation error ${node.sku || node.title}:`, e.message);
      }
    }

    if (!pageInfo.hasNextPage) {
      console.log('✅ Fine varianti: nessun’altra pagina');
      lastCursor = null;
      break;
    }

    lastCursor = pageInfo.endCursor;
    console.log(`➡️ pagina successiva: ${lastCursor.slice(0, 30)}...`);
  }

  // salva il cursore per il prossimo run
  saveCursor(lastCursor);
  console.log(`💾 Salvato cursore: ${lastCursor ? lastCursor.slice(0,30)+'...' : 'null (fine)'}`);
}

run().catch(e => { console.error('💥 Task failed:', e.message); process.exit(1); });
