import assert from "node:assert/strict";
import test from "node:test";

import { apply } from "../src/dsh-tool-session-peer.mjs";

function setup({ sender, peers = [], records, archived = [] }) {
  const tools = new Map();
  const liveAgents = [sender, ...peers];
  const sessionRecords = records ?? liveAgents.map((agent) => ({
    header: { id: agent.id, ...agent.session.header },
    live: true,
    persisted: true
  }));
  const titleById = new Map(liveAgents.map((agent) => [agent.id, agent.session.title ?? ""]));
  for (const record of sessionRecords) {
    if (record.title !== undefined) titleById.set(record.header.id, record.title);
  }
  const state = { resumed: [], mountedPresets: [] };
  const eventsById = new Map(sessionRecords.map((record) => [
    record.header.id,
    record.events ?? [{ type: "user/message" }]
  ]));
  const ctx = {
    agents: {
      list: () => liveAgents,
      get: (id) => liveAgents.find((agent) => agent.id === id),
      async resume(options) {
        state.resumed.push(options);
        const session = sessionRecords.find((record) => record.header.id === options.resumeSessionId);
        assert.ok(session, `expected persisted session ${options.resumeSessionId}`);
        const resumed = agent(options.resumeSessionId, titleById.get(options.resumeSessionId) ?? "", session.header.cwd);
        await options.setup?.({}, resumed);
        liveAgents.push(resumed);
        return { agent: resumed, dispose: async () => {} };
      }
    },
    sessionQuery: {
      async listSessions() { return sessionRecords; },
      async listEvents(id) { return eventsById.get(id) ?? []; },
      async readTitleSnapshots(ids) {
        return ids.map((sessionId) => ({
          sessionId,
          status: "fulfilled",
          value: { session: { id: sessionId }, title: { title: titleById.get(sessionId) ?? "" } }
        }));
      },
      async observeSession(sessionId) {
        const record = sessionRecords.find((row) => row.header.id === sessionId);
        return { header: record.header, projections: { values: { agentPreset: record.header.agentPreset } } };
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      }
    },
    effect(effect) {
      effect();
    },
    loader: {
      import: async () => ({ createUserMessage: (message) => ({ id: "message-1", ...message }) })
    },
    get(key) {
      if (key === "workspaceRegistry") return {
        archivedSessionIds: archived,
        list: () => [{ sessionIds: sessionRecords.map((record) => record.header.id) }]
      };
      if (key === "sessionTitle") return { get: (session) => ({ title: session.title ?? "" }) };
      if (key === "agentPresets") return {
        async resolve(id) { return { id }; },
        async mount(_agentCtx, id) { state.mountedPresets.push(id); }
      };
      return undefined;
    }
  };
  apply(ctx);
  return { tools, state };
}

function agent(id, title, cwd = "/workspace", status = "idle") {
  const calls = [];
  return {
    id,
    status,
    session: { header: { cwd, delegationDepth: 0, agentPreset: "kilo" }, title },
    calls,
    async followup(message) { calls.push(["followup", message]); },
    async steer(message) { calls.push(["steer", message]); }
  };
}

function coldRecord(id, title, cwd = "/workspace") {
  return {
    header: { id, cwd, delegationDepth: 0, agentPreset: "kilo" },
    live: false,
    persisted: true,
    title
  };
}

test("session_send accepts an exact peer title", async () => {
  const sender = agent("sender", "Sender");
  const recipient = agent("recipient", "Биржевой аналитик");
  const { tools } = setup({ sender, peers: [recipient] });

  const result = await tools.get("session_send").execute(
    { target: "Биржевой аналитик", message: "Сводка" },
    { agent: sender }
  );

  assert.equal(result.delivered, true);
  assert.equal(result.targetSessionId, "recipient");
  assert.equal(recipient.calls.length, 1);
});

test("session_send rejects a title fragment instead of guessing a recipient", async () => {
  const sender = agent("sender", "Sender");
  const recipient = agent("recipient", "Биржевой аналитик");
  const { tools } = setup({ sender, peers: [recipient] });

  await assert.rejects(
    tools.get("session_send").execute(
      { target: "Биржевой", message: "Сводка" },
      { agent: sender }
    ),
    (error) => error.code === "PEER_TARGET_NOT_FOUND"
  );
  assert.equal(recipient.calls.length, 0);
});

