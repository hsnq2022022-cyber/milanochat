// Tool logic against an in-memory fake Supabase client (no network), plus a round-trip through the
// real Flow Builder normalization (../../src/flow/model.ts, imported read-only via Node type stripping).
import { test } from "node:test";
import assert from "node:assert/strict";
import { createFakeSupabase } from "./fakeSupabase.mjs";
import { createFlowStore } from "../dist/store.js";
import { createFlowTools } from "../dist/tools.js";

const T1 = "11111111-1111-4111-8111-111111111111";
const T2 = "22222222-2222-4222-8222-222222222222";

function setup(layout = "columns", allowedTenantId = null) {
  const fake = createFakeSupabase({ layout });
  const store = createFlowStore(fake, layout, fake.table);
  const logs = [];
  return { fake, tools: createFlowTools({ store, allowedTenantId, logError: m => logs.push(m) }), logs };
}
const json = r => JSON.parse(r.content[0].text.slice(r.content[0].text.indexOf("\n") + 1));
const text = r => r.content[0].text;
const plain = v => JSON.parse(JSON.stringify(v));

async function buildFlow(tools) {
  const c = await tools.create_flow({ tenant_id: T1, name: "Welcome" });
  assert.equal(c.isError, undefined, text(c));
  const flow = json(c);
  const m = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "message", position_x: 100, position_y: 100,
    data: { label: "Greeting", text: "Hello", buttons: ["Prices", { id: "staff", label: "Staff" }] } }));
  const e = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "end", position_x: 100, position_y: 400 }));
  const e2 = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "end", position_x: 400, position_y: 400 }));
  const e3 = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "end", position_x: 700, position_y: 400 }));
  return { flow, m: m.node, e: e.node, e2: e2.node, e3: e3.node };
}

