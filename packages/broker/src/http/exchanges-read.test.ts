import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";

import { InMemoryA2ABroker } from "../core/broker.js";
import type { BrokerStateStore } from "../core/store.js";
import { handleExchangeRoutesIfMatched } from "./exchanges-read.js";

class CapturingResponse extends EventEmitter {
  statusCode?: number;
  headers?: Record<string, string | number>;
  body = "";

  writeHead(statusCode: number, headers: Record<string, string | number>): this {
    this.statusCode = statusCode;
    this.headers = headers;
    return this;
  }

  end(chunk?: string): this {
    if (chunk) this.body += chunk;
    return this;
  }
}

function makeExchange(broker: InMemoryA2ABroker) {
  const exchange = broker.startExchange({
    requester: { id: "hub-a", kind: "node", role: "hub" },
    target: { id: "worker-a", kind: "node", role: "analyst" },
    message: "initial message",
    intent: "chat",
  });
  broker.addExchangeMessage(exchange.id, {
    actor: { id: "worker-a", kind: "node", role: "analyst" },
    message: "reply message",
  });
  return exchange;
}

async function routeCtx(
  method: string,
  path: string,
  broker: InMemoryA2ABroker,
  res = new CapturingResponse(),
  options: { urlPath?: string; req?: IncomingMessage; stateStore?: BrokerStateStore } = {},
) {
  return {
    handled: await handleExchangeRoutesIfMatched({
      method,
      path,
      segments: path.split("/").filter(Boolean),
      req: options.req ?? ({} as IncomingMessage),
      res: res as unknown as ServerResponse,
      url: new URL(`http://broker.test${options.urlPath ?? path}`),
      stateStore: options.stateStore ?? ({} as BrokerStateStore),
      broker,
      enforceRequesterIdentity: false,
      requesterIdentity: null,
    }),
    res,
  };
}

function jsonReq(body: unknown): IncomingMessage {
  return Readable.from([JSON.stringify(body)]) as IncomingMessage;
}

function ackingStore() {
  let ackCount = 0;
  return {
    get ackCount() {
      return ackCount;
    },
    store: {
      async awaitDurablePersistenceAck() {
        ackCount += 1;
      },
    } as BrokerStateStore,
  };
}

test("exchange route helper handles list/detail/message routes (#841)", async () => {
  const broker = new InMemoryA2ABroker();
  const exchange = makeExchange(broker);

  const list = await routeCtx("GET", "/exchanges", broker);
  assert.equal(list.handled, true);
  assert.equal(list.res.statusCode, 200);
  assert.equal(JSON.parse(list.res.body).items[0].id, exchange.id);

  const detail = await routeCtx("GET", `/exchanges/${exchange.id}`, broker);
  assert.equal(detail.handled, true);
  assert.equal(detail.res.statusCode, 200);
  assert.equal(JSON.parse(detail.res.body).id, exchange.id);

  const messages = await routeCtx("GET", `/exchanges/${exchange.id}/messages`, broker);
  assert.equal(messages.handled, true);
  assert.equal(messages.res.statusCode, 200);
  assert.equal(JSON.parse(messages.res.body).items.length, 2);

  const emptyBooleanQuery = await routeCtx("GET", `/exchanges/${exchange.id}/messages`, broker, new CapturingResponse(), {
    urlPath: `/exchanges/${exchange.id}/messages?includeDescendants=`,
  });
  assert.equal(emptyBooleanQuery.handled, true);
  assert.equal(emptyBooleanQuery.res.statusCode, 200);
});

test("exchange route helper handles POST create/message routes and awaits durable ack (#841)", async () => {
  const broker = new InMemoryA2ABroker();
  const exchangeStore = ackingStore();
  const create = await routeCtx("POST", "/exchanges", broker, new CapturingResponse(), {
    stateStore: exchangeStore.store,
    req: jsonReq({
      requester: { id: "hub-a", kind: "node", role: "hub" },
      target: { id: "worker-a", kind: "node", role: "analyst" },
      message: "initial message",
      intent: "chat",
    }),
  });
  assert.equal(create.handled, true);
  assert.equal(create.res.statusCode, 201);
  assert.equal(exchangeStore.ackCount, 1);
  const exchangeId = JSON.parse(create.res.body).id;

  const messageStore = ackingStore();
  const message = await routeCtx("POST", `/exchanges/${exchangeId}/messages`, broker, new CapturingResponse(), {
    stateStore: messageStore.store,
    req: jsonReq({
      actor: { id: "worker-a", kind: "node", role: "analyst" },
      message: "reply message",
    }),
  });
  assert.equal(message.handled, true);
  assert.equal(message.res.statusCode, 201);
  assert.equal(messageStore.ackCount, 1);
  assert.equal(JSON.parse(message.res.body).exchangeId, exchangeId);
});

test("exchange route helper returns false for non-exchange routes (#841)", async () => {
  const broker = new InMemoryA2ABroker();
  const res = new CapturingResponse();

  const handled = await handleExchangeRoutesIfMatched({
    method: "GET",
    path: "/proposals",
    segments: ["proposals"],
    req: {} as IncomingMessage,
    res: res as unknown as ServerResponse,
    url: new URL("http://broker.test/proposals"),
    stateStore: {} as BrokerStateStore,
    broker,
    enforceRequesterIdentity: false,
    requesterIdentity: null,
  });

  assert.equal(handled, false);
  assert.equal(res.statusCode, undefined);
  assert.equal(res.body, "");
});
