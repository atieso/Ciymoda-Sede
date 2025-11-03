// update_sede_disponibilita.js – con CSV report e filtri di test
// Scopes necessari: read_products, write_products, read_inventory, read_locations

import fs from "node:fs";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '10000', 10);
const API_VERSION = '2025-10';

// Facoltativo: filtra per SKU specifici (separati da |), utile per test mirati
const TEST_SKUS = (process.env.TEST_SKUS || '').split('|').map(s=>s.trim()).filter(Boolean);
const ONLY_TEST = TEST_SKUS.length > 0;

if (!SHOP || !TOKEN) { console.error('❌ Missing env'); process.exit(1); }

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
    metafields { key value }   # <-- rimosso owner { id }
    userErrors { field message }
  }
}
`;


function chooseLocation(levels) {
  const prio = PRIORITY.map(n => n.trim().toLowerCase());
  for (const wanted of prio) {
    const m = levels.find(l => l.locationNameNorm === wanted);
    if (m && (m.available || 0) > 0) return m.location.name;
  }
  const any = levels.find(l => (l.available || 0) > 0);
  return any ? (any.location?.name || "") : "";
}

async function run() {
  console.log(`▶ Start. Shop: ${SHOP}`);
  console.log(`Priority: ${PRIORITY.join(' > ')}`);
  console.log(`API: ${API_VERSION}`);
  if (ONLY_TEST) console.log(`TEST_SKUS attivo → elaboro solo: ${TEST_SKUS.join(', ')}`);

  await GQL(`{ shop { name } }`, {}); // sanity token/scopes

  let after = null, processed = 0, updated = 0, skipped = 0;
  const changes = []; // per CSV

  while (processed < VARIANTS_PER_RUN) {
    const data = await GQL(qVariants, { after });
    const edges = data.productVariants.edges || [];
    if (!edges.length) break;

    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;

      // filtro per SKU se in test
      if (ONLY_TEST && node.sku && !TEST_SKUS.includes(node.sku)) {
        skipped++; processed++; continue;
      }

      const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => {
        const qa = (e.node.quantities || []).find(q => q.name === 'available');
        return {
          available: qa ? (qa.quantity || 0) : 0,
          location: e.node.location,
          locationNameNorm: (e.node.location?.name || "").trim().toLowerCase()
        };
      });

      // Log diagnostico livelli
      console.log(`Levels for ${node.sku || node.title}: ${levels.map(l => `${l.location?.name}:${l.available}`).join(' | ') || '—'}`);

      const chosen = chooseLocation(levels);
      const current = node.metafield?.value || "";

      if (current === chosen) {
        skipped++; processed++;
        continue;
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
          // Rilettura per conferma
          const check = await GQL(
            `query($id:ID!){ productVariant(id:$id){ metafield(namespace:"custom", key:"sede_disponibilita"){ value } } }`,
            { id: node.id }
          );
          const afterVal = check.productVariant?.metafield?.value || "";
          console.log(`✔ ${node.sku || node.title}: before="${current}" -> after="${afterVal}"`);
          changes.push({
            id: node.id,
            sku: node.sku || '',
            title: node.title || '',
            before: current,
            after: afterVal
          });
          updated++;
        }
      } catch (e) {
        console.error(`❌ Mutation error ${node.sku || node.title}:`, e.message);
      }

      processed++;
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  // Scrivi CSV report
  const csvPath = '/tmp/sede_updates.csv';
  const header = 'variant_id;sku;title;before;after\n';
  const rows = changes.map(c =>
    `${c.id};${(c.sku||'').replaceAll(';',',')};${(c.title||'').replaceAll(';',',')};${(c.before||'').replaceAll(';',',')};${(c.after||'').replaceAll(';',',')}\n`
  );
  fs.writeFileSync(csvPath, header + rows.join(''), 'utf8');

  // Riepilogo chiaro
  console.log('--- SUMMARY ---');
  console.log(`Processed: ${processed}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped}`);
  console.log(`Report:    ${csvPath}`);
}

run().catch(e => { console.error('💥 Task failed:', e.message); process.exit(1); });