for (const layout of ["columns", "drafts"]) {
  test(`[${layout}] create -> add_node -> connect -> list`, async () => {
    const { fake, tools } = setup(layout);
    const { flow, m, e, e2, e3 } = await buildFlow(tools);
    assert.deepEqual(m.output_handles.map(h => h.handle).slice(0, 1), ["next"]);
    assert.ok(m.output_handles.some(h => h.handle === "staff"));
    const prices = m.output_handles.find(h => h.label === "Prices").handle;
    for (const [s, t, h] of [[flow.trigger_node.id, m.id, undefined], [m.id, e.id, undefined], [m.id, e2.id, prices], [m.id, e3.id, "staff"]]) {
      const r = await tools.connect_nodes({ flow_id: flow.flow_id, source_node_id: s, target_node_id: t, source_handle: h });
      assert.equal(r.isError, undefined, text(r));
    }
    const list = json(await tools.list_flows({ tenant_id: T1 }));
    assert.equal(list.flows.length, 1);
    assert.equal(list.flows[0].nodeCount, 5);
    assert.equal(list.flows[0].edgeCount, 4);
    // Shape actually stored
    const row = fake.rows[0];
    const nodes = layout === "drafts" ? row.document.nodes : row.nodes;
    const edges = layout === "drafts" ? row.document.edges : row.edges;
    assert.equal(nodes[1].type, "flowNode");
    assert.deepEqual(nodes[1].position, { x: 100, y: 100 });
    assert.equal(nodes[1].data.kind, "message");
    assert.equal(nodes[1].data.title, "Greeting");
    assert.equal(nodes[1].data.text, "Hello");
    assert.equal(edges[0].type, "flowEdge");
    assert.equal(edges[0].targetHandle, "in");
    assert.equal(edges[0].sourceHandle, "next");
    if (layout === "drafts") { assert.equal(row.document.version, 3); assert.equal(row.draft_revision, 9); }
    else assert.deepEqual(Object.keys(row).sort(), ["created_at", "edges", "id", "name", "nodes", "tenant_id", "updated_at"]);
  });

  test(`[${layout}] output written passes the Flow Builder's importFlow/validateDocument unchanged`, async () => {
    const model = await import("../../src/flow/model.ts");
    const { fake, tools } = setup(layout);
    const { flow, m, e, e2, e3 } = await buildFlow(tools);
    const q = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "question", position_x: 0, position_y: 700,
      data: { text: "Your email?", input_mode: "email", input_field: "email" } })).node;
    const d = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "delay", position_x: 0, position_y: 900, data: { delay_value: 5, delay_unit: "seconds" } })).node;
    const c = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "condition", position_x: 0, position_y: 1100,
      data: { condition_field: "email", operator: "exists" } })).node;
    const qb = json(await tools.add_node({ flow_id: flow.flow_id, node_type: "question", position_x: 300, position_y: 1300, data: { text: "Pick", options: ["A"] } })).node;
    const steps = [[flow.trigger_node.id, m.id], [m.id, q.id], [m.id, e2.id, m.output_handles[1].handle], [m.id, e3.id, "staff"],
      [q.id, d.id], [d.id, c.id], [c.id, e.id, "yes"], [c.id, qb.id, "no"], [qb.id, e.id, qb.output_handles[0].handle]];
    for (const [s, t, h] of steps) {
      const r = await tools.connect_nodes({ flow_id: flow.flow_id, source_node_id: s, target_node_id: t, source_handle: h });
      assert.equal(r.isError, undefined, text(r));
    }
    const row = fake.rows[0];
    const doc = layout === "drafts" ? row.document : { version: 3, name: row.name, nodes: row.nodes, edges: row.edges };
    const imported = model.importFlow(plain(doc));
    assert.ok(imported, "importFlow rejected the document");
    assert.deepEqual(plain(imported), plain(doc), "importFlow changed the document (normalization mismatch)");
    const errors = model.validateDocument(imported).filter(i => i.severity === "error");
    assert.deepEqual(errors, []);
    if (layout === "drafts") {
      // The exact decoder the Flow Builder's cloud-draft panel runs on fetched rows.
      const cloud = await import("../../src/flow/cloudDraft.ts");
      const decoded = cloud.decodeCloudDraftRows(plain([row]));
      assert.equal(decoded.skipped, 0);
      assert.equal(decoded.drafts[0].flow.id, flow.flow_id);
      assert.deepEqual(plain(decoded.drafts[0].flow.doc), plain(doc));
    }
  });

  test(`[${layout}] duplicate edge, occupied output, self-loop, bad handle, end source, trigger target`, async () => {
    const { tools } = setup(layout);
    const { flow, m, e, e2 } = await buildFlow(tools);
    const base = { flow_id: flow.flow_id };
    assert.equal((await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: e.id })).isError, undefined);
    const dup = await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: e.id, source_handle: "next" });
    assert.equal(dup.isError, true); assert.match(text(dup), /already exists/);
    const busy = await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: e2.id });
    assert.equal(busy.isError, true); assert.match(text(busy), /already connected/);
    const self = await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: m.id });
    assert.match(text(self), /itself/);
    const bad = await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: e2.id, source_handle: "output-0" });
    assert.equal(bad.isError, true); assert.match(text(bad), /Invalid source_handle 'output-0'.*'next'/);
    const end = await tools.connect_nodes({ ...base, source_node_id: e.id, target_node_id: e2.id });
    assert.match(text(end), /no outputs/);
    const trig = await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: flow.trigger_node.id, source_handle: "staff" });
    assert.match(text(trig), /trigger node cannot/);
    const ghost = await tools.connect_nodes({ ...base, source_node_id: m.id, target_node_id: "nope" });
    assert.match(text(ghost), /Target node 'nope' does not exist/);
    const cond = json(await tools.add_node({ ...base, node_type: "condition", position_x: 1, position_y: 1, data: { condition_value: "x" } })).node;
    const need = await tools.connect_nodes({ ...base, source_node_id: cond.id, target_node_id: e2.id });
    assert.match(text(need), /source_handle is required.*'yes'.*'no'/);
  });

  test(`[${layout}] missing flow, invalid args, wrong-kind data`, async () => {
    const { tools } = setup(layout);
    const r = await tools.add_node({ flow_id: "00000000-0000-4000-8000-000000000000", node_type: "message", position_x: 0, position_y: 0 });
    assert.equal(r.isError, true); assert.match(text(r), /not found/);
    const noPos = await tools.add_node({ flow_id: "abc", node_type: "message", position_x: 0 });
    assert.equal(noPos.isError, true); assert.match(text(noPos), /position_y/);
    const badKind = await tools.add_node({ flow_id: "abc", node_type: "trigger", position_x: 0, position_y: 0 });
    assert.equal(badKind.isError, true);
    const c = json(await tools.create_flow({ tenant_id: T1, name: "X" }));
    const wrong = await tools.add_node({ flow_id: c.flow_id, node_type: "delay", position_x: 0, position_y: 0, data: { text: "hi" } });
    assert.match(text(wrong), /data.text is not valid for a delay node/);
    const unknown = await tools.add_node({ flow_id: c.flow_id, node_type: "message", position_x: 0, position_y: 0, data: { colour: "red" } });
    assert.equal(unknown.isError, true);
    const badTenant = await tools.list_flows({ tenant_id: "not-a-uuid" });
    assert.equal(badTenant.isError, true);
  });

  test(`[${layout}] tenant isolation`, async () => {
    const open = setup(layout);
    const f2 = json(await open.tools.create_flow({ tenant_id: T2, name: "Other tenant" }));
    // tenant_id argument that does not own the flow -> not found
    const cross = await open.tools.add_node({ flow_id: f2.flow_id, tenant_id: T1, node_type: "end", position_x: 0, position_y: 0 });
    assert.equal(cross.isError, true); assert.match(text(cross), /not found for this tenant/);
    assert.equal(json(await open.tools.list_flows({ tenant_id: T1 })).flows.length, 0);

    // Locked server: other tenants' flows and tenant_id args are refused
    const fake = open.fake;
    const locked = createFlowTools({ store: createFlowStore(fake, layout, fake.table), allowedTenantId: T1 });
    for (const r of [
      await locked.create_flow({ tenant_id: T2, name: "nope" }),
      await locked.list_flows({ tenant_id: T2 }),
      await locked.add_node({ flow_id: f2.flow_id, node_type: "end", position_x: 0, position_y: 0 }),
      await locked.add_node({ flow_id: f2.flow_id, tenant_id: T2, node_type: "end", position_x: 0, position_y: 0 }),
      await locked.connect_nodes({ flow_id: f2.flow_id, source_node_id: f2.trigger_node.id, target_node_id: "x" }),
    ]) assert.equal(r.isError, true, text(r));
    const nodes = layout === "drafts" ? fake.rows[0].document.nodes : fake.rows[0].nodes;
    assert.equal(nodes.length, 1, "other tenant's flow must be untouched");
    assert.equal((await locked.create_flow({ tenant_id: T1, name: "mine" })).isError, undefined);
  });

  test(`[${layout}] optimistic concurrency: retry once, then conflict`, async () => {
    const { fake, tools } = setup(layout);
    const f = json(await tools.create_flow({ tenant_id: T1, name: "C" }));
    const bump = rows => {
      const r = rows[0];
      if (layout === "drafts") { r.draft_revision++; r.document.nodes.push({ id: "foreign", type: "flowNode", position: { x: 0, y: 0 }, data: { kind: "end", title: "x", text: "", options: [] } }); }
      else { r.updated_at = new Date(Date.parse(r.updated_at) + 5000).toISOString(); r.nodes.push({ id: "foreign", type: "flowNode", position: { x: 0, y: 0 }, data: { kind: "end", title: "x", text: "", options: [] } }); }
    };
    fake.beforeUpdate = bump; // one concurrent edit -> retried, both edits kept
    const r = await tools.add_node({ flow_id: f.flow_id, node_type: "end", position_x: 0, position_y: 0 });
    assert.equal(r.isError, undefined, text(r));
    const nodes = () => (layout === "drafts" ? fake.rows[0].document.nodes : fake.rows[0].nodes);
    assert.equal(nodes().length, 3);
    assert.ok(nodes().some(n => n.id === "foreign"));
    // concurrent edit on every attempt -> clear conflict, nothing clobbered
    const orig = fake.from.bind(fake);
    let n = 0;
    fake.from = name => { const q = orig(name); const u = q.update; q.update = p => { fake.beforeUpdate = rows => { n++; bump(rows); }; return u(p); }; return q; };
    const c = await tools.add_node({ flow_id: f.flow_id, node_type: "end", position_x: 0, position_y: 0 });
    assert.equal(c.isError, true); assert.match(text(c), /Conflict/);
    assert.equal(n, 2);
    assert.equal(nodes().length, 5); // only the two foreign edits landed
  });

  test(`[${layout}] DB errors are mapped without leaking detail`, async () => {
    const { fake, tools, logs } = setup(layout);
    fake.failNext = { code: "XX000", message: "password=hunter2 detail" };
    const r = await tools.list_flows({ tenant_id: T1 });
    assert.equal(r.isError, true); assert.doesNotMatch(text(r), /hunter2/); assert.match(text(r), /code XX000/);
    const wrongTable = createFlowTools({ store: createFlowStore(fake, layout, "missing_table"), allowedTenantId: null });
    assert.match(text(await wrongTable.list_flows({ tenant_id: T1 })), /Table 'missing_table' was not found/);
    assert.deepEqual(logs, []);
  });
}

test("[columns] never writes columns outside the brief's list (fake rejects unknown columns)", async () => {
  const { fake, tools } = setup("columns");
  const f = json(await tools.create_flow({ tenant_id: T1, name: "Cols" }));
  assert.equal((await tools.add_node({ flow_id: f.flow_id, node_type: "end", position_x: 0, position_y: 0 })).isError, undefined);
  assert.ok(fake.calls.every(c => c.op !== "update" || c.filters >= 3), "updates must filter by id, tenant_id and version");
});