test("duplicate exact titles require an exact session id", async () => {
  const sender = agent("sender", "Sender");
  const { tools } = setup({ sender, records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    coldRecord("cold-a", "Биржевой аналитик"),
    coldRecord("cold-b", "Биржевой аналитик")
  ] });

  await assert.rejects(
    tools.get("session_send").execute(
      { target: "Биржевой аналитик", message: "Сводка" },
      { agent: sender }
    ),
    (error) => error.code === "PEER_TARGET_AMBIGUOUS"
  );
});

test("session_peers includes non-archived persisted sessions that are cold", async () => {
  const sender = agent("sender", "Sender");
  const { tools } = setup({ sender, records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    coldRecord("cold", "Биржевой аналитик")
  ] });

  const result = await tools.get("session_peers").execute({}, { agent: sender });

  assert.deepEqual(result.peers.map(({ id, status }) => [id, status]), [["cold", "cold"]]);
});

test("blank live and cold drafts are hidden and cannot be addressed", async () => {
  const sender = agent("sender", "Sender");
  const blankLive = agent("blank-live", "");
  const { tools, state } = setup({ sender, peers: [blankLive], records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    { header: { id: "blank-live", ...blankLive.session.header }, live: true, persisted: true, events: [] },
    { ...coldRecord("blank-cold", ""), events: [] }
  ] });

  const peers = await tools.get("session_peers").execute({}, { agent: sender });
  assert.deepEqual(peers.peers, []);
  await assert.rejects(
    tools.get("session_send").execute({ target: "blank-live", message: "Сводка" }, { agent: sender }),
    (error) => error.code === "PEER_TARGET_NOT_FOUND"
  );
  await assert.rejects(
    tools.get("session_send").execute({ target: "blank-cold", message: "Сводка" }, { agent: sender }),
    (error) => error.code === "PEER_TARGET_NOT_FOUND"
  );
  assert.equal(blankLive.calls.length, 0);
  assert.equal(state.resumed.length, 0);
});

test("session_send resumes a cold session by exact title and delivers without creating an id", async () => {
  const sender = agent("sender", "Sender");
  const { tools, state } = setup({ sender, records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    coldRecord("cold", "Биржевой аналитик")
  ] });

  const result = await tools.get("session_send").execute(
    { target: "Биржевой аналитик", message: "Сводка" },
    { agent: sender }
  );

  assert.equal(result.targetSessionId, "cold");
  assert.equal(state.resumed.length, 1);
  assert.equal(state.resumed[0].resumeSessionId, "cold");
  assert.deepEqual(state.mountedPresets, ["kilo"]);
});

test("session_broadcast skips cold sessions without resuming them", async () => {
  const sender = agent("sender", "Sender");
  const livePeer = agent("live", "Live peer");
  const { tools, state } = setup({ sender, peers: [livePeer], records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    { header: { id: "live", ...livePeer.session.header }, live: true, persisted: true },
    coldRecord("cold", "Биржевой аналитик")
  ] });

  const result = await tools.get("session_broadcast").execute(
    { message: "Объявление" },
    { agent: sender }
  );

  assert.equal(result.delivered.length, 1);
  assert.equal(result.failed.length, 1);
  assert.match(result.failed[0].error, /cold session skipped/);
  assert.equal(state.resumed.length, 0);
});

test("archived cold sessions are neither listed nor resumed", async () => {
  const sender = agent("sender", "Sender");
  const { tools, state } = setup({ sender, archived: ["cold"], records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    coldRecord("cold", "Биржевой аналитик")
  ] });

  const peers = await tools.get("session_peers").execute({}, { agent: sender });
  assert.deepEqual(peers.peers, []);
  await assert.rejects(
    tools.get("session_send").execute({ target: "cold", message: "Сводка" }, { agent: sender }),
    (error) => error.code === "PEER_TARGET_ARCHIVED"
  );
  assert.equal(state.resumed.length, 0);
});
