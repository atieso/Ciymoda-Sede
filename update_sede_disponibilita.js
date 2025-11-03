// update_sede_disponibilita.js – updates + skipped report
import fs from "node:fs";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN;
const TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const PRIORITY = (process.env.LOCATION_PRIORITY || 'CityModa Lecce|Citymoda Triggiano').split('|').map(s=>s.trim());
const VARIANTS_PER_RUN = parseInt(process.env.VARIANTS_PER_RUN || '50000', 10);
const API_VERSION = '2025-10';
const TEST_SKUS = (process.env.TEST_SKUS || '').split('|').map(s=>s.trim()).filter(Boolean);
const ONLY_TEST = TEST_SKUS.length > 0;

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
  if (ONLY_TEST) console.log(`TEST_SKUS attivo: ${TEST_SKUS.join(', ')}`);
  await GQL(`{ shop { name } }`, {});

  let after = null, processed = 0, updated = 0;
  const changes = [];
  const skipped = [];

  while (processed < VARIANTS_PER_RUN) {
    const data = await GQL(qVariants, { after });
    const edges = data.productVariants.edges || [];
    if (!edges.length) break;

    for (const { node } of edges) {
      if (processed >= VARIANTS_PER_RUN) break;
      processed++;

      if (ONLY_TEST && node.sku && !TEST_SKUS.includes(node.sku)) {
        skipped.push({
          variantGid: node.id,
          variantId: gidNum(node.id),
          productId: gidNum(node.product?.id),
          sku: node.sku || '',
          variantTitle: node.title || '',
          productTitle: node.product?.title || '',
          reason: 'not_in_TEST_SKUS'
        });
        continue;
      }

      const levels = (node.inventoryItem?.inventoryLevels?.edges || []).map(e => {
        const qa = (e.node.quantities || []).find(q => q.name === 'available');
        return {
          available: qa ? (qa.quantity || 0) : 0,
          location: e.node.location,
          locationNameNorm: (e.node.location?.name || "").trim().toLowerCase()
        };
      });

      console.log(`Levels for ${node.sku || node.title}: ${levels.map(l => `${l.location?.name}:${l.available}`).join(' | ') || '—'}`);

      const chosen = chooseLocation(levels);
      const current = node.metafield?.value || "";

      // nessuna sede con stock
      const totalAvail = levels.reduce((acc, l) => acc + (l.available || 0), 0);
      if (!chosen && totalAvail === 0) {
        skipped.push({
          variantGid: node.id,
          variantId: gidNum(node.id),
          productId: gidNum(node.product?.id),
          sku: node.sku || '',
          variantTitle: node.title || '',
          productTitle: node.product?.title || '',
          reason: 'no_stock_in_priority_or_any'
        });
        continue;
      }

      // già uguale
      if (current === chosen) {
        skipped.push({
          variantGid: node.id,
          variantId: gidNum(node.id),
          productId: gidNum(node.product?.id),
          sku: node.sku || '',
          variantTitle: node.title || '',
          productTitle: node.product?.title || '',
          reason: 'same_value'
        });
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
          skipped.push({
            variantGid: node.id,
            variantId: gidNum(node.id),
            productId: gidNum(node.product?.id),
            sku: node.sku || '',
            variantTitle: node.title || '',
            productTitle: node.product?.title || '',
            reason: 'mutation_error'
          });
        } else {
          // rilettura per conferma
          const check = await GQL(
            `query($id:ID!){ productVariant(id:$id){ metafield(namespace:"custom", key:"sede_disponibilita"){ value } } }`,
            { id: node.id }
          );
          const afterVal = check.productVariant?.metafield?.value || "";
          console.log(`✔ ${node.sku || node.title}: before="${current}" -> after="${afterVal}"`);
          changes.push({
            variantGid: node.id,
            variantId: gidNum(node.id),
            productId: gidNum(node.product?.id),
            sku: node.sku || '',
            variantTitle: node.title || '',
            productTitle: node.product?.title || '',
            before: current,
            after: afterVal
          });
          updated++;
        }
      } catch (e) {
        console.error(`❌ Mutation error ${node.sku || node.title}:`, e.message);
        skipped.push({
          variantGid: node.id,
          variantId: gidNum(node.id),
          productId: gidNum(node.product?.id),
          sku: node.sku || '',
          variantTitle: node.title || '',
          productTitle: node.product?.title || '',
          reason: 'mutation_exception'
        });
      }
    }

    if (!data.productVariants.pageInfo.hasNextPage) break;
    after = data.productVariants.pageInfo.endCursor;
  }

  // write updates CSV
  const updatesPath = '/tmp/sede_updates.csv';
  const updatesHeader = 'variant_gid;variant_id;product_id;sku;variant_title;product_title;before;after;admin_product_url;admin_variant_url\n';
  const updatesRows = changes.map(c => {
    const adminProductURL = `https://${SHOP}/admin/products/${c.productId}`;
    const adminVariantURL = `https://${SHOP}/admin/products/${c.productId}/variants/${c.variantId}`;
    return [
      c.variantGid,
      c.variantId,
      c.productId,
      c.sku.replaceAll(';',','),
      c.variantTitle.replaceAll(';',','),
      c.productTitle.replaceAll(';',','),
      (c.before||'').replaceAll(';',','),
      (c.after||'').replaceAll(';',','),
      adminProductURL,
      adminVariantURL
    ].join(';') + '\n';
  });
  fs.writeFileSync(updatesPath, updatesHeader + updatesRows.join(''), 'utf8');

  // write skipped CSV
  const skippedPath = '/tmp/sede_skipped.csv';
  const skippedHeader = 'variant_gid;variant_id;product_id;sku;variant_title;product_title;reason;admin_product_url;admin_variant_url\n';
  const skippedRows = skipped.map(c => {
    const adminProductURL = `https://${SHOP}/admin/products/${c.productId}`;
    const adminVariantURL = `https://${SHOP}/admin/products/${c.productId}/variants/${c.variantId}`;
    return [
      c.variantGid,
      c.variantId,
      c.productId,
      (c.sku||'').replaceAll(';',','),
      (c.variantTitle||'').replaceAll(';',','),
      (c.productTitle||'').replaceAll(';',','),
      c.reason,
      adminProductURL,
      adminVariantURL
    ].join(';') + '\n';
  });
  fs.writeFileSync(skippedPath, skippedHeader + skippedRows.join(''), 'utf8');

  console.log('--- SUMMARY ---');
  console.log(`Processed: ${processed}`);
  console.log(`Updated:   ${updated}`);
  console.log(`Skipped:   ${skipped.length}`);
  console.log(`Report OK: ${updatesPath} + ${skippedPath}`);
}

run().catch(e => { console.error('💥 Task failed:', e.message); process.exit(1); });
