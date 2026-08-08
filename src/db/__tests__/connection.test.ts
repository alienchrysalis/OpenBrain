/**
 * Unit tests for src/db/connection.ts startup retry.
 *
 * The retry exists because of a real, 100% reproducible failure: under a
 * NetworkPolicy engine the pod's IP is not yet in the allowed-sources set for
 * the first second of its life, so the first connection is refused. Connecting
 * once and exiting turned that into a crash on every rollout.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockConnect = vi.fn();

vi.mock("pg", () => ({
  default: {
    Pool: class {
      connect = mockConnect;
      on = vi.fn();
    },
  },
}));

import { initializeDatabase, STARTUP_RETRY_DELAYS_MS } from "../connection.js";

function fakeClient() {
  return {
    query: vi.fn().mockResolvedValue({ rows: [{ count: "0" }] }),
    release: vi.fn(),
  };
}

describe("initializeDatabase startup retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds without retrying when the first connect works", async () => {
    mockConnect.mockResolvedValueOnce(fakeClient());
    await initializeDatabase();
    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

  it("rides out a connection refused on the first attempt", async () => {
    const err = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    mockConnect.mockRejectedValueOnce(err).mockResolvedValueOnce(fakeClient());

    const promise = initializeDatabase();
    await vi.advanceTimersByTimeAsync(STARTUP_RETRY_DELAYS_MS[0] ?? 250);
    await promise;

    expect(mockConnect).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying across several failures", async () => {
    const err = new Error("connect ECONNREFUSED");
    mockConnect
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce(fakeClient());

    const promise = initializeDatabase();
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockConnect).toHaveBeenCalledTimes(4);
  });

  // A database that is genuinely gone must still surface, or the pod reports
  // ready while being permanently unable to serve.
  it("gives up and rethrows once the attempts are exhausted", async () => {
    const err = new Error("connect ECONNREFUSED");
    mockConnect.mockRejectedValue(err);

    const promise = initializeDatabase();
    const assertion = expect(promise).rejects.toThrow("connect ECONNREFUSED");
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;

    expect(mockConnect).toHaveBeenCalledTimes(STARTUP_RETRY_DELAYS_MS.length + 1);
  });

  it("releases the client even if a startup query fails", async () => {
    const client = fakeClient();
    client.query.mockRejectedValueOnce(new Error("boom"));
    mockConnect.mockResolvedValueOnce(client);

    await expect(initializeDatabase()).rejects.toThrow("boom");
    expect(client.release).toHaveBeenCalledTimes(1);
  });
});
