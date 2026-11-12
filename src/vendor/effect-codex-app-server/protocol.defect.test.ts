// HideGPT: not vendored. Covers the "HideGPT:" defect backstops in protocol.ts, which
// T3 Code (https://github.com/pingdotgg/t3code, packages/effect-codex-app-server) lacks.
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stdio from "effect/Stdio";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";

import * as CodexError from "./errors.ts";
import * as CodexProtocol from "./protocol.ts";
import { makeInMemoryStdio } from "./_internal/stdio.ts";

const encodeUnknownJsonString = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();
const encodeJsonl = (value: unknown) => encoder.encode(`${encodeUnknownJsonString(value)}\n`);
const settle = Effect.yieldNow.pipe(Effect.repeat({ times: 100 }));

it.layer(NodeServices.layer)("effect-codex-app-server protocol: defects", (it) => {
  // The reader and writer are forked and never joined, so without the backstop a defect
  // ends them silently: no `onTermination`, and the session looks connected forever.
  it.effect("a defect in the reader ends the protocol and fails requests in flight", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const bug = new Error("a bug applying a notification");
      let notifications = 0;
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onNotification: () =>
          Effect.suspend(() => {
            notifications += 1;
            return Effect.die(bug);
          }),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });

      const pending = yield* transport.request("thread/list", {}).pipe(Effect.forkScoped);
      yield* Queue.take(output);

      yield* Queue.offer(input, encodeJsonl({ method: "thread/started", params: {} }));
      // The reply to the request above; a dead reader never reads it.
      yield* Queue.offer(input, encodeJsonl({ id: 1, result: {} }));
      yield* settle;

      assert.equal(notifications, 1);
      assert.isTrue(yield* Deferred.isDone(terminated), "the protocol never reported its end");
      const failure = yield* Deferred.await(terminated);
      assert.instanceOf(failure, CodexError.CodexAppServerTransportError);
      assert.equal(failure.operation, "read-input-stream");
      assert.strictEqual(failure.cause, bug);
      assert.strictEqual(yield* Fiber.join(pending).pipe(Effect.flip), failure);
    }),
  );

  it.effect("a defect in the writer ends the protocol", () =>
    Effect.gen(function* () {
      const { stdio: baseStdio } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      const bug = new Error("a bug writing to stdin");
      const transport = yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio: Stdio.make({
          args: baseStdio.args,
          stdin: baseStdio.stdin,
          stdout: () => Sink.forEach(() => Effect.die(bug)),
          stderr: baseStdio.stderr,
        }),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });

      const pending = yield* transport.request("thread/read", {}).pipe(Effect.forkScoped);
      yield* settle;

      assert.isTrue(yield* Deferred.isDone(terminated), "the protocol never reported its end");
      const failure = yield* Deferred.await(terminated);
      assert.instanceOf(failure, CodexError.CodexAppServerTransportError);
      assert.equal(failure.operation, "write-output-stream");
      assert.strictEqual(failure.cause, bug);
      assert.strictEqual(yield* Fiber.join(pending).pipe(Effect.flip), failure);
    }),
  );

  it.effect("a defect in a request handler answers with an internal error", () =>
    Effect.gen(function* () {
      const { stdio, input, output } = yield* makeInMemoryStdio();
      const terminated = yield* Deferred.make<CodexError.CodexAppServerError>();
      yield* CodexProtocol.makeCodexAppServerPatchedProtocol({
        stdio,
        onRequest: () => Effect.die(new Error("a bug answering a request")),
        onTermination: (error) => Deferred.succeed(terminated, error).pipe(Effect.asVoid),
      });

      yield* Queue.offer(input, encodeJsonl({ id: 7, method: "item/tool/requestUserInput" }));
      yield* settle;

      const answer = yield* Queue.poll(output);
      assert.isTrue(Option.isSome(answer), "Codex never got an answer");
      assert.deepStrictEqual(yield* decodeJson(Option.getOrThrow(answer).trim()), {
        id: 7,
        error: {
          code: -32603,
          message:
            "Codex App Server request handler failed for method 'item/tool/requestUserInput'",
        },
      });
      assert.isFalse(yield* Deferred.isDone(terminated), "one bad handler ended the protocol");
    }),
  );
});
