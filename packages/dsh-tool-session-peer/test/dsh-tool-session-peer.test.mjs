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
  const state = { resumed: [], mountedPresets: [], queries: { listSessions: 0, listEvents: [], observeSession: [] } };
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
      async listSessions() { state.queries.listSessions += 1; return sessionRecords; },
      async listEvents(id) { state.queries.listEvents.push(id); return eventsById.get(id) ?? []; },
      async readTitleSnapshots(ids) {
        return ids.map((sessionId) => ({
          sessionId,
          status: "fulfilled",
          value: { session: { id: sessionId }, title: { title: titleById.get(sessionId) ?? "" } }
        }));
      },
      async observeSession(sessionId) {
        state.queries.observeSession.push(sessionId);
        const record = sessionRecords.find((row) => row.header.id === sessionId);
        return {
          header: record.header,
          events: eventsById.get(sessionId) ?? [],
          projections: { values: { agentPreset: record.header.agentPreset } },
          [Symbol.dispose]() {}
        };
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
        list: () => {
          const workspaces = new Map();
          for (const record of sessionRecords) {
            const path = record.header.cwd ?? "";
            if (!workspaces.has(path)) workspaces.set(path, { path, sessionIds: [] });
            workspaces.get(path).sessionIds.push(record.header.id);
          }
          return [...workspaces.values()];
        }
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

test("session_send addresses a live peer by id without listing or reading other sessions", async () => {
  const sender = agent("sender", "Sender");
  const recipient = agent("recipient", "Биржевой аналитик");
  const unrelated = agent("unrelated", "Unrelated", "/other-workspace");
  const { tools, state } = setup({ sender, peers: [recipient, unrelated] });

  const result = await tools.get("session_send").execute(
    { target: "recipient", message: "Сводка" },
    { agent: sender }
  );

  assert.equal(result.delivered, true);
  assert.equal(result.targetSessionId, "recipient");
  assert.equal(recipient.calls.length, 1);
  assert.deepEqual(state.queries.observeSession, []);
  assert.deepEqual(state.queries.listEvents, []);
  assert.equal(state.queries.listSessions, 0);
});

test("session_send resolves an exact live title without reading session files", async () => {
  const sender = agent("sender", "Sender");
  const recipient = agent("recipient", "Биржевой аналитик");
  const { tools, state } = setup({ sender, peers: [recipient] });

  const result = await tools.get("session_send").execute(
    { target: "Биржевой аналитик", message: "Сводка" },
    { agent: sender }
  );

  assert.equal(result.targetSessionId, "recipient");
  assert.equal(recipient.calls.length, 1);
  assert.deepEqual(state.queries.observeSession, []);
  assert.deepEqual(state.queries.listEvents, []);
  assert.equal(state.queries.listSessions, 0);
});

test("session_send scopes title lookup to the caller workspace", async () => {
  const sender = agent("sender", "Sender");
  const outside = agent("outside", "Outside title", "/other-workspace");
  const { tools, state } = setup({ sender, peers: [outside] });

  await assert.rejects(
    tools.get("session_send").execute({ target: "Outside title", message: "Сводка" }, { agent: sender }),
    (error) => error.code === "PEER_TARGET_NOT_FOUND"
  );
  assert.equal(outside.calls.length, 0);
  assert.deepEqual(state.queries.observeSession, []);
});

test("session_send rejects duplicate exact live titles and asks for an id", async () => {
  const sender = agent("sender", "Sender");
  const first = agent("first", "Same title");
  const second = agent("second", "Same title");
  const { tools, state } = setup({ sender, peers: [first, second] });

  await assert.rejects(
    tools.get("session_send").execute({ target: "Same title", message: "Сводка" }, { agent: sender }),
    (error) => error.code === "PEER_TARGET_AMBIGUOUS"
  );
  assert.equal(first.calls.length + second.calls.length, 0);
  assert.deepEqual(state.queries.observeSession, []);
  assert.deepEqual(state.queries.listEvents, []);
  assert.equal(state.queries.listSessions, 0);
});

test("session_peers hides live subagent children even when indexed", async () => {
  const sender = agent("sender", "Sender");
  const child = agent("child", "Child");
  child.session.header.delegationDepth = 1;
  const { tools } = setup({ sender, peers: [child] });

  const result = await tools.get("session_peers").execute({}, { agent: sender });
  assert.deepEqual(result.peers, []);
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

test("session listing includes blank sessions without inspecting their history", async () => {
  const sender = agent("sender", "Sender");
  const blankLive = agent("blank-live", "");
  const { tools, state } = setup({ sender, peers: [blankLive], records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    { header: { id: "blank-live", ...blankLive.session.header }, live: true, persisted: true, events: [] },
    { ...coldRecord("blank-cold", ""), events: [] }
  ] });

  const peers = await tools.get("session_peers").execute({}, { agent: sender });
  assert.deepEqual(peers.peers.map(({ id }) => id), ["blank-live", "blank-cold"]);
  assert.deepEqual(state.queries.observeSession, []);
  assert.deepEqual(state.queries.listEvents, []);
  assert.equal(state.queries.listSessions, 0);
  assert.equal(state.resumed.length, 0);
});

test("cold titles stay unavailable; an exact id resumes the existing session", async () => {
  const sender = agent("sender", "Sender");
  const { tools, state } = setup({ sender, records: [
    { header: { id: "sender", ...sender.session.header }, live: true, persisted: true },
    coldRecord("cold", "Биржевой аналитик")
  ] });

  const listed = await tools.get("session_peers").execute({}, { agent: sender });
  assert.deepEqual(listed.peers.map(({ id, title }) => [id, title]), [["cold", ""]]);
  await assert.rejects(
    tools.get("session_send").execute({ target: "Биржевой аналитик", message: "Сводка" }, { agent: sender }),
    (error) => error.code === "PEER_TARGET_NOT_FOUND"
  );
  const result = await tools.get("session_send").execute(
    { target: "cold", message: "Сводка" },
    { agent: sender }
  );

  assert.equal(result.targetSessionId, "cold");
  assert.equal(result.targetTitle, "Биржевой аналитик");
  assert.equal(state.resumed.length, 1);
  assert.equal(state.resumed[0].resumeSessionId, "cold");
  assert.deepEqual(state.mountedPresets, ["kilo"]);
  assert.deepEqual(state.queries.observeSession, []);
  assert.deepEqual(state.queries.listEvents, []);
  assert.equal(state.queries.listSessions, 0);
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
